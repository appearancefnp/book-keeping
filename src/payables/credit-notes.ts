import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { createProposal, type Rationale } from '../proposals/proposals.js';
import type { NewJournalEntry } from '../ledger/posting.js';
import { toCents, fromCents, sumCents } from '../db/money.js';
import { appendAudit } from '../audit/audit.js';
import { type VatCategory, VAT_CATEGORIES, selfAssesses, selfAssessedVatCents, categoryIssues } from '../tax/categories.js';

export interface NewVendorCreditNoteLine {
  description: string; expenseAccount: string; net: string; vatRate: number; vat: string;
  /** BT-151; absent means 'S'. */
  vatCategory?: VatCategory;
  /** Self-assessed VAT on an AE/K line is deductible unless this is explicitly false. */
  vatDeductible?: boolean;
}
export interface NewVendorCreditNote {
  vendorPartyId: string; creditNoteNumber: string; issueDate: string; currency: string;
  lines: NewVendorCreditNoteLine[]; correctedBillNumber?: string | null;
  source?: 'manual' | 'peppol'; documentId?: string | null; einvoiceId?: string | null;
}
export interface CreditNoteAccounts { vatInputAccount: string; vatOutputAccount: string; payablesAccount: string; }

export interface VendorCreditNoteRow {
  id: string; vendorPartyId: string; vendorName: string; creditNoteNumber: string; issueDate: string;
  currency: string; netCents: string; vatCents: string; grandTotalCents: string; correctedBillNumber: string | null;
  status: string; source: string; postingProposalId: string | null; journalEntryId: string | null;
}
export interface VendorCreditNoteDetail extends VendorCreditNoteRow {
  lines: {
    lineNo: number; description: string; expenseAccount: string;
    netCents: string; vatRate: string; vatCents: string;
    vatCategory: VatCategory; vatDeductible: boolean;
  }[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const schema = z.object({
  vendorPartyId: z.string().uuid(),
  creditNoteNumber: z.string().min(1),
  issueDate: z.string().regex(DATE),
  currency: z.string().length(3),
  lines: z.array(z.object({
    description: z.string().min(1),
    expenseAccount: z.string().min(1),
    net: z.string().regex(/^\d+(\.\d{1,2})?$/),   // non-negative magnitudes only
    vatRate: z.number(),
    vat: z.string().regex(/^\d+(\.\d{1,2})?$/),
    vatCategory: z.enum(VAT_CATEGORIES as unknown as [VatCategory, ...VatCategory[]]).optional(),
    vatDeductible: z.boolean().optional(),
  }).refine(
    // 'purchase': a vendor credit note is our own purchase-side record — the vendor invoiced
    // 0% on an AE/K line, so it must carry the domestic rate we self-assess at. The sales
    // side (Peppol BR-AE-5 / BR-IC-5) requires the opposite (rate 0).
    (l) => categoryIssues({ vatCategory: l.vatCategory ?? 'S', vatRate: l.vatRate, vatCents: toCents(l.vat) }, 'purchase').length === 0,
    (l) => ({ message: categoryIssues({ vatCategory: l.vatCategory ?? 'S', vatRate: l.vatRate, vatCents: toCents(l.vat) }, 'purchase').join('; ') }),
  )).min(1),
  correctedBillNumber: z.string().nullable().optional(),
  source: z.enum(['manual', 'peppol']).optional(),
  documentId: z.string().uuid().nullable().optional(),
  einvoiceId: z.string().uuid().nullable().optional(),
});

const ROW_COLS = `
  c.id, c.vendor_party_id AS "vendorPartyId", p.name AS "vendorName", c.credit_note_number AS "creditNoteNumber",
  to_char(c.issue_date,'YYYY-MM-DD') AS "issueDate", c.currency,
  c.net_cents::text AS "netCents", c.vat_cents::text AS "vatCents", c.grand_total_cents::text AS "grandTotalCents",
  c.corrected_bill_number AS "correctedBillNumber", c.status, c.source,
  c.posting_proposal_id AS "postingProposalId", c.journal_entry_id AS "journalEntryId"`;

/**
 * Reverse the bill with every amount on the opposite side of buildBillEntry: CR each
 * line's expense account, CR VAT-input (invoiced + deductible self-assessed), DR payables
 * (net + *invoiced* VAT), and DR VAT-output for self-assessed reverse-charge / intra-
 * Community VAT that the original bill credited.
 *
 * A non-deductible self-assessed line credits its expense account with net + the
 * self-assessed VAT instead of crediting VAT-input, mirroring buildBillEntry's treatment
 * of non-deductible VAT as part of the cost.
 */
export function buildCreditNoteEntry(cn: NewVendorCreditNote, accounts: CreditNoteAccounts): NewJournalEntry {
  const invoicedVat = sumCents(cn.lines.map((l) => l.vat));
  const grand = sumCents(cn.lines.map((l) => l.net)) + invoicedVat;

  const lines: { accountCode: string; debit: string; credit: string; description: string }[] = [];
  let selfAssessedTotal = 0n;
  let selfAssessedDeductible = 0n;

  for (const l of cn.lines) {
    const category = l.vatCategory ?? 'S';
    if (!selfAssesses(category)) {
      lines.push({ accountCode: l.expenseAccount, debit: '0', credit: l.net, description: l.description });
      continue;
    }
    const assessed = selfAssessedVatCents(toCents(l.net), l.vatRate);
    selfAssessedTotal += assessed;
    if (l.vatDeductible === false) {
      lines.push({ accountCode: l.expenseAccount, debit: '0', credit: fromCents(toCents(l.net) + assessed), description: l.description });
    } else {
      selfAssessedDeductible += assessed;
      lines.push({ accountCode: l.expenseAccount, debit: '0', credit: l.net, description: l.description });
    }
  }

  const inputVat = invoicedVat + selfAssessedDeductible;
  if (inputVat > 0n) lines.push({ accountCode: accounts.vatInputAccount, debit: '0', credit: fromCents(inputVat), description: 'VAT input reversal' });
  lines.push({ accountCode: accounts.payablesAccount, debit: fromCents(grand), credit: '0', description: 'Payable reduction' });
  if (selfAssessedTotal > 0n) lines.push({ accountCode: accounts.vatOutputAccount, debit: fromCents(selfAssessedTotal), credit: '0', description: 'Reverse-charge output VAT reversal' });

  return { date: cn.issueDate, memo: `Vendor credit note ${cn.creditNoteNumber}`, currency: cn.currency, lines };
}

export async function createVendorCreditNote(
  tx: PoolClient, ctx: TenantContext, input: NewVendorCreditNote, accounts: CreditNoteAccounts,
): Promise<{ creditNoteId: string; proposalId: string }> {
  const cn = schema.parse(input);
  const netCents = sumCents(cn.lines.map((l) => l.net));
  const vatCents = sumCents(cn.lines.map((l) => l.vat));
  const grandCents = netCents + vatCents;
  const source = cn.source ?? 'manual';

  const res = await tx.query(
    `INSERT INTO vendor_credit_notes(client_company_id, vendor_party_id, credit_note_number, issue_date, currency,
       net_cents, vat_cents, grand_total_cents, corrected_bill_number, status, source, document_id, einvoice_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'awaiting_approval',$10,$11,$12) RETURNING id`,
    [ctx.clientCompanyId, cn.vendorPartyId, cn.creditNoteNumber, cn.issueDate, cn.currency,
      netCents.toString(), vatCents.toString(), grandCents.toString(), cn.correctedBillNumber ?? null,
      source, cn.documentId ?? null, cn.einvoiceId ?? null],
  );
  const creditNoteId = res.rows[0].id as string;

  for (let i = 0; i < cn.lines.length; i++) {
    const l = cn.lines[i]!;
    await tx.query(
      `INSERT INTO vendor_credit_note_lines(client_company_id, credit_note_id, line_no, description, expense_account, net_cents, vat_rate, vat_cents, vat_category, vat_deductible)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [ctx.clientCompanyId, creditNoteId, i + 1, l.description, l.expenseAccount,
        toCents(l.net).toString(), l.vatRate, toCents(l.vat).toString(),
        l.vatCategory ?? 'S', l.vatDeductible ?? true],
    );
  }

  const rationale = {
    ruleRef: 'ap-credit-note',
    computation: `net ${fromCents(netCents)} + VAT ${fromCents(vatCents)} = ${fromCents(grandCents)} reduces payables`,
    sourceRefs: { creditNoteId, creditNoteNumber: cn.creditNoteNumber, source },
  } as Rationale;
  const { id: proposalId } = await createProposal(tx, ctx, {
    type: 'posting', payload: buildCreditNoteEntry(cn, accounts), rationale,
    documentId: cn.documentId ?? null, status: 'pending_approval',
  });

  await tx.query(
    `UPDATE vendor_credit_notes SET posting_proposal_id = $1 WHERE id = $2 AND client_company_id = $3`,
    [proposalId, creditNoteId, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, { action: 'create', entityType: 'vendor_credit_note', entityId: creditNoteId, before: null, after: { creditNoteNumber: cn.creditNoteNumber, grandCents: grandCents.toString(), proposalId } });
  return { creditNoteId, proposalId };
}

export async function listVendorCreditNotes(
  tx: PoolClient, ctx: TenantContext, filter: { status?: string; vendorPartyId?: string } = {},
): Promise<VendorCreditNoteRow[]> {
  const res = await tx.query(
    `SELECT ${ROW_COLS} FROM vendor_credit_notes c JOIN parties p ON p.id = c.vendor_party_id
     WHERE c.client_company_id = $1
       AND ($2::text IS NULL OR c.status = $2)
       AND ($3::uuid IS NULL OR c.vendor_party_id = $3)
     ORDER BY c.issue_date DESC, c.created_at DESC`,
    [ctx.clientCompanyId, filter.status ?? null, filter.vendorPartyId ?? null],
  );
  return res.rows;
}

export async function getVendorCreditNote(tx: PoolClient, ctx: TenantContext, id: string): Promise<VendorCreditNoteDetail> {
  const c = await tx.query(
    `SELECT ${ROW_COLS} FROM vendor_credit_notes c JOIN parties p ON p.id = c.vendor_party_id
     WHERE c.id = $1 AND c.client_company_id = $2`,
    [id, ctx.clientCompanyId],
  );
  if (!c.rowCount) throw new Error(`Vendor credit note not found: ${id}`);
  const lines = await tx.query(
    `SELECT line_no AS "lineNo", description, expense_account AS "expenseAccount",
            net_cents::text AS "netCents", vat_rate::text AS "vatRate", vat_cents::text AS "vatCents",
            vat_category AS "vatCategory", vat_deductible AS "vatDeductible"
     FROM vendor_credit_note_lines WHERE credit_note_id = $1 AND client_company_id = $2 ORDER BY line_no`,
    [id, ctx.clientCompanyId],
  );
  return { ...c.rows[0], lines: lines.rows };
}
