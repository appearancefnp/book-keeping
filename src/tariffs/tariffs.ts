import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appPool } from '../db/pool.js';
import { appendAudit } from '../audit/audit.js';

export interface TariffRow {
  id: string;
  clientCompanyId: string;
  monthlyAmountCents: string; // bigint serialized as string
  currency: string;
  vatRate: string;
  effectiveFrom: string; // YYYY-MM-DD
}

export interface FirmTariffRow {
  clientCompanyId: string;
  clientName: string;
  monthlyAmountCents: string | null;
  currency: string | null;
  vatRate: string | null;
  effectiveFrom: string | null;
}

const SELECT_COLS =
  `id, client_company_id AS "clientCompanyId", monthly_amount_cents::text AS "monthlyAmountCents",
   currency, vat_rate AS "vatRate", to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom"`;

/** Set (or correct, on a repeated effective_from) a client's monthly retainer. Audited. */
export async function setTariff(
  tx: PoolClient,
  ctx: TenantContext,
  input: { monthlyAmountCents: bigint; currency: string; vatRate: string; effectiveFrom: string },
): Promise<{ id: string }> {
  const res = await tx.query(
    `INSERT INTO client_tariffs(client_company_id, monthly_amount_cents, currency, vat_rate, effective_from, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (client_company_id, effective_from)
       DO UPDATE SET monthly_amount_cents = EXCLUDED.monthly_amount_cents,
                     currency = EXCLUDED.currency,
                     vat_rate = EXCLUDED.vat_rate,
                     created_by = EXCLUDED.created_by
     RETURNING id`,
    [ctx.clientCompanyId, input.monthlyAmountCents.toString(), input.currency, input.vatRate, input.effectiveFrom, ctx.actorId],
  );
  const id = res.rows[0].id as string;
  await appendAudit(tx, ctx, {
    action: 'set',
    entityType: 'tariff',
    entityId: id,
    before: null,
    after: { ...input, monthlyAmountCents: input.monthlyAmountCents.toString() },
  });
  return { id };
}

/** The client's tariff in effect at `asOf` (greatest effective_from <= asOf), or null. No RLS on client_tariffs: callers must have firm-verified ctx.clientCompanyId (see POST /api/admin/tariffs). */
export async function getCurrentTariff(
  tx: PoolClient, ctx: TenantContext, asOf: string,
): Promise<TariffRow | null> {
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM client_tariffs
     WHERE client_company_id = $1 AND effective_from <= $2
     ORDER BY effective_from DESC LIMIT 1`,
    [ctx.clientCompanyId, asOf],
  );
  return res.rows[0] ?? null;
}

/** One current tariff per client company in the firm (null fields where none set). Firm-scoped, no RLS. */
export async function listCurrentTariffsForFirm(
  firmId: string, asOf: string,
): Promise<FirmTariffRow[]> {
  const res = await appPool.query(
    `SELECT c.id AS "clientCompanyId", c.name AS "clientName",
            t.monthly_amount_cents::text AS "monthlyAmountCents", t.currency,
            t.vat_rate AS "vatRate", to_char(t.effective_from, 'YYYY-MM-DD') AS "effectiveFrom"
     FROM client_companies c
     LEFT JOIN LATERAL (
       SELECT monthly_amount_cents, currency, vat_rate, effective_from
       FROM client_tariffs
       WHERE client_company_id = c.id AND effective_from <= $2
       ORDER BY effective_from DESC LIMIT 1
     ) t ON true
     WHERE c.firm_id = $1
     ORDER BY c.name ASC`,
    [firmId, asOf],
  );
  return res.rows;
}
