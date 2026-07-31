export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { makeCaptureHandler } from '@domain/api/capture-handler.js';
import { makeBlobStore } from '@domain/blob/factory.js';
import { StubExtractor } from '@domain/intake/extractor.js';
import { AnthropicExtractor } from '@domain/intake/anthropic-extractor.js';
import { GeminiExtractor } from '@domain/intake/gemini-extractor.js';
import { OllamaExtractor } from '@domain/intake/ollama-extractor.js';
import { stubExtractorAllowed } from '@domain/intake/stub-extractor-allowed.js';
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
// Representative LR chart defaults — accountant to confirm. Input VAT is 5722
// (5721 is Output VAT per seed.ts / vat-compute.ts; posting captured purchase
// VAT to 5721 would corrupt the VAT declaration). Matches /api/bills.
const TEMPLATE: PostingTemplate = { expenseAccount: '7710', vatInputAccount: '5722', payablesAccount: '5310' };

function selectExtractor(): DocumentExtractor {
  if (process.env.ANTHROPIC_API_KEY) return new AnthropicExtractor();
  if (process.env.GEMINI_API_KEY) return new GeminiExtractor();
  if (process.env.OLLAMA_HOST) return new OllamaExtractor();
  if (!stubExtractorAllowed(process.env)) {
    throw new Error(
      'No AI extraction key configured (ANTHROPIC_API_KEY/GEMINI_API_KEY/OLLAMA_HOST) and the ' +
        'stub extractor is not allowed in production — set INTAKE_ALLOW_STUB_EXTRACTOR=1 to override.',
    );
  }
  return new StubExtractor(CANNED);
}

// Defer handler construction to request time, not module evaluation time. selectExtractor() throws
// when no AI key is configured and the stub extractor is not allowed in production; this must fail
// on upload (when running in production), not during `next build`'s page-data collection phase
// (where no AI key exists). Making it lazy ensures the build succeeds while the guard still fires
// at request time.
let handler: ReturnType<typeof makeCaptureHandler> | undefined;
function getHandler(): ReturnType<typeof makeCaptureHandler> {
  handler ??= makeCaptureHandler({
    blob: makeBlobStore(),
    extractor: selectExtractor(),
    resolveTemplate: () => TEMPLATE,
  });
  return handler;
}

export async function POST(req: Request) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; bytesBase64?: string; mime?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const res = await getHandler()({ token, clientCompanyId: body.clientCompanyId, body, atUnixSeconds: nowUnix() });
  return NextResponse.json(res.body, { status: res.status });
}
