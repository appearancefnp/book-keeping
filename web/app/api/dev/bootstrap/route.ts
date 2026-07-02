export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { runMigrations } from '@domain/db/migrate.js';
import { createFirm, createClientCompany } from '@domain/tenancy/firms.js';
import { createUser, findUserByEmail } from '@domain/auth/users.js';
import { assignUserToClient, resolveTenantContext } from '@domain/auth/context.js';
import { login } from '@domain/auth/sessions.js';
import { totpCodeFor } from '@domain/auth/totp.js';
import { withTenant } from '@domain/db/pool.js';
import { createAccount } from '@domain/ledger/accounts.js';
import { openPeriod } from '@domain/ledger/periods.js';
import { createProposal } from '@domain/proposals/proposals.js';
import { SESSION_COOKIE, nowUnix } from '@/app/lib/session';

const DEV_EMAIL = 'accountant@demo.lv';
const DEV_PASSWORD = 'demo-password-123';

export async function GET(req: Request) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'not available in production' }, { status: 403 });
  }

  await runMigrations();

  // Idempotency: if user already exists, just re-login.
  let existing = await findUserByEmail(DEV_EMAIL);
  if (!existing) {
    const firm = await createFirm('Demo Grāmatvedības Birojs');
    const user = await createUser({ firmId: firm.id, email: DEV_EMAIL, password: DEV_PASSWORD, role: 'accountant', language: 'lv' });
    const clientA = await createClientCompany(firm.id, { name: 'Ozola SIA', regNo: '40000000001', baseCurrency: 'EUR' });
    const clientB = await createClientCompany(firm.id, { name: 'Bērziņa IK', regNo: '40000000002', baseCurrency: 'EUR' });
    await assignUserToClient(user.id, clientA.id);
    await assignUserToClient(user.id, clientB.id);

    // Seed pending proposals for clientA.
    const ctxA = await resolveTenantContext(
      (await login(DEV_EMAIL, DEV_PASSWORD, totpCodeFor(user.totpSecret, nowUnix()), nowUnix())).sessionToken,
      clientA.id, nowUnix(),
    );
    await withTenant(ctxA, async (tx) => {
      await createAccount(tx, ctxA, { code: '2310', name: 'Norēķini ar piegādātājiem', type: 'liability' });
      await createAccount(tx, ctxA, { code: '6110', name: 'Preču iegāde', type: 'expense' });
      await openPeriod(tx, ctxA, { year: 2026, month: 7 });
      await createProposal(tx, ctxA, {
        type: 'posting',
        status: 'pending_approval',
        payload: {
          date: '2026-07-01', currency: 'EUR', memo: 'Piegādātāja rēķins Nr. 2026-114 (biroja preces)',
          lines: [
            { accountCode: '6110', debit: '210.00', credit: '0.00' },
            { accountCode: '2310', debit: '0.00', credit: '210.00' },
          ],
        },
        rationale: {
          ruleRef: 'LV VAT §142 / kontu plāns 6110↔2310',
          computation: 'Rēķina kopsumma 210.00 EUR → debets 6110 (izdevumi), kredīts 2310 (kreditori). Bilance: 210.00 = 210.00.',
          sourceRefs: { documentId: null, invoiceNo: '2026-114', confidence: 0.94 },
        },
      });
      await createProposal(tx, ctxA, {
        type: 'posting',
        status: 'pending_approval',
        payload: {
          date: '2026-07-02', currency: 'EUR', memo: 'Piegādātāja rēķins Nr. 2026-118 (IT pakalpojumi)',
          lines: [
            { accountCode: '6110', debit: '89.50', credit: '0.00' },
            { accountCode: '2310', debit: '0.00', credit: '89.50' },
          ],
        },
        rationale: {
          ruleRef: 'LV kontu plāns 6110↔2310',
          computation: 'Rēķina summa 89.50 EUR → debets 6110, kredīts 2310. Bilance: 89.50 = 89.50.',
          sourceRefs: { documentId: null, invoiceNo: '2026-118', confidence: 0.71, flags: ['low_confidence'] },
        },
      });
    });
    existing = await findUserByEmail(DEV_EMAIL);
  }

  // Login and set cookie.
  const secret = existing!.totpSecret;
  const { sessionToken } = await login(DEV_EMAIL, DEV_PASSWORD, totpCodeFor(secret, nowUnix()), nowUnix());
  const store = await cookies();
  store.set(SESSION_COOKIE, sessionToken, {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 12,
  });

  return NextResponse.redirect(new URL('/', req.url));
}
