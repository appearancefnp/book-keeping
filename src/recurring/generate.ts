import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { AccessPoint } from '../einvoice/access-point.js';
import type { EInvoice } from '../einvoice/ubl.js';
import { getTemplate, advanceSchedule, deactivateTemplate } from './recurring.js';
import { advanceRunDate, periodKey, buildRecurringInvoiceNumber } from './schedule.js';
import { resolveAutonomy } from '../autonomy/autonomy.js';
import { createProposal } from '../proposals/proposals.js';
import { sendInvoice } from '../einvoice/outbound.js';
import { getInvoiceProfile } from '../einvoice/invoice-profile.js';
import { getParty, dueDateFromTerms } from '../parties/parties.js';
import { toCents } from '../db/money.js';

/**
 * Bill the latest scheduled occurrence on/before today (skip-to-current), gate issue via autonomy
 * (auto → sendInvoice; approval → a pending_approval proposal), then advance next_run_date and
 * apply end conditions. Idempotent: the advance commits in the same tx as the send, so a redelivered
 * job finds nothing due. Returns { generated, active } where active drives handler self-perpetuation.
 */
export async function generateDueRecurring(
  tx: PoolClient, ctx: TenantContext,
  args: { templateId: string; now: Date; ap: AccessPoint; accounts: { receivable: string; sales: string; vat: string } },
): Promise<{ generated: boolean; active: boolean }> {
  const today = args.now.toISOString().slice(0, 10);
  const t = await getTemplate(tx, ctx, args.templateId);
  if (!t.active) return { generated: false, active: false };

  // Skip-to-current: walk forward to the latest occurrence on/before today.
  let billDate = t.nextRunDate;
  while (advanceRunDate(billDate, t.intervalMonths, t.anchorDay) <= today) {
    billDate = advanceRunDate(billDate, t.intervalMonths, t.anchorDay);
  }
  if (billDate > today) return { generated: false, active: true }; // not yet due

  // End conditions evaluated against the date we would bill.
  if (t.endDate && billDate > t.endDate) { await deactivateTemplate(tx, ctx, t.id); return { generated: false, active: false }; }
  if (t.occurrencesRemaining !== null && t.occurrencesRemaining <= 0) { await deactivateTemplate(tx, ctx, t.id); return { generated: false, active: false }; }

  // Build the invoice from the template payload + per-run fields.
  const profile = await getInvoiceProfile(tx, ctx);
  const invoiceNumber = buildRecurringInvoiceNumber(profile?.numberPrefix ?? null, billDate, t.id);
  let termsDays = t.paymentTermsDays;
  if (termsDays == null) {
    const party = await getParty(tx, ctx, t.customerPartyId);
    termsDays = party.paymentTermsDays;
  }
  const dueDate = termsDays != null ? dueDateFromTerms(billDate, termsDays) : null;
  const invoice: EInvoice = { ...t.invoicePayload, invoiceNumber, issueDate: billDate, ...(dueDate ? { dueDate } : {}) };

  // Autonomy gate.
  const mode = await resolveAutonomy(tx, ctx, 'recurring_invoice', { amountCents: toCents(invoice.grandTotal) });
  if (mode === 'auto') {
    await sendInvoice(tx, ctx, {
      invoice, recipientPeppolId: t.recipientPeppolId, ap: args.ap,
      receivableAccount: args.accounts.receivable, salesAccount: args.accounts.sales, vatAccount: args.accounts.vat,
      customerPartyId: t.customerPartyId, dueDate,
    });
  } else {
    await createProposal(tx, ctx, {
      type: 'recurring_invoice', status: 'pending_approval',
      payload: { invoice, recipientPeppolId: t.recipientPeppolId, customerPartyId: t.customerPartyId, dueDate },
      rationale: { computation: `recurring invoice for ${periodKey(billDate)}`, sourceRefs: { templateId: t.id, period: periodKey(billDate) } },
    });
  }

  // Advance schedule + apply end conditions for the NEXT run.
  const nextRunDate = advanceRunDate(billDate, t.intervalMonths, t.anchorDay);
  const occurrencesRemaining = t.occurrencesRemaining === null ? null : Math.max(0, t.occurrencesRemaining - 1);
  const active = !(t.endDate != null && nextRunDate > t.endDate) && !(occurrencesRemaining !== null && occurrencesRemaining <= 0);
  await advanceSchedule(tx, ctx, t.id, { nextRunDate, occurrencesRemaining, active });
  return { generated: true, active };
}
