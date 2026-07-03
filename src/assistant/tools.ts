import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { explainVat } from '../tax/explain.js';
import { getTaxRate } from '../tax/rules.js';
import { trialBalance } from '../ledger/balances.js';
import { outstandingReceivables } from '../banking/sepa.js';
import { listProposals } from '../proposals/proposals.js';

export interface ToolResult { result: unknown; citations: string[] }
export interface ToolSpec {
  name: string; description: string;
  run(tx: PoolClient, ctx: TenantContext, args: Record<string, unknown>): Promise<ToolResult>;
}
export interface AssistantConfig { outputVatAccount: string; inputVatAccount: string; receivablesAccount: string }

const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);

export function buildAssistantTools(config: AssistantConfig): ToolSpec[] {
  return [
    {
      name: 'get_vat_position',
      description: 'VAT owed/refundable for a period (args: fromDate, toDate as YYYY-MM-DD). Returns net payable + the rate rule + contributing entries.',
      async run(tx, ctx, args) {
        const e = await explainVat(tx, ctx, {
          fromDate: str(args.fromDate, '2026-01-01'), toDate: str(args.toDate, '2026-12-31'),
          config: { outputVatAccount: config.outputVatAccount, inputVatAccount: config.inputVatAccount },
        });
        return { result: { netPayable: e.netPayable, rule: e.ruleRef }, citations: [...e.contributions.map((c) => c.entryId), `rule:${e.ruleRef.ruleType}@${e.ruleRef.effectiveFrom}`] };
      },
    },
    {
      name: 'get_trial_balance',
      description: 'Current trial balance: every account with its debit/credit totals and balance.',
      async run(tx, ctx) {
        const rows = await trialBalance(tx, ctx);
        return { result: rows, citations: rows.map((r) => `account:${r.code}`) };
      },
    },
    {
      name: 'get_receivables',
      description: 'Total outstanding receivables (what customers owe), in decimal.',
      async run(tx, ctx) {
        const { balanceCents } = await outstandingReceivables(tx, ctx, config.receivablesAccount);
        const n = BigInt(balanceCents);
        const dec = `${n / 100n}.${(n % 100n).toString().padStart(2, '0')}`;
        return { result: { outstanding: dec }, citations: [`account:${config.receivablesAccount}`] };
      },
    },
    {
      name: 'list_pending_approvals',
      description: 'Proposals awaiting human approval (count + type + rationale summary).',
      async run(tx, ctx) {
        const props = await listProposals(tx, ctx, { status: 'pending_approval' });
        return { result: { count: props.length, items: props.map((p) => ({ id: p.id, type: p.type })) }, citations: props.map((p) => `proposal:${p.id}`) };
      },
    },
    {
      name: 'get_tax_rate',
      description: 'Current/effective LR tax rate (args: ruleType e.g. vat_standard_rate, onDate YYYY-MM-DD).',
      async run(tx, _ctx, args) {
        const rate = await getTaxRate(tx, str(args.ruleType, 'vat_standard_rate'), str(args.onDate, '2026-01-01'));
        return { result: rate, citations: [`rule:${rate.ruleType}@${rate.effectiveFrom}`] };
      },
    },
  ];
}
