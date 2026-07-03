import type { ChatModel, ChatModelResponse, ChatTurn } from './chat-model.js';

/**
 * Real chat adapter backed by the Anthropic Messages API.
 * Integration-only: requires ANTHROPIC_API_KEY.
 * Not unit-tested (all assistant tests use StubChatModel).
 *
 * Model ID and API details sourced from the claude-api skill (2026-07-03):
 *   - default model: claude-opus-4-8
 *   - anthropic-version: 2023-06-01
 *   - tools schema: {name, description, input_schema: {type:'object', properties:{}, required:[]}}
 *   - tool_use response block: {type:'tool_use', name, input: Record<string,unknown>}
 *   - zero-retention: available on the Anthropic API (no ZDR restriction on Opus 4.8)
 */
export class AnthropicChatModel implements ChatModel {
  constructor(
    private readonly apiKey = process.env['ANTHROPIC_API_KEY'] ?? '',
    private readonly model = process.env['ASSISTANT_MODEL'] ?? 'claude-opus-4-8',
  ) {}

  async respond(
    history: ChatTurn[],
    tools: { name: string; description: string }[],
  ): Promise<ChatModelResponse> {
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

    const messages = history.map((t) => ({
      role: t.role === 'tool' ? 'user' : t.role,
      content: t.content,
    }));

    const anthropicTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    }));

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 4096,
      messages,
    };
    if (anthropicTools.length > 0) {
      body['tools'] = anthropicTools;
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);

    const json = (await res.json()) as {
      content: Array<
        | { type: 'tool_use'; name: string; input: Record<string, unknown> }
        | { type: 'text'; text: string }
        | { type: string }
      >;
    };

    // Check for a tool_use block first
    for (const block of json.content) {
      if (block.type === 'tool_use') {
        const tb = block as { type: 'tool_use'; name: string; input: Record<string, unknown> };
        return { kind: 'tool_use', toolName: tb.name, toolArgs: tb.input };
      }
    }

    // Fall back to the first text block
    for (const block of json.content) {
      if (block.type === 'text') {
        const tb = block as { type: 'text'; text: string };
        return { kind: 'final', text: tb.text };
      }
    }

    return { kind: 'final', text: '' };
  }
}
