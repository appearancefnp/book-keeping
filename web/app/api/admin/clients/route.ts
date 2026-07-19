export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse, NextRequest } from 'next/server';
import { validateSession } from '@domain/auth/sessions.js';
import { listClientCompaniesForFirm } from '@domain/tenancy/firms.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { createClientFromTemplate } from '@domain/onboarding/templates.js';
import { errorToStatus, isRoleAllowed } from '@/app/lib/authz';

export async function GET() {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const session = await validateSession(token, nowUnix());
  if (!session) return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });

  if (session.role !== 'accountant' && session.role !== 'firm_admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const clients = await listClientCompaniesForFirm(session.firmId);
  return NextResponse.json({ clients }, { status: 200 });
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const session = await validateSession(token, nowUnix());
  if (!session) return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
  if (!isRoleAllowed(session.role, 'clients.write')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    name?: string; regNo?: string; baseCurrency?: string; templateId?: string | null;
  };
  if (!body.name?.trim()) return NextResponse.json({ error: 'missing name' }, { status: 400 });
  if (!body.regNo?.trim()) return NextResponse.json({ error: 'missing regNo' }, { status: 400 });
  const currency = (body.baseCurrency ?? 'EUR').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return NextResponse.json({ error: 'invalid baseCurrency' }, { status: 400 });

  try {
    const client = await createClientFromTemplate(
      session.firmId,
      { name: body.name.trim(), regNo: body.regNo.trim(), baseCurrency: currency },
      body.templateId ?? null,
      session.userId,
    );
    return NextResponse.json({ client }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
