/**
 * Manual end-to-end check against the GoCardless sandbox (SANDBOXFINANCE_SFIN0000).
 * Pass 1 (no arg): creates a requisition, prints the consent URL — open it, approve.
 * Pass 2 (requisition id as arg): prints linked accounts + a page of transactions.
 * Never run by the test suite.
 */
import { GoCardlessProvider } from '../src/bankfeed/gocardless.js';

const provider = new GoCardlessProvider(process.env.GOCARDLESS_SECRET_ID!, process.env.GOCARDLESS_SECRET_KEY!);
const requisitionId = process.argv[2];

if (!requisitionId) {
  const { requisitionId: id, consentUrl } = await provider.startConsent(
    'SANDBOXFINANCE_SFIN0000', 'http://localhost:3000/bank/callback', `sandbox-${Math.floor(Math.random() * 1e9)}`);
  console.log(`requisition: ${id}\nopen and approve: ${consentUrl}\nthen: npx tsx scripts/bankfeed-sandbox.ts ${id}`);
} else {
  const req = await provider.getRequisition(requisitionId);
  console.log('status:', req.status, 'consentExpiresAt:', req.consentExpiresAt);
  for (const a of req.accounts) {
    console.log(`account ${a.iban} (${a.providerAccountId})`);
    const txns = await provider.fetchTransactions(a.providerAccountId, '2026-01-01');
    console.log(JSON.stringify(txns.slice(0, 5), null, 2));
  }
}
