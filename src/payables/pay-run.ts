import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { getBill } from './bills.js';
import { settleBill } from './settlement.js';
import { generateSepaCreditTransfer } from '../banking/sepa.js';
import { fromCents } from '../db/money.js';
import { appendAudit } from '../audit/audit.js';

export interface PayRunAccounts { payablesAccount: string; bankClearingAccount: string; }

export async function createPayRun(
  tx: PoolClient, ctx: TenantContext,
  args: { billIds: string[]; paidDate: string; accounts: PayRunAccounts },
): Promise<{ payRunId: string; pain001Xml: string; totalCents: string }> {
  if (!args.billIds.length) throw new Error('Pay run needs at least one bill');

  // 1. Validate everything BEFORE any posting.
  const plan: { billId: string; amountCents: bigint; iban: string; reference: string }[] = [];
  for (const billId of args.billIds) {
    const bill = await getBill(tx, ctx, billId);
    if (bill.status !== 'open' && bill.status !== 'partially_paid') {
      throw new Error(`Bill ${bill.billNumber} is not payable (status=${bill.status})`);
    }
    const outstanding = BigInt(bill.outstandingCents);
    if (outstanding <= 0n) throw new Error(`Bill ${bill.billNumber} has nothing outstanding`);
    const v = await tx.query(`SELECT iban FROM parties WHERE id = $1 AND client_company_id = $2`, [bill.vendorPartyId, ctx.clientCompanyId]);
    const iban = v.rows[0]?.iban as string | null;
    if (!iban) throw new Error(`Vendor for bill ${bill.billNumber} has no IBAN`);
    plan.push({ billId, amountCents: outstanding, iban, reference: bill.billNumber });
  }

  const total = plan.reduce((a, p) => a + p.amountCents, 0n);

  // 2. Create the pay run row, then settle each bill against bank-clearing.
  const pr = await tx.query(
    `INSERT INTO pay_runs(client_company_id, created_by, total_cents) VALUES ($1,$2,$3) RETURNING id`,
    [ctx.clientCompanyId, ctx.actorId, total.toString()],
  );
  const payRunId = pr.rows[0].id as string;

  for (const p of plan) {
    await settleBill(tx, ctx, {
      billId: p.billId, amountCents: p.amountCents.toString(), paidDate: args.paidDate, method: 'pay_run',
      payablesAccount: args.accounts.payablesAccount, creditAccount: args.accounts.bankClearingAccount, payRunId,
    });
  }

  // 3. Build the SEPA file and store it.
  const pain001Xml = generateSepaCreditTransfer(plan.map((p) => ({ iban: p.iban, amount: fromCents(p.amountCents), reference: p.reference })));
  await tx.query(`UPDATE pay_runs SET pain001_xml = $1 WHERE id = $2 AND client_company_id = $3`, [pain001Xml, payRunId, ctx.clientCompanyId]);

  await appendAudit(tx, ctx, { action: 'create', entityType: 'pay_run', entityId: payRunId, before: null, after: { totalCents: total.toString(), bills: plan.length } });
  return { payRunId, pain001Xml, totalCents: total.toString() };
}

export async function listPayRuns(
  tx: PoolClient, ctx: TenantContext,
): Promise<{ id: string; totalCents: string; createdAt: string }[]> {
  const res = await tx.query(
    `SELECT id, total_cents::text AS "totalCents", to_char(created_at,'YYYY-MM-DD') AS "createdAt"
     FROM pay_runs WHERE client_company_id = $1 ORDER BY created_at DESC`,
    [ctx.clientCompanyId],
  );
  return res.rows;
}

export async function getPayRunXml(tx: PoolClient, ctx: TenantContext, id: string): Promise<string> {
  const res = await tx.query(`SELECT pain001_xml AS xml FROM pay_runs WHERE id = $1 AND client_company_id = $2`, [id, ctx.clientCompanyId]);
  if (!res.rowCount) throw new Error(`Pay run not found: ${id}`);
  return res.rows[0].xml as string;
}
