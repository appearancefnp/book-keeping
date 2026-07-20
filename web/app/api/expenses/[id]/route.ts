export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { deleteDraft } from '@domain/expenses/claims.js';
import { submitClaim } from '@domain/expenses/submit.js';
import { settleClaim } from '@domain/expenses/reimburse.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';
import { isValidIsoDate } from '@/app/lib/date';

// Representative LR chart defaults — accountant to confirm. Matches src/expenses/reimburse.test.ts
// and the /api/receivables/[id] BANK_ACCOUNT convention.
const EXPENSE_SETTLEMENT_ACCOUNT = process.env.EXPENSE_SETTLEMENT_ACCOUNT ?? '5610';
const EXPENSE_VAT_INPUT_ACCOUNT = process.env.EXPENSE_VAT_INPUT_ACCOUNT ?? '5722';
const BANK_ACCOUNT = process.env.BANK_ACCOUNT ?? '2620';

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await context.params;

  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string;
    action?: 'submit' | 'settle' | 'delete';
    paidDate?: string;
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (body.action === 'settle' && (!body.paidDate || !isValidIsoDate(body.paidDate))) {
    return NextResponse.json({ error: 'paidDate must be a valid YYYY-MM-DD date' }, { status: 400 });
  }

  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    // submit/delete are self-scoped writes (any role may act on their own claim); settle pays
    // real money out, so it's gated to firm-side roles only.
    assertRoleAllowed(ctx.actorRole, body.action === 'settle' ? 'expenses.reimburse' : 'expenses.write');
    const result = await withTenant(ctx, async (tx) => {
      if (body.action === 'submit') {
        return submitClaim(tx, ctx, id, {
          settlementAccount: EXPENSE_SETTLEMENT_ACCOUNT, vatInputAccount: EXPENSE_VAT_INPUT_ACCOUNT,
        });
      }
      if (body.action === 'settle') {
        return settleClaim(tx, ctx, {
          claimId: id, paidDate: body.paidDate!, method: 'manual',
          bankAccount: BANK_ACCOUNT, settlementAccount: EXPENSE_SETTLEMENT_ACCOUNT,
        });
      }
      if (body.action === 'delete') {
        await deleteDraft(tx, ctx, id);
        return { deleted: true };
      }
      throw new Error('unknown action');
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
