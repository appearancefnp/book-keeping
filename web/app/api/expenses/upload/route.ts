export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { storeExpenseReceipt } from '@domain/expenses/upload.js';
import { makeBlobStore } from '@domain/blob/factory.js';
import { StubExtractor } from '@domain/intake/extractor.js';
import { AnthropicExtractor } from '@domain/intake/anthropic-extractor.js';
import { GeminiExtractor } from '@domain/intake/gemini-extractor.js';
import { OllamaExtractor } from '@domain/intake/ollama-extractor.js';
import type { DocumentExtractor } from '@domain/intake/extractor.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

// Same canned shape as /api/documents/capture — deterministic when no AI key is configured.
const CANNED = {
  extractedData: {
    supplierName: 'SIA Piegādātājs', supplierRegNo: '40100000000',
    date: '2026-03-10', currency: 'EUR',
    lineItems: [{ description: 'Prece', net: '100.00', vatRate: 21, vat: '21.00' }],
    vatTotal: '21.00', netTotal: '100.00', grandTotal: '121.00',
  },
  confidence: { supplierName: 0.98, grandTotal: 0.95 },
};

function selectExtractor(): DocumentExtractor {
  if (process.env.ANTHROPIC_API_KEY) return new AnthropicExtractor();
  if (process.env.GEMINI_API_KEY) return new GeminiExtractor();
  if (process.env.OLLAMA_HOST) return new OllamaExtractor();
  return new StubExtractor(CANNED);
}

const blobStore = makeBlobStore();
const extractor = selectExtractor();

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: 'expected multipart/form-data' }, { status: 400 });
  const clientCompanyId = form.get('clientCompanyId');
  const file = form.get('file');
  if (typeof clientCompanyId !== 'string' || !clientCompanyId) {
    return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  }
  if (!(file instanceof File)) return NextResponse.json({ error: 'missing file' }, { status: 400 });

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'expenses.write');
    const bytes = Buffer.from(await file.arrayBuffer());
    const result = await withTenant(ctx, (tx) => storeExpenseReceipt(tx, ctx, {
      bytes, mimeType: file.type || 'application/octet-stream', filename: file.name || 'receipt',
      blobStore, extractor,
    }));
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
