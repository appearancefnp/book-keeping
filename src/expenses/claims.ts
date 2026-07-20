import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { toCents } from '../db/money.js';
import { appendAudit } from '../audit/audit.js';
import { canSeeAllClaims, ownEmployeeId, resolveClaimEmployee } from './scope.js';
import { getExpenseSettings } from './settings.js';

export interface NewClaimLine {
  kind: 'receipt' | 'mileage'; lineDate: string; description: string; expenseAccount: string;
  net?: string; vat?: string; vatDeductible?: boolean; documentId?: string | null; km?: string;
}

export interface ClaimLine {
  lineNo: number; kind: 'receipt' | 'mileage'; lineDate: string; description: string; expenseAccount: string;
  netCents: string; vatCents: string; vatDeductible: boolean; documentId: string | null;
  km: string | null; rateCents: string | null;
}

export interface ClaimRow {
  id: string; employeeId: string; employeeName: string; status: string; description: string; currency: string;
  totalNetCents: string; totalVatCents: string; totalCents: string;
  postingProposalId: string | null; journalEntryId: string | null; createdAt: string;
}

export interface ClaimDetail extends ClaimRow { lines: ClaimLine[]; }

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONEY = /^\d+(\.\d{1,2})?$/;

const newLineSchema = z.object({
  kind: z.enum(['receipt', 'mileage']),
  lineDate: z.string().regex(DATE),
  description: z.string().min(1),
  expenseAccount: z.string().min(1),
  net: z.string().regex(MONEY).optional(),
  vat: z.string().regex(MONEY).optional(),
  vatDeductible: z.boolean().optional(),
  documentId: z.string().uuid().nullable().optional(),
  km: z.string().regex(/^\d+(\.\d)?$/).optional(),
}).superRefine((l, ctx) => {
  if (l.kind === 'receipt') {
    if (l.net === undefined) ctx.addIssue({ code: 'custom', message: 'receipt lines require net' });
  } else {
    if (l.km === undefined) ctx.addIssue({ code: 'custom', message: 'mileage lines require km' });
    if (l.net !== undefined) ctx.addIssue({ code: 'custom', message: 'mileage lines forbid net' });
    if (l.vat !== undefined) ctx.addIssue({ code: 'custom', message: 'mileage lines forbid vat' });
    if (l.vatDeductible === true) ctx.addIssue({ code: 'custom', message: 'mileage lines cannot be VAT-deductible' });
  }
});

const saveClaimSchema = z.object({
  claimId: z.string().uuid().optional(),
  employeeId: z.string().uuid().nullable().optional(),
  description: z.string().min(1),
  lines: z.array(newLineSchema).min(1),
});

/** km × 10 (exact, one decimal) × rate, rounded half-up to whole cents. */
export function mileageNetCents(km: string, rateCents: bigint): bigint {
  if (!/^\d+(\.\d)?$/.test(km)) throw new Error(`km must be a non-negative number with at most 1 decimal (got ${km})`);
  const [whole, frac = '0'] = km.split('.');
  const km10 = BigInt(whole!) * 10n + BigInt(frac); // km × 10, exact
  const num = km10 * rateCents;                    // cents × 10
  return (num + 5n) / 10n;                         // round half-up
}

interface ComputedLine extends Omit<NewClaimLine, 'net' | 'vat' | 'vatDeductible' | 'km'> {
  netCents: bigint; vatCents: bigint; vatDeductible: boolean; km: string | null; rateCents: bigint | null;
}

function computeLine(l: z.infer<typeof newLineSchema>, mileageRateCents: bigint): ComputedLine {
  if (l.kind === 'mileage') {
    return {
      kind: 'mileage', lineDate: l.lineDate, description: l.description, expenseAccount: l.expenseAccount,
      documentId: l.documentId ?? null, km: l.km!, rateCents: mileageRateCents,
      netCents: mileageNetCents(l.km!, mileageRateCents), vatCents: 0n, vatDeductible: false,
    };
  }
  return {
    kind: 'receipt', lineDate: l.lineDate, description: l.description, expenseAccount: l.expenseAccount,
    documentId: l.documentId ?? null, km: null, rateCents: null,
    netCents: toCents(l.net!), vatCents: toCents(l.vat ?? '0'), vatDeductible: l.vatDeductible ?? false,
  };
}

const ROW_COLS = `
  c.id, c.employee_id AS "employeeId", (e.first_name || ' ' || e.last_name) AS "employeeName",
  c.status, c.description, c.currency,
  c.total_net_cents::text AS "totalNetCents", c.total_vat_cents::text AS "totalVatCents", c.total_cents::text AS "totalCents",
  c.posting_proposal_id AS "postingProposalId", c.journal_entry_id AS "journalEntryId",
  to_char(c.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt"`;

const LINE_COLS = `
  line_no AS "lineNo", kind, to_char(line_date,'YYYY-MM-DD') AS "lineDate", description,
  expense_account AS "expenseAccount", net_cents::text AS "netCents", vat_cents::text AS "vatCents",
  vat_deductible AS "vatDeductible", document_id AS "documentId", km::text AS "km", rate_cents::text AS "rateCents"`;

/** Create a new claim, or (with claimId) replace an existing draft's lines wholesale. Totals are
 * always recomputed server-side; mileage lines snapshot the current mileage rate onto rate_cents. */
export async function saveClaim(
  tx: PoolClient, ctx: TenantContext,
  input: { claimId?: string; employeeId?: string | null; description: string; lines: NewClaimLine[] },
): Promise<{ claimId: string }> {
  const p = saveClaimSchema.parse(input);

  let existing: { employeeId: string; status: string } | null = null;
  if (p.claimId) {
    const res = await tx.query(
      `SELECT employee_id AS "employeeId", status FROM expense_claims WHERE id = $1 AND client_company_id = $2`,
      [p.claimId, ctx.clientCompanyId],
    );
    if (!res.rowCount) throw new Error(`Claim not found: ${p.claimId}`);
    existing = res.rows[0];
    if (existing!.status !== 'draft') throw new Error(`Only draft claims can be edited (status=${existing!.status})`);
    // Scope-check the EXISTING owner first: a client-side actor (employee/owner) must own this
    // claim already, regardless of what employeeId they pass in the update payload. Without
    // this, a requested employeeId equal to the actor's own would let them "adopt" someone
    // else's draft (resolveClaimEmployee below only validates the *target*, not the current owner).
    await resolveClaimEmployee(tx, ctx, existing!.employeeId);
  }

  const employeeId = await resolveClaimEmployee(tx, ctx, p.employeeId ?? existing?.employeeId ?? null);
  const hasMileageLine = p.lines.some((l) => l.kind === 'mileage');
  const mileageRateCents = hasMileageLine
    ? BigInt((await getExpenseSettings(tx, ctx)).mileageRateCentsPerKm)
    : 0n; // unused when there's no mileage line to price

  const lines = p.lines.map((l) => computeLine(l, mileageRateCents));
  const totalNetCents = lines.reduce((a, l) => a + l.netCents, 0n);
  const totalVatCents = lines.reduce((a, l) => a + l.vatCents, 0n);
  const totalCents = totalNetCents + totalVatCents;

  let claimId: string;
  if (existing) {
    claimId = p.claimId!;
    await tx.query(
      `UPDATE expense_claims SET employee_id = $1, description = $2, total_net_cents = $3, total_vat_cents = $4, total_cents = $5
       WHERE id = $6 AND client_company_id = $7`,
      [employeeId, p.description, totalNetCents.toString(), totalVatCents.toString(), totalCents.toString(), claimId, ctx.clientCompanyId],
    );
    await tx.query(`DELETE FROM expense_claim_lines WHERE claim_id = $1 AND client_company_id = $2`, [claimId, ctx.clientCompanyId]);
  } else {
    const res = await tx.query(
      `INSERT INTO expense_claims(client_company_id, employee_id, description, currency, total_net_cents, total_vat_cents, total_cents)
       VALUES ($1,$2,$3,'EUR',$4,$5,$6) RETURNING id`,
      [ctx.clientCompanyId, employeeId, p.description, totalNetCents.toString(), totalVatCents.toString(), totalCents.toString()],
    );
    claimId = res.rows[0].id as string;
  }

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    await tx.query(
      `INSERT INTO expense_claim_lines(client_company_id, claim_id, line_no, kind, line_date, description,
         expense_account, net_cents, vat_cents, vat_deductible, document_id, km, rate_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [ctx.clientCompanyId, claimId, i + 1, l.kind, l.lineDate, l.description, l.expenseAccount,
        l.netCents.toString(), l.vatCents.toString(), l.vatDeductible, l.documentId ?? null,
        l.km, l.rateCents !== null ? l.rateCents.toString() : null],
    );
  }

  await appendAudit(tx, ctx, {
    action: existing ? 'update' : 'create', entityType: 'expense_claim', entityId: claimId,
    before: existing, after: { employeeId, totalNetCents: totalNetCents.toString(), totalVatCents: totalVatCents.toString(), totalCents: totalCents.toString() },
  });
  return { claimId };
}

export async function getClaim(tx: PoolClient, ctx: TenantContext, id: string): Promise<ClaimDetail> {
  const res = await tx.query(
    `SELECT ${ROW_COLS} FROM expense_claims c JOIN employees e ON e.id = c.employee_id
     WHERE c.id = $1 AND c.client_company_id = $2`,
    [id, ctx.clientCompanyId],
  );
  if (!res.rowCount) throw new Error(`Claim not found: ${id}`);
  const row = res.rows[0] as ClaimRow;

  if (!canSeeAllClaims(ctx.actorRole)) {
    const own = await ownEmployeeId(tx, ctx);
    if (!own || own !== row.employeeId) throw new Error('Forbidden: not your claim');
  }

  const lines = await tx.query(
    `SELECT ${LINE_COLS} FROM expense_claim_lines WHERE claim_id = $1 AND client_company_id = $2 ORDER BY line_no`,
    [id, ctx.clientCompanyId],
  );
  return { ...row, lines: lines.rows };
}

export async function listClaims(tx: PoolClient, ctx: TenantContext, filter: { status?: string } = {}): Promise<ClaimRow[]> {
  let ownScope: string | null = null;
  if (!canSeeAllClaims(ctx.actorRole)) {
    const own = await ownEmployeeId(tx, ctx);
    if (!own) throw new Error('Not linked to an employee');
    ownScope = own;
  }
  const res = await tx.query(
    `SELECT ${ROW_COLS} FROM expense_claims c JOIN employees e ON e.id = c.employee_id
     WHERE c.client_company_id = $1
       AND ($2::text IS NULL OR c.status = $2)
       AND ($3::uuid IS NULL OR c.employee_id = $3)
     ORDER BY c.created_at DESC`,
    [ctx.clientCompanyId, filter.status ?? null, ownScope],
  );
  return res.rows;
}

export async function deleteDraft(tx: PoolClient, ctx: TenantContext, id: string): Promise<void> {
  const res = await tx.query(
    `SELECT employee_id AS "employeeId", status FROM expense_claims WHERE id = $1 AND client_company_id = $2`,
    [id, ctx.clientCompanyId],
  );
  if (!res.rowCount) throw new Error(`Claim not found: ${id}`);
  const row = res.rows[0] as { employeeId: string; status: string };
  if (row.status !== 'draft') throw new Error(`Only draft claims can be deleted (status=${row.status})`);

  // Throws Forbidden/Not-linked for client-side roles acting on someone else's claim; firm
  // roles pass through (any employeeId is permitted to be deleted by them).
  await resolveClaimEmployee(tx, ctx, row.employeeId);

  await tx.query(`DELETE FROM expense_claim_lines WHERE claim_id = $1 AND client_company_id = $2`, [id, ctx.clientCompanyId]);
  await tx.query(`DELETE FROM expense_claims WHERE id = $1 AND client_company_id = $2`, [id, ctx.clientCompanyId]);
  await appendAudit(tx, ctx, { action: 'delete', entityType: 'expense_claim', entityId: id, before: row, after: null });
}
