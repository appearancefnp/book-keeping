import { withTenant } from '../db/pool.js';
import { authed } from '../api/handlers.js';
import type { AuthedRequest, ApiResponse } from '../api/types.js';
import type { ChatModel } from './chat-model.js';
import { buildAssistantTools, type AssistantConfig } from './tools.js';
import { runAssistant } from './assistant.js';

export function makeAssistantHandler(deps: { model: ChatModel; config: AssistantConfig }): (req: AuthedRequest) => Promise<ApiResponse> {
  const tools = buildAssistantTools(deps.config);
  return (req) => authed(req, async (ctx) => {
    const body = (req.body ?? {}) as { question?: string; threadId?: string };
    if (!body.question) return { status: 400, body: { error: 'question is required' } };
    const out = await withTenant(ctx, (tx) => runAssistant(tx, ctx, { question: body.question!, threadId: body.threadId, model: deps.model, tools }));
    return { status: 200, body: out };
  });
}
