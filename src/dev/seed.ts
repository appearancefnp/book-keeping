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
import { proposeMatches } from '../banking/match.js';
import { createVatDeclarationProposal } from '../tax/vat-proposal.js';
import { createTask } from '../collab/tasks.js';
import { notify } from '../collab/notifications.js';

const VAT_CONFIG = { outputVatAccount: '5721', inputVatAccount: '5722' };

/** Latvian CoA subset used across the demo. */
const ACCOUNTS: { code: string; name: string; type: 'asset' | 'liability' | 'equity' | 'income' | 'expense' }[] = [
  { code: '2310', name: 'Debitori (Debtors)', type: 'asset' },
  { code: '2620', name: 'Norēķinu konts / Banka (Bank)', type: 'asset' },
  { code: '5310', name: 'Kreditori (Payables)', type: 'liability' },
  { code: '5721', name: 'PVN par pārdošanu (Output VAT)', type: 'liability' },
  { code: '5722', name: 'PVN par pirkumiem (Input VAT)', type: 'asset' },
  { code: '6110', name: 'Ieņēmumi no pārdošanas (Sales)', type: 'income' },
  { code: '7710', name: 'Saimnieciskās darbības izdevumi (Expense)', type: 'expense' },
];

async function seedClient(ctx: TenantContext, clientName: string): Promise<void> {
  await withTenant(ctx, async (tx) => {
    for (const a of ACCOUNTS) await createAccount(tx, ctx, a);
    await openPeriod(tx, ctx, { year: 2026, month: 2 });
    await openPeriod(tx, ctx, { year: 2026, month: 3 });

    // Parties
    await createParty(tx, ctx, { kind: 'customer', name: 'SIA Klients Alfa', regNo: '40200000011', vatNo: 'LV40200000011' });
    await createParty(tx, ctx, { kind: 'customer', name: 'SIA Beta Tirdzniecība', regNo: '40200000012' });
    await createParty(tx, ctx, { kind: 'vendor', name: 'SIA Piegādātājs Gamma', regNo: '40300000021', vatNo: 'LV40300000021' });
    await createParty(tx, ctx, { kind: 'vendor', name: 'AS Enerģija', regNo: '40300000022' });

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
    await proposeMatches(tx, ctx, { receivablesAccount: '2310', bankAccount: '2620' });

    // VAT declaration proposal for March (always human-approved).
    await createVatDeclarationProposal(tx, ctx, { fromDate: '2026-03-01', toDate: '2026-03-31', config: VAT_CONFIG });

    // A task/request and a notification.
    await createTask(tx, ctx, { title: 'Trūkst līguma pie AS Enerģija rēķina', detail: 'Lūdzu augšupielādēt piegādes līgumu, lai varam klasificēt izdevumu.' });
    await notify(tx, ctx, { recipient: ctx.actorId, kind: 'approval_needed', message: 'Vairāki grāmatojumi gaida apstiprinājumu.' });
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
  await seedClient(ctxFor(clientA.id), 'SIA Ziemeļvējs');
  await seedClient(ctxFor(clientB.id), 'SIA Baltic Coffee');

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
