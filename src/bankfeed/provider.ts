export interface Institution { id: string; name: string; logoUrl?: string }

/** One bank transaction as the feed provider reports it, before normalization. */
export interface FeedTxn {
  bookingDate: string;   // ISO date
  amount: string;        // SIGNED decimal string, e.g. "-12.50" (negative = money out)
  currency: string;
  reference: string;
  counterparty: string;
  endToEndId: string;    // '' when the bank omits it
  providerTxId: string;  // provider-stable id, always present
}

export type FeedConnectionStatus = 'pending' | 'linked' | 'expired' | 'revoked';

export interface RequisitionState {
  status: FeedConnectionStatus;
  consentExpiresAt: string | null; // ISO timestamp
  accounts: { providerAccountId: string; iban: string; currency: string }[];
}

/**
 * Open-banking feed provider seam (mirrors AccessPoint / VidClient).
 * Real impl: GoCardlessProvider. Tests/dev: StubBankFeedProvider.
 */
export interface BankFeedProvider {
  readonly name: string; // 'gocardless' | 'stub' — stored on the connection row
  listInstitutions(country: string): Promise<Institution[]>;
  startConsent(institutionId: string, redirectUrl: string, reference: string): Promise<{ requisitionId: string; consentUrl: string }>;
  getRequisition(requisitionId: string): Promise<RequisitionState>;
  fetchTransactions(providerAccountId: string, fromDate: string): Promise<FeedTxn[]>;
  deleteRequisition(requisitionId: string): Promise<void>; // best-effort cleanup
}
