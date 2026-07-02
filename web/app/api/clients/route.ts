export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { appPool } from '@domain/db/pool.js';
import { validateSession } from '@domain/auth/sessions.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

export async function GET() {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const session = await validateSession(token, nowUnix());
  if (!session) return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
  const res = await appPool.query(
    `SELECT c.id, c.name, c.reg_no AS "regNo", c.base_currency AS "baseCurrency"
     FROM user_client_assignments a
     JOIN client_companies c ON c.id = a.client_company_id
     WHERE a.user_id = $1 AND c.firm_id = $2
     ORDER BY c.name`,
    [session.userId, session.firmId],
  );
  return NextResponse.json({ clients: res.rows, role: session.role }, { status: 200 });
}
