import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appPool, withTenant } from '../db/pool.js';
import { appendAudit } from '../audit/audit.js';
import { createClientCompany, type ClientCompany } from '../tenancy/firms.js';
import { assignUserToClient } from '../auth/context.js';
import { listAccounts, createAccount, type AccountType } from '../ledger/accounts.js';
import { listAutonomyPolicies, setAutonomy, type AutonomyMode } from '../autonomy/autonomy.js';
import { getCurrentTariff, setTariff } from '../tariffs/tariffs.js';

export interface TemplateAccount { code: string; name: string; type: AccountType }
export interface TemplateAutonomy { operationType: string; mode: AutonomyMode; materialThresholdCents: string }
export interface TemplateTariff { monthlyAmountCents: string; currency: string; vatRate: string }
export interface TemplateBody {
  accounts: TemplateAccount[];
  autonomy: TemplateAutonomy[];
  tariff: TemplateTariff | null;
}
export interface TemplateSummary {
  id: string; name: string; accountCount: number; policyCount: number; hasTariff: boolean;
}

const SNAPSHOT_ASOF = '9999-12-31'; // reading: select the latest tariff row by effective_from
// applying: date the seeded tariff far in the past so it is immediately "current" for the new client.
const ONBOARDING_TARIFF_EFFECTIVE_FROM = '2000-01-01';

/** Capture a client's accounts + autonomy + current tariff into a named firm template. Audited. */
export async function snapshotClientAsTemplate(
  tx: PoolClient, ctx: TenantContext, name: string,
): Promise<{ id: string }> {
  const accounts = (await listAccounts(tx, ctx)).map((a) => ({ code: a.code, name: a.name, type: a.type }));
  const autonomy = (await listAutonomyPolicies(tx, ctx)).map((p) => ({
    operationType: p.operationType, mode: p.mode, materialThresholdCents: p.materialThresholdCents,
  }));
  const t = await getCurrentTariff(tx, ctx, SNAPSHOT_ASOF);
  const tariff: TemplateTariff | null = t
    ? { monthlyAmountCents: t.monthlyAmountCents, currency: t.currency, vatRate: t.vatRate }
    : null;
  const body: TemplateBody = { accounts, autonomy, tariff };

  const res = await tx.query(
    `INSERT INTO onboarding_templates(firm_id, name, body, created_by)
     VALUES ($1,$2,$3::jsonb,$4) RETURNING id`,
    [ctx.firmId, name, JSON.stringify(body), ctx.actorId],
  );
  const id = res.rows[0].id as string;
  await appendAudit(tx, ctx, {
    action: 'snapshot', entityType: 'onboarding_template', entityId: id,
    before: null, after: { name, accounts: accounts.length, autonomy: autonomy.length, hasTariff: tariff !== null },
  });
  return { id };
}

/** One summary row per template in the firm. Firm-scoped, no RLS. */
export async function listTemplatesForFirm(firmId: string): Promise<TemplateSummary[]> {
  const res = await appPool.query(
    `SELECT id, name,
            COALESCE(jsonb_array_length(body->'accounts'), 0) AS "accountCount",
            COALESCE(jsonb_array_length(body->'autonomy'), 0) AS "policyCount",
            (body->'tariff') IS NOT NULL AND (body->'tariff') <> 'null'::jsonb AS "hasTariff"
     FROM onboarding_templates WHERE firm_id = $1 ORDER BY name ASC`,
    [firmId],
  );
  return res.rows.map((r) => ({
    id: r.id, name: r.name,
    accountCount: Number(r.accountCount), policyCount: Number(r.policyCount), hasTariff: r.hasTariff,
  }));
}

/** Fetch one template's body, firm-scoped. Null if absent or in another firm. */
export async function getTemplateBody(firmId: string, id: string): Promise<TemplateBody | null> {
  const res = await appPool.query(
    `SELECT body FROM onboarding_templates WHERE id = $1 AND firm_id = $2`,
    [id, firmId],
  );
  return res.rows[0] ? (res.rows[0].body as TemplateBody) : null;
}

/**
 * Create a client, assign the creator, and (if a template is given) seed the new
 * client's accounts + autonomy + tariff from the template body. Audited.
 * Throws 'unknown template' if templateId is given but not found in the firm.
 *
 * Not atomic: createClientCompany, assignUserToClient, and withTenant seed run
 * as three separate transactions. If seeding throws, a created + assigned but
 * unseeded client remains—a valid state. Idempotent retry/cleanup is a follow-up.
 */
export async function createClientFromTemplate(
  firmId: string,
  input: { name: string; regNo: string; baseCurrency?: string },
  templateId: string | null,
  actorId: string,
): Promise<ClientCompany> {
  const body = templateId ? await getTemplateBody(firmId, templateId) : null;
  if (templateId && !body) throw new Error('unknown template');

  const client = await createClientCompany(firmId, input);

  await assignUserToClient(actorId, client.id);

  if (body) {
    const ctx: TenantContext = { firmId, clientCompanyId: client.id, actorId, actorRole: 'firm_admin' };
    await withTenant(ctx, async (tx) => {
      for (const a of body.accounts) await createAccount(tx, ctx, a);
      for (const p of body.autonomy) {
        await setAutonomy(tx, ctx, {
          operationType: p.operationType, mode: p.mode, materialThresholdCents: BigInt(p.materialThresholdCents),
        });
      }
      if (body.tariff) {
        await setTariff(tx, ctx, {
          monthlyAmountCents: BigInt(body.tariff.monthlyAmountCents),
          currency: body.tariff.currency, vatRate: body.tariff.vatRate,
          effectiveFrom: ONBOARDING_TARIFF_EFFECTIVE_FROM,
        });
      }
      await appendAudit(tx, ctx, {
        action: 'create_from_template', entityType: 'client_company', entityId: client.id,
        before: null, after: { templateId },
      });
    });
  }
  return client;
}
