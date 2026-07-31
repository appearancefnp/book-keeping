import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';

export type PartyKind = 'customer' | 'vendor' | 'both';
export interface PartyRow { id: string; kind: PartyKind; name: string; regNo: string | null; vatNo: string | null; iban: string | null; paymentTermsDays: number | null; countryCode: string; }

const countryCodeSchema = z.string().length(2).transform((s) => s.toUpperCase());

const newPartySchema = z.object({
  kind: z.enum(['customer', 'vendor', 'both']),
  name: z.string().min(1),
  regNo: z.string().min(1).nullable().optional(),
  vatNo: z.string().min(1).nullable().optional(),
  iban: z.string().min(1).nullable().optional(),
  countryCode: countryCodeSchema.default('LV'),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
});

const SELECT_COLS = 'id, kind, name, reg_no AS "regNo", vat_no AS "vatNo", iban, country_code AS "countryCode", payment_terms_days AS "paymentTermsDays"';

/**
 * Compute an invoice due date from its issue date plus a customer's payment-terms days.
 * Pure date math (UTC, no DB access) so the compose-path route can derive a fallback due date
 * when the caller supplied neither an explicit dueDate nor an invoice.dueDate.
 */
export function dueDateFromTerms(issueDate: string, paymentTermsDays: number): string {
  const d = new Date(`${issueDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + paymentTermsDays);
  return d.toISOString().slice(0, 10);
}

export async function createParty(
  tx: PoolClient, ctx: TenantContext,
  input: { kind: PartyKind; name: string; regNo?: string | null; vatNo?: string | null; iban?: string | null; countryCode?: string; paymentTermsDays?: number | null },
): Promise<{ id: string }> {
  const p = newPartySchema.parse(input);
  const res = await tx.query(
    `INSERT INTO parties(client_company_id, kind, name, reg_no, vat_no, iban, country_code, payment_terms_days)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.clientCompanyId, p.kind, p.name, p.regNo ?? null, p.vatNo ?? null, p.iban ?? null, p.countryCode, p.paymentTermsDays ?? null],
  );
  const id = res.rows[0].id as string;
  await appendAudit(tx, ctx, { action: 'create', entityType: 'party', entityId: id, before: null, after: p });
  return { id };
}

export async function getParty(tx: PoolClient, ctx: TenantContext, id: string): Promise<PartyRow> {
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM parties WHERE id = $1 AND client_company_id = $2`,
    [id, ctx.clientCompanyId],
  );
  if (!res.rowCount) throw new Error(`Party not found: ${id}`);
  return res.rows[0];
}

export async function listParties(
  tx: PoolClient, ctx: TenantContext, filter: { kind?: PartyKind } = {},
): Promise<PartyRow[]> {
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM parties
     WHERE client_company_id = $1 AND ($2::text IS NULL OR kind = $2)
     ORDER BY name`,
    [ctx.clientCompanyId, filter.kind ?? null],
  );
  return res.rows;
}

export async function updateParty(
  tx: PoolClient, ctx: TenantContext, id: string,
  patch: { name?: string; regNo?: string | null; vatNo?: string | null; kind?: PartyKind; iban?: string | null; countryCode?: string; paymentTermsDays?: number | null },
): Promise<void> {
  const before = await getParty(tx, ctx, id);
  const patchCountryCode = patch.countryCode !== undefined ? countryCodeSchema.parse(patch.countryCode) : undefined;
  const merged = {
    name: patch.name ?? before.name,
    regNo: patch.regNo !== undefined ? patch.regNo : before.regNo,
    vatNo: patch.vatNo !== undefined ? patch.vatNo : before.vatNo,
    kind: patch.kind ?? before.kind,
    iban: patch.iban !== undefined ? patch.iban : before.iban,
    countryCode: patchCountryCode !== undefined ? patchCountryCode : before.countryCode,
    paymentTermsDays: patch.paymentTermsDays !== undefined ? patch.paymentTermsDays : before.paymentTermsDays,
  };
  await tx.query(
    `UPDATE parties SET name=$1, reg_no=$2, vat_no=$3, kind=$4, iban=$5, country_code=$6, payment_terms_days=$7
     WHERE id=$8 AND client_company_id=$9`,
    [merged.name, merged.regNo, merged.vatNo, merged.kind, merged.iban, merged.countryCode, merged.paymentTermsDays, id, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, { action: 'update', entityType: 'party', entityId: id, before, after: merged });
}
