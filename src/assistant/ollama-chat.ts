import type { ChatModel, ChatModelResponse, ChatTurn } from './chat-model.js';

/**
 * Free, self-hosted, PRIVATE chat adapter backed by a local Ollama model.
 * Requires Ollama running locally: ollama serve
 *
 * Default model: qwen2.5 — supports tool calling and is capable for assistant tasks.
 * Zero cost, no data leaves the machine (GDPR-friendly).
 *
 * Integration-only (needs a running Ollama); not unit-tested. All assistant tests
 * use StubChatModel.
 */
export class OllamaChatModel implements ChatModel {
  constructor(
    private readonly host = process.env['OLLAMA_HOST'] ?? 'http://localhost:11434',
    private readonly model = process.env['OLLAMA_MODEL'] ?? 'qwen2.5',
  ) {}

  async respond(
    history: ChatTurn[],
    tools: { name: string; description: string }[],
  ): Promise<ChatModelResponse> {
    const messages = history.map((t) => ({
      role: t.role === 'tool' ? 'tool' : t.role,
      content: t.content,
      ...(t.role === 'tool' && t.toolName ? { name: t.toolName } : {}),
    }));

    const ollamaTools = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: { type: 'object', properties: {} },
      },
    }));

    const body = {
      model: this.model,
      messages,
      tools: ollamaTools.length > 0 ? ollamaTools : undefined,
      stream: false,
    };

    const res = await fetch(`${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`);

    const json = (await res.json()) as {
      message?: {
        content?: string;
        tool_calls?: Array<{
          function?: { name?: string; arguments?: Record<string, unknown> };
        }>;
      };
    };

    const msg = json.message;
    const firstToolCall = msg?.tool_calls?.[0];

    if (firstToolCall?.function?.name) {
      return {
        kind: 'tool_use',
        toolName: firstToolCall.function.name,
        toolArgs: firstToolCall.function.arguments ?? {},
      };
    }

    return { kind: 'final', text: msg?.content ?? '' };
  }
}
