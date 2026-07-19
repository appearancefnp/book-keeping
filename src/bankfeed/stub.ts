import type { BankFeedProvider, FeedTxn, Institution, RequisitionState } from './provider.js';

interface StubRequisition { state: RequisitionState }

/**
 * In-memory feed provider for tests and keyless dev.
 * autoLink: getRequisition links a pending requisition with one demo account +
 * a few demo transactions, so the dev connect flow works end-to-end without keys.
 */
export class StubBankFeedProvider implements BankFeedProvider {
  readonly name = 'stub';
  institutions: Institution[] = [{ id: 'STUB_BANK', name: 'Stub Bank (demo)' }];
  transactionsByAccount = new Map<string, FeedTxn[]>();
  fetchErrors = new Map<string, string>();
  deleted: string[] = [];
  private requisitions = new Map<string, StubRequisition>();
  private seq = 0;
  private autoLink: boolean;

  constructor(opts: { autoLink?: boolean } = {}) { this.autoLink = opts.autoLink ?? false; }

  async listInstitutions(_country: string): Promise<Institution[]> { return this.institutions; }

  async startConsent(_institutionId: string, redirectUrl: string, _reference: string) {
    const requisitionId = `stub-req-${++this.seq}`;
    this.requisitions.set(requisitionId, { state: { status: 'pending', consentExpiresAt: null, accounts: [] } });
    return { requisitionId, consentUrl: `${redirectUrl}${redirectUrl.includes('?') ? '&' : '?'}stub=${requisitionId}` };
  }

  /** Test helper: flip a requisition to linked with the given accounts. */
  linkRequisition(requisitionId: string, accounts: RequisitionState['accounts'], consentExpiresAt: string | null): void {
    const r = this.mustGet(requisitionId);
    r.state = { status: 'linked', consentExpiresAt, accounts };
  }

  /** Test helper: force a status (e.g. 'expired'). */
  setStatus(requisitionId: string, status: RequisitionState['status']): void {
    this.mustGet(requisitionId).state.status = status;
  }

  async getRequisition(requisitionId: string): Promise<RequisitionState> {
    const r = this.mustGet(requisitionId);
    if (this.autoLink && r.state.status === 'pending') {
      const acc = `stub-acc-${requisitionId}`;
      this.linkRequisition(requisitionId, [{ providerAccountId: acc, iban: 'LV97STUB0000000000001', currency: 'EUR' }], '2026-10-17T00:00:00Z');
      this.transactionsByAccount.set(acc, [
        { bookingDate: '2026-07-10', amount: '121.00', currency: 'EUR', reference: 'INV-2026-001', counterparty: 'SIA Klients', endToEndId: 'INV-2026-001', providerTxId: `${acc}-1` },
        { bookingDate: '2026-07-12', amount: '-60.50', currency: 'EUR', reference: 'PO-77', counterparty: 'SIA Piegādātājs', endToEndId: '', providerTxId: `${acc}-2` },
      ]);
    }
    return this.mustGet(requisitionId).state;
  }

  async fetchTransactions(providerAccountId: string, fromDate: string): Promise<FeedTxn[]> {
    const err = this.fetchErrors.get(providerAccountId);
    if (err) throw new Error(err);
    return (this.transactionsByAccount.get(providerAccountId) ?? []).filter((t) => t.bookingDate >= fromDate);
  }

  async deleteRequisition(requisitionId: string): Promise<void> { this.deleted.push(requisitionId); }

  private mustGet(requisitionId: string): StubRequisition {
    const r = this.requisitions.get(requisitionId);
    if (!r) throw new Error(`stub requisition not found: ${requisitionId}`);
    return r;
  }
}
