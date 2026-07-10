export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { setInvoiceLogo } from '@domain/einvoice/invoice-profile.js';
import { LocalBlobStore } from '@domain/blob/blob-store.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

const blob = new LocalBlobStore(process.env.BLOB_DIR ?? '.blob-store');
const MAX_BYTES = 1_000_000;

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; bytesBase64?: string; mime?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.bytesBase64 || !body.mime) return NextResponse.json({ error: 'missing bytesBase64 or mime' }, { status: 400 });
  if (!body.mime.startsWith('image/')) return NextResponse.json({ error: 'logo must be an image' }, { status: 400 });
  const bytes = Buffer.from(body.bytesBase64, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_BYTES) return NextResponse.json({ error: 'invalid logo size' }, { status: 400 });

  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'invoice_profile.write');
    const key = `invoice-logo/${ctx.clientCompanyId}`;
    await blob.put(key, bytes, body.mime);
    await withTenant(ctx, (tx) => setInvoiceLogo(tx, ctx, key));
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
