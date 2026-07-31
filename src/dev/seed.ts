/**
 * Dev/demo seed. Resets the database (drops + re-migrates) then inserts a rich, known
 * fake dataset so every cabinet screen is non-empty: two client companies, an accountant
 * and an owner, a Latvian chart-of-accounts subset, open periods, parties, documents, and
 * a full approval queue (posting + bank-match + VAT-declaration proposals), tasks and
 * notifications. Prints login credentials + a current 2FA code at the end.
 *
 * Run:  npm run seed            (WIPES the DB, then seeds — intended for local/demo)
 *
 * Requires Postgres up (docker compose up -d db) and .env with DATABASE_URL + ADMIN_DATABASE_URL.
 */
import { adminPool, appPool, withTenant } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { createFirm, createClientCompany } from '../tenancy/firms.js';
import type { TenantContext } from '../tenancy/context.js';
import { createUser } from '../auth/users.js';
import { totpCodeFor, totpUri } from '../auth/totp.js';
import { assignUserToClient } from '../auth/context.js';
import { createAccount } from '../ledger/accounts.js';
import { openPeriod } from '../ledger/periods.js';
import { postEntry } from '../ledger/posting.js';
import { createParty } from '../parties/parties.js';
import { createDocument, setDocumentStatus } from '../documents/documents.js';
import { recordExtraction } from '../documents/extraction.js';
import { createProposal, type Rationale } from '../proposals/proposals.js';
import { importStatement } from '../banking/import.js';
import { proposeArMatches } from '../banking/match.js';
import { createVatDeclarationProposal } from '../tax/vat-proposal.js';
import { setVatSettings } from '../tax/vat-settings.js';
import { sendInvoice } from '../einvoice/outbound.js';
import { StubAccessPoint } from '../einvoice/access-point.js';
import type { EInvoice } from '../einvoice/ubl.js';
import { createBill } from '../payables/bills.js';
import { approveProposal } from '../proposals/lifecycle.js';
import { postApprovedPosting } from '../proposals/post-proposal.js';
import { createTask, resolveTask } from '../collab/tasks.js';
import { addComment } from '../collab/comments.js';
import { notify } from '../collab/notifications.js';

const VAT_CONFIG = { outputVatAccount: '5721', inputVatAccount: '5722' };

/** Latvian CoA subset used across the demo. */
const ACCOUNTS: { code: string; name: string; type: 'asset' | 'liability' | 'equity' | 'income' | 'expense' }[] = [
  { code: '2310', name: 'Debitori (Debtors)', type: 'asset' },
  { code: '2620', name: 'Norēķinu konts / Banka (Bank)', type: 'asset' },
  { code: '5310', name: 'Kreditori (Payables)', type: 'liability' },
  { code: '5721', name: 'PVN par pārdošanu (Output VAT)', type: 'liability' },
  { code: '5722', name: 'PVN par pirkumiem (Input VAT)', type: 'asset' },
  { code: '2699', name: 'Naudas līdzekļi ceļā (Payments in transit)', type: 'asset' },
  { code: '6110', name: 'Ieņēmumi no pārdošanas (Sales)', type: 'income' },
  { code: '7710', name: 'Saimnieciskās darbības izdevumi (Expense)', type: 'expense' },
];

async function seedClient(ctx: TenantContext, client: { name: string; regNo: string }): Promise<void> {
  const clientName = client.name;
  await withTenant(ctx, async (tx) => {
    for (const a of ACCOUNTS) await createAccount(tx, ctx, a);
    await openPeriod(tx, ctx, { year: 2026, month: 2 });
    await openPeriod(tx, ctx, { year: 2026, month: 3 });

    // Parties
    await createParty(tx, ctx, { kind: 'customer', name: 'SIA Klients Alfa', regNo: '40200000011', vatNo: 'LV40200000011' });
    await createParty(tx, ctx, { kind: 'customer', name: 'SIA Beta Tirdzniecība', regNo: '40200000012' });
    await createParty(tx, ctx, { kind: 'vendor', name: 'SIA Piegādātājs Gamma', regNo: '40300000021', vatNo: 'LV40300000021' });
    await createParty(tx, ctx, { kind: 'vendor', name: 'AS Enerģija', regNo: '40300000022' });

    // --- M9: VAT categories + EC Sales List demo data. --------------------------------
    // The client needs a VAT number on file so the PVN 2 (EC Sales List) XML has a
    // declarant, and both the K sale and the AE bill quote it as the LV supplier/self.
    const clientVatNo = `LV${client.regNo}`;
    await setVatSettings(tx, ctx, { vatNo: clientVatNo, periodicity: 'monthly' });

    // Dated in February 2026 — a period the seed already opens (see openPeriod above) but
    // otherwise leaves empty, unlike March, which carries the raw postEntry credit sale
    // below. That sale has no document behind it, so it would make the ledger-vs-documents
    // reconciliation indicator disagree for reasons that have nothing to do with this data
    // (see the design note in src/tax/vat-breakdown.ts) — using a clean period keeps the
    // K/AE demo self-contained and genuinely reconciling.
    const eeCustomer = await createParty(tx, ctx, {
      kind: 'customer', name: 'Baltic Wood OÜ', regNo: '10345678', vatNo: 'EE101234567', countryCode: 'EE',
    });
    const euVendor = await createParty(tx, ctx, {
      kind: 'vendor', name: 'Nordwind Logistik GmbH', regNo: 'HRB123456', vatNo: 'DE123456789', countryCode: 'DE',
    });

    // Intra-EU goods sale: K line carries vatRate 0 / vat 0.00 — the customer self-assesses
    // at their own domestic rate, so no rate may be stated on the wire document (BR-IC-5).
    const eeInvoice: EInvoice = {
      invoiceNumber: 'INV-2026-EE-001', issueDate: '2026-02-10', currency: 'EUR',
      supplier: { name: clientName, regNo: client.regNo, vatNo: clientVatNo },
      customer: { name: 'Baltic Wood OÜ', regNo: '10345678', vatNo: 'EE101234567' },
      lines: [{ description: 'Koka izstrādājumu piegāde (intra-ES)', net: '1500.00', vatRate: 0, vat: '0.00', vatCategory: 'K' }],
      netTotal: '1500.00', vatTotal: '0.00', grandTotal: '1500.00',
    };
    await sendInvoice(tx, ctx, {
      invoice: eeInvoice, recipientPeppolId: '0037:10345678', ap: new StubAccessPoint(),
      receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721', customerPartyId: eeCustomer.id,
    });

    // Reverse-charge purchase: AE line carries the DOMESTIC rate (21) — that is what we
    // self-assess by, since the vendor invoiced 0%. Approved + posted (not left
    // awaiting_approval) so it has a journal_entry_id and counts in the VAT breakdown.
    const { proposalId: euBillProposalId } = await createBill(
      tx, ctx,
      {
        vendorPartyId: euVendor.id, billNumber: 'NORD-2026-002', issueDate: '2026-02-12', dueDate: '2026-03-14',
        currency: 'EUR', source: 'manual',
        lines: [{ description: 'Loģistikas pakalpojumi (reverse charge)', expenseAccount: '7710', net: '800.00', vatRate: 21, vat: '0.00', vatCategory: 'AE' }],
      },
      { vatInputAccount: '5722', vatOutputAccount: '5721', payablesAccount: '5310' },
    );
    await approveProposal(tx, ctx, euBillProposalId);
    await postApprovedPosting(tx, ctx, euBillProposalId);
    // --- end M9 demo data. -------------------------------------------------------------

    // A credit sale in March: DR debtors 121 / CR sales 100 / CR output VAT 21.
    // This creates an open receivable (for bank matching) and output VAT (for the declaration).
    await postEntry(tx, ctx, {
      date: '2026-03-05', memo: `Pārdošanas rēķins INV-2026-014 — ${clientName}`, currency: 'EUR',
      lines: [
        { accountCode: '2310', debit: '121.00', credit: '0', description: 'Debitors' },
        { accountCode: '6110', debit: '0', credit: '100.00', description: 'Ieņēmumi' },
        { accountCode: '5721', debit: '0', credit: '21.00', description: 'PVN 21%' },
      ],
    });

    // Documents: one extracted (from a photo), one still needing review.
    const docA = await createDocument(tx, ctx, { source: 'mobile', storageKey: `${ctx.clientCompanyId}/receipt-gamma.jpg`, mime: 'image/jpeg', uploadedBy: ctx.actorId });
    await recordExtraction(tx, ctx, docA.id, {
      extractedData: { supplierName: 'SIA Piegādātājs Gamma', supplierRegNo: '40300000021', date: '2026-03-08', currency: 'EUR', lineItems: [{ description: 'Biroja preces', net: '80.00', vatRate: 21, vat: '16.80' }], vatTotal: '16.80', netTotal: '80.00', grandTotal: '96.80' },
      confidence: { supplierName: 0.98, grandTotal: 0.96 },
    });
    const docB = await createDocument(tx, ctx, { source: 'email', storageKey: `${ctx.clientCompanyId}/energija-2026-03.pdf`, mime: 'application/pdf', uploadedBy: ctx.actorId });
    await setDocumentStatus(tx, ctx, docB.id, 'needs_review');

    // Two purchase posting proposals awaiting approval (DR expense + DR input VAT / CR payables).
    const purchases = [
      { supplier: 'SIA Piegādātājs Gamma', net: '80.00', vat: '16.80', gross: '96.80', ref: 'GAMMA-3391', documentId: docA.id },
      { supplier: 'AS Enerģija', net: '210.00', vat: '44.10', gross: '254.10', ref: 'EN-77120', documentId: null as string | null },
    ];
    for (const p of purchases) {
      const rationale: Rationale = {
        ruleRef: 'purchase-invoice-template',
        computation: `net ${p.net} + PVN 21% ${p.vat} = ${p.gross}`,
        sourceRefs: { supplier: p.supplier, invoiceRef: p.ref, documentId: p.documentId },
      };
      await createProposal(tx, ctx, {
        type: 'posting',
        documentId: p.documentId,
        status: 'pending_approval',
        payload: {
          date: '2026-03-08', memo: `Pirkuma rēķins ${p.ref} — ${p.supplier}`, currency: 'EUR',
          lines: [
            { accountCode: '7710', debit: p.net, credit: '0', description: 'Izdevumi' },
            { accountCode: '5722', debit: p.vat, credit: '0', description: 'PVN priekšnodoklis' },
            { accountCode: '5310', debit: '0', credit: p.gross, description: 'Kreditors' },
          ],
        },
        rationale,
      });
    }

    // Bank statement import + a match proposal against the open 121.00 receivable.
    await importStatement(tx, ctx, {
      account: 'LV80BANK0000435195001',
      transactions: [
        { bookingDate: '2026-03-12', amountCents: '12100', currency: 'EUR', side: 'credit', reference: 'Apmaksa INV-2026-014', counterparty: 'SIA Klients Alfa', endToEndId: 'INV-2026-014' },
        { bookingDate: '2026-03-13', amountCents: '9680', currency: 'EUR', side: 'debit', reference: 'GAMMA-3391', counterparty: 'SIA Piegādātājs Gamma', endToEndId: 'GAMMA-3391' },
      ],
    });
    // Note: the 121.00 receivable above is a raw journal entry (postEntry), not an outbound
    // einvoice, so proposeArMatches (which matches against open einvoices) will not link it
    // to this bank credit — 0 proposals here is expected/accepted for the demo seed.
    await proposeArMatches(tx, ctx, { receivableAccount: '2310', bankAccount: '2620' });

    // VAT declaration proposal for March (always human-approved).
    await createVatDeclarationProposal(tx, ctx, { fromDate: '2026-03-01', toDate: '2026-03-31', config: VAT_CONFIG });

    // Tasks: one open (needs action) + one already resolved (archived), with a comment on each.
    const taskOpen = await createTask(tx, ctx, { title: 'Trūkst līguma pie AS Enerģija rēķina', detail: 'Lūdzu augšupielādēt piegādes līgumu, lai varam klasificēt izdevumu.' });
    await addComment(tx, ctx, { entityType: 'task', entityId: taskOpen.id, body: 'Esmu nosūtījis pieprasījumu klientam — gaidu atbildi.' });

    const taskDone = await createTask(tx, ctx, { title: 'Pārbaudīt bankas konta bilanci uz 28.02.2026', detail: 'Salīdzināt grāmatvedības atlikumu ar bankas izrakstu un apstiprināt mēneša slēgumu.' });
    await addComment(tx, ctx, { entityType: 'task', entityId: taskDone.id, body: 'Bilances sakrīt. Februāra periods slēgts.' });
    await resolveTask(tx, ctx, taskDone.id);

    // Notifications: one unread (approval needed) + one already informational (task resolved).
    await notify(tx, ctx, { recipient: ctx.actorId, kind: 'approval_needed', message: 'Vairāki grāmatojumi gaida apstiprinājumu.' });
    await notify(tx, ctx, { recipient: ctx.actorId, kind: 'task_resolved', message: `Uzdevums "${taskDone.id.slice(0, 8)}" tika atrisināts — februāra periods slēgts.` });
  });
}

async function main(): Promise<void> {
  console.log('⚠️  Resetting the database (drop + migrate), then seeding demo data…');
  await adminPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations();

  const firm = await createFirm('Demo Grāmatvedības Birojs');
  const accountant = await createUser({ firmId: firm.id, email: 'accountant@demo.lv', password: 'password123', role: 'accountant', language: 'lv' });
  const owner = await createUser({ firmId: firm.id, email: 'owner@demo.lv', password: 'password123', role: 'owner', language: 'lv' });

  const clientA = await createClientCompany(firm.id, { name: 'SIA Ziemeļvējs', regNo: '40100000001' });
  const clientB = await createClientCompany(firm.id, { name: 'SIA Baltic Coffee', regNo: '40100000002' });

  // Accountant manages both clients; owner sees the first.
  await assignUserToClient(accountant.id, clientA.id);
  await assignUserToClient(accountant.id, clientB.id);
  await assignUserToClient(owner.id, clientA.id);

  const ctxFor = (clientCompanyId: string): TenantContext => ({ firmId: firm.id, clientCompanyId, actorId: accountant.id, actorRole: 'accountant' });
  await seedClient(ctxFor(clientA.id), { name: clientA.name, regNo: clientA.regNo });
  await seedClient(ctxFor(clientB.id), { name: clientB.name, regNo: clientB.regNo });

  const now = Math.floor(Date.now() / 1000);
  console.log('\n✅  Seed complete.\n');
  console.log('Firm:', firm.name);
  console.log('Clients:', clientA.name, '·', clientB.name, '(accountant sees both; owner sees the first)\n');
  console.log('Login credentials (password for both: password123):');
  for (const [label, u] of [['Accountant', accountant] as const, ['Owner', owner] as const]) {
    const email = label === 'Accountant' ? 'accountant@demo.lv' : 'owner@demo.lv';
    console.log(`\n  ${label}: ${email}`);
    console.log(`    TOTP secret : ${u.totpSecret}`);
    console.log(`    TOTP now    : ${totpCodeFor(u.totpSecret, now)}  (30s window — regenerate if expired)`);
    console.log(`    otpauth URI : ${totpUri(u.totpSecret, email)}`);
  }
  console.log('\nAdd the secret to an authenticator app, or use the printed code within 30s.');
  await Promise.all([adminPool.end(), appPool.end()]);
}

main().catch((e) => {
  console.error('Seed failed:', e);
  process.exit(1);
});
