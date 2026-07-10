import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { createProposal, type Rationale } from '../proposals/proposals.js';
import { rejectProposal } from '../proposals/lifecycle.js';
import type { NewJournalEntry } from '../ledger/posting.js';
import { toCents, fromCents, sumCents } from '../db/money.js';
import { appendAudit } from '../audit/audit.js';

export interface NewBillLine { description: string; expenseAccount: string; net: string; vatRate: number; vat: string; }
export interface NewBill {
  vendorPartyId: string; billNumber: string; issueDate: string; dueDate: string; currency: string;
  lines: NewBillLine[]; source?: 'manual' | 'ocr' | 'peppol'; documentId?: string | null; einvoiceId?: string | null;
}
export interface BillAccounts { vatInputAccount: string; payablesAccount: string; }

export interface BillRow {
  id: string; vendorPartyId: string; vendorName: string; billNumber: string; issueDate: string; dueDate: string;
  currency: string; netCents: string; vatCents: string; grandTotalCents: string; amountPaidCents: string;
  outstandingCents: string; status: string; source: string; postingProposalId: string | null; journalEntryId: string | null;
}
export interface BillDetail extends BillRow {
  lines: { lineNo: number; description: string; expenseAccount: string; netCents: string; vatRate: string; vatCents: string }[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const newBillSchema = z.object({
  vendorPartyId: z.string().uuid(),
  billNumber: z.string().min(1),
  issueDate: z.string().regex(DATE),
  dueDate: z.string().regex(DATE),
  currency: z.string().length(3),
  lines: z.array(z.object({
    description: z.string().min(1),
    expenseAccount: z.string().min(1),
    net: z.string().regex(/^-?\d+(\.\d{1,2})?$/),
    vatRate: z.number(),
    vat: z.string().regex(/^-?\d+(\.\d{1,2})?$/),
  })).min(1),
  source: z.enum(['manual', 'ocr', 'peppol']).optional(),
  documentId: z.string().uuid().nullable().optional(),
  einvoiceId: z.string().uuid().nullable().optional(),
});

const ROW_COLS = `
  b.id, b.vendor_party_id AS "vendorPartyId", p.name AS "vendorName", b.bill_number AS "billNumber",
  to_char(b.issue_date,'YYYY-MM-DD') AS "issueDate", to_char(b.due_date,'YYYY-MM-DD') AS "dueDate",
  b.currency, b.net_cents::text AS "netCents", b.vat_cents::text AS "vatCents",
  b.grand_total_cents::text AS "grandTotalCents", b.amount_paid_cents::text AS "amountPaidCents",
  (b.grand_total_cents - b.amount_paid_cents)::text AS "outstandingCents",
  b.status, b.source, b.posting_proposal_id AS "postingProposalId", b.journal_entry_id AS "journalEntryId"`;

/** DR each line's expense account (net), DR VAT-input (Σvat, if > 0), CR payables (grand). */
export function buildBillEntry(bill: NewBill, accounts: BillAccounts): NewJournalEntry {
  const vat = sumCents(bill.lines.map((l) => l.vat));
  const grand = sumCents(bill.lines.map((l) => l.net)) + vat;
  const lines = bill.lines.map((l) => ({ accountCode: l.expenseAccount, debit: l.net, credit: '0', description: l.description }));
  if (vat > 0n) lines.push({ accountCode: accounts.vatInputAccount, debit: fromCents(vat), credit: '0', description: 'VAT input' });
  lines.push({ accountCode: accounts.payablesAccount, debit: '0', credit: fromCents(grand), description: 'Payable' });
  return { date: bill.issueDate, memo: `Bill ${bill.billNumber}`, currency: bill.currency, lines };
}

export async function createBill(
  tx: PoolClient, ctx: TenantContext, input: NewBill, accounts: BillAccounts,
): Promise<{ billId: string; proposalId: string }> {
  const bill = newBillSchema.parse(input);
  const netCents = sumCents(bill.lines.map((l) => l.net));
  const vatCents = sumCents(bill.lines.map((l) => l.vat));
  const grandCents = netCents + vatCents;
  const source = bill.source ?? 'manual';

  const billRes = await tx.query(
    `INSERT INTO bills(client_company_id, vendor_party_id, bill_number, issue_date, due_date, currency,
       net_cents, vat_cents, grand_total_cents, status, source, document_id, einvoice_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'awaiting_approval',$10,$11,$12) RETURNING id`,
    [ctx.clientCompanyId, bill.vendorPartyId, bill.billNumber, bill.issueDate, bill.dueDate, bill.currency,
      netCents.toString(), vatCents.toString(), grandCents.toString(), source, bill.documentId ?? null, bill.einvoiceId ?? null],
  );
  const billId = billRes.rows[0].id as string;

  for (let i = 0; i < bill.lines.length; i++) {
    const l = bill.lines[i]!;
    await tx.query(
      `INSERT INTO bill_lines(client_company_id, bill_id, line_no, description, expense_account, net_cents, vat_rate, vat_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ctx.clientCompanyId, billId, i + 1, l.description, l.expenseAccount, toCents(l.net).toString(), l.vatRate, toCents(l.vat).toString()],
    );
  }

  const rationale = {
    ruleRef: 'ap-bill',
    computation: `net ${fromCents(netCents)} + VAT ${fromCents(vatCents)} = ${fromCents(grandCents)}`,
    sourceRefs: { billId, billNumber: bill.billNumber, source },
  } as Rationale;
  const { id: proposalId } = await createProposal(tx, ctx, {
    type: 'posting', payload: buildBillEntry(bill, accounts), rationale,
    documentId: bill.documentId ?? null, status: 'pending_approval',
  });

  await tx.query(
    `UPDATE bills SET posting_proposal_id = $1 WHERE id = $2 AND client_company_id = $3`,
    [proposalId, billId, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, { action: 'create', entityType: 'bill', entityId: billId, before: null, after: { billNumber: bill.billNumber, grandCents: grandCents.toString(), proposalId } });
  return { billId, proposalId };
}

export async function listBills(
  tx: PoolClient, ctx: TenantContext, filter: { status?: string; vendorPartyId?: string } = {},
): Promise<BillRow[]> {
  const res = await tx.query(
    `SELECT ${ROW_COLS} FROM bills b JOIN parties p ON p.id = b.vendor_party_id
     WHERE b.client_company_id = $1
       AND ($2::text IS NULL OR b.status = $2)
       AND ($3::uuid IS NULL OR b.vendor_party_id = $3)
     ORDER BY b.due_date ASC, b.created_at ASC`,
    [ctx.clientCompanyId, filter.status ?? null, filter.vendorPartyId ?? null],
  );
  return res.rows;
}

export async function getBill(tx: PoolClient, ctx: TenantContext, id: string): Promise<BillDetail> {
  const b = await tx.query(
    `SELECT ${ROW_COLS} FROM bills b JOIN parties p ON p.id = b.vendor_party_id
     WHERE b.id = $1 AND b.client_company_id = $2`,
    [id, ctx.clientCompanyId],
  );
  if (!b.rowCount) throw new Error(`Bill not found: ${id}`);
  const lines = await tx.query(
    `SELECT line_no AS "lineNo", description, expense_account AS "expenseAccount",
            net_cents::text AS "netCents", vat_rate::text AS "vatRate", vat_cents::text AS "vatCents"
     FROM bill_lines WHERE bill_id = $1 AND client_company_id = $2 ORDER BY line_no`,
    [id, ctx.clientCompanyId],
  );
  return { ...b.rows[0], lines: lines.rows };
}

export async function voidBill(tx: PoolClient, ctx: TenantContext, id: string): Promise<void> {
  const b = await getBill(tx, ctx, id);
  if (b.status !== 'awaiting_approval') throw new Error(`Only an awaiting_approval bill can be voided (status=${b.status})`);
  await tx.query(`UPDATE bills SET status = 'void' WHERE id = $1 AND client_company_id = $2`, [id, ctx.clientCompanyId]);
  if (b.postingProposalId) await rejectProposal(tx, ctx, b.postingProposalId, 'bill voided');
  await appendAudit(tx, ctx, { action: 'void', entityType: 'bill', entityId: id, before: { status: b.status }, after: { status: 'void' } });
}
