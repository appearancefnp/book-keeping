export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { makeAssistantHandler } from '@domain/assistant/handler.js';
import { StubChatModel } from '@domain/assistant/chat-model.js';
import { AnthropicChatModel } from '@domain/assistant/anthropic-chat.js';

const config = { outputVatAccount: '5721', inputVatAccount: '5722', receivablesAccount: '2310' };

const model = process.env.ANTHROPIC_API_KEY
  ? new AnthropicChatModel()
  : new StubChatModel([{ kind: 'final', text: 'Demo assistant: connect a model (ANTHROPIC_API_KEY / Ollama) to ask over your books.' }]);

const handler = makeAssistantHandler({ model, config });

export async function POST(req: Request) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; question?: string; threadId?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const res = await handler({ token, clientCompanyId: body.clientCompanyId, body, atUnixSeconds: nowUnix() });
  return NextResponse.json(res.body, { status: res.status });
}
