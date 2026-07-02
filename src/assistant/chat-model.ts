export interface ChatTurn { role: 'user' | 'assistant' | 'tool'; content: string; toolName?: string }
export type ChatModelResponse =
  | { kind: 'tool_use'; toolName: string; toolArgs: Record<string, unknown> }
  | { kind: 'final'; text: string };

export interface ChatModel {
  respond(history: ChatTurn[], tools: { name: string; description: string }[]): Promise<ChatModelResponse>;
}

/** Deterministic model for tests: returns each scripted response in order, then a safe final. */
export class StubChatModel implements ChatModel {
  private i = 0;
  constructor(private readonly script: ChatModelResponse[]) {}
  async respond(_history: ChatTurn[], _tools: { name: string; description: string }[]): Promise<ChatModelResponse> {
    const next = this.script[this.i];
    this.i += 1;
    return next ?? { kind: 'final', text: 'I can only answer from your bookkeeping data.' };
  }
}
