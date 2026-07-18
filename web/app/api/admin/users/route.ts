export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { validateSession } from '@domain/auth/sessions.js';
import { createUser, listUsersForFirm } from '@domain/auth/users.js';
import { assignUserToClient } from '@domain/auth/context.js';
import { createInvite } from '@domain/auth/invites.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';
import { randomBytes } from 'node:crypto';

export async function GET() {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const session = await validateSession(token, nowUnix());
  if (!session) return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });

  if (session.role !== 'accountant' && session.role !== 'firm_admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const users = await listUsersForFirm(session.firmId);
  return NextResponse.json({ users }, { status: 200 });
}

export async function POST(req: Request) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const session = await validateSession(token, nowUnix());
  if (!session) return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
  try {
    assertRoleAllowed(session.role, 'users.write');
    const body = (await req.json().catch(() => ({}))) as {
      email?: string; role?: string; language?: string; clientCompanyIds?: string[]; userId?: string;
    };

    let userId = body.userId;
    if (!userId) {
      if (!body.email || !body.role) return NextResponse.json({ error: 'email and role are required' }, { status: 400 });
      // Placeholder password nobody knows; acceptInvite overwrites it.
      const { id } = await createUser({
        firmId: session.firmId, email: body.email, password: randomBytes(24).toString('hex'),
        role: body.role as never, language: body.language,
      });
      userId = id;
      for (const clientId of body.clientCompanyIds ?? []) await assignUserToClient(userId, clientId);
    } else {
      // Re-invite may only target a user in the admin's own firm.
      const target = (await listUsersForFirm(session.firmId)).find((u) => u.id === userId);
      if (!target) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }

    const { token: inviteToken, expiresAtIso } = await createInvite(userId, session.userId, nowUnix());
    return NextResponse.json({ inviteUrl: `/invite/${inviteToken}`, expiresAt: expiresAtIso }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
