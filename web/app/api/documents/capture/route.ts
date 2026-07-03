export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { makeCaptureHandler } from '@domain/api/capture-handler.js';
import { LocalBlobStore } from '@domain/blob/blob-store.js';
import { StubExtractor } from '@domain/intake/extractor.js';
import { AnthropicExtractor } from '@domain/intake/anthropic-extractor.js';
import { GeminiExtractor } from '@domain/intake/gemini-extractor.js';
import { OllamaExtractor } from '@domain/intake/ollama-extractor.js';
import type { DocumentExtractor } from '@domain/intake/extractor.js';
import type { PostingTemplate } from '@domain/intake/map-posting.js';

const CANNED = {
  extractedData: {
    supplierName: 'SIA Piegādātājs', supplierRegNo: '40100000000',
    date: '2026-03-10', currency: 'EUR',
    lineItems: [{ description: 'Prece', net: '100.00', vatRate: 21, vat: '21.00' }],
    vatTotal: '21.00', netTotal: '100.00', grandTotal: '121.00',
  },
  confidence: { supplierName: 0.98, grandTotal: 0.95 },
};
const TEMPLATE: PostingTemplate = { expenseAccount: '7710', vatInputAccount: '5721', payablesAccount: '5310' };

function selectExtractor(): DocumentExtractor {
  if (process.env.ANTHROPIC_API_KEY) return new AnthropicExtractor();
  if (process.env.GEMINI_API_KEY) return new GeminiExtractor();
  if (process.env.OLLAMA_HOST) return new OllamaExtractor();
  return new StubExtractor(CANNED);
}

const handler = makeCaptureHandler({
  blob: new LocalBlobStore(process.env.BLOB_DIR ?? '.blob-store'),
  extractor: selectExtractor(),
  resolveTemplate: () => TEMPLATE,
});
export async function POST(req: Request) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; bytesBase64?: string; mime?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const res = await handler({ token, clientCompanyId: body.clientCompanyId, body, atUnixSeconds: nowUnix() });
  return NextResponse.json(res.body, { status: res.status });
}
