import type { ChatModel, ChatModelResponse, ChatTurn } from './chat-model.js';

/**
 * Free-tier hosted chat adapter backed by Google Gemini.
 * Gemini's free tier is generous (no card required) and needs zero local setup.
 *
 * TRADE-OFF: data leaves your machine to Google, and the free tier's data-use
 * policy is NOT zero-retention. For GDPR-sensitive client data prefer
 * OllamaChatModel (local) or a paid zero-retention tier.
 *
 * Integration-only (needs GEMINI_API_KEY); not unit-tested. All assistant tests
 * use StubChatModel.
 */
export class GeminiChatModel implements ChatModel {
  constructor(
    private readonly apiKey = process.env['GEMINI_API_KEY'] ?? '',
    private readonly model = process.env['GEMINI_MODEL'] ?? 'gemini-2.0-flash',
  ) {}

  async respond(
    history: ChatTurn[],
    tools: { name: string; description: string }[],
  ): Promise<ChatModelResponse> {
    if (!this.apiKey) throw new Error('GEMINI_API_KEY is not set');

    // Map ChatTurn roles to Gemini roles (user/model; tool results go as user parts)
    const contents = history.map((t) => ({
      role: t.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: t.content }],
    }));

    const functionDeclarations = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: { type: 'object', properties: {} },
    }));

    const body: Record<string, unknown> = { contents };
    if (functionDeclarations.length > 0) {
      body['tools'] = [{ functionDeclarations }];
    }

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    );

    if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);

    const json = (await res.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string;
            functionCall?: { name?: string; args?: Record<string, unknown> };
          }>;
        };
      }>;
    };

    const parts = json.candidates?.[0]?.content?.parts ?? [];

    // Check for a function call part first
    for (const part of parts) {
      if (part.functionCall?.name) {
        return {
          kind: 'tool_use',
          toolName: part.functionCall.name,
          toolArgs: part.functionCall.args ?? {},
        };
      }
    }

    // Fall back to text
    const text = parts.find((p) => typeof p.text === 'string')?.text ?? '';
    return { kind: 'final', text };
  }
}
