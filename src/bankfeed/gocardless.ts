import type { BankFeedProvider, FeedTxn, Institution, RequisitionState, FeedConnectionStatus } from './provider.js';

const BASE = 'https://bankaccountdata.gocardless.com/api/v2';

// GoCardless requisition statuses: CR created, GC giving consent, UA undergoing
// authentication, GA granting access, SA selecting accounts, LN linked,
// EX expired, RJ rejected, SU suspended.
export function mapRequisitionStatus(gc: string): FeedConnectionStatus {
  if (gc === 'LN') return 'linked';
  if (gc === 'EX') return 'expired';
  if (gc === 'RJ' || gc === 'SU') return 'revoked';
  return 'pending';
}

export interface GcBookedTransaction {
  transactionId?: string;
  internalTransactionId?: string;
  bookingDate?: string;
  transactionAmount?: { amount?: string; currency?: string };
  remittanceInformationUnstructured?: string;
  remittanceInformationUnstructuredArray?: string[];
  endToEndId?: string;
  debtorName?: string;
  creditorName?: string;
}

export function mapBookedTransaction(t: GcBookedTransaction): FeedTxn {
  const amount = t.transactionAmount?.amount ?? '0';
  const debit = amount.startsWith('-');
  return {
    bookingDate: t.bookingDate ?? '',
    amount,
    currency: t.transactionAmount?.currency ?? 'EUR',
    reference: t.remittanceInformationUnstructured ?? (t.remittanceInformationUnstructuredArray ?? []).join(' '),
    counterparty: (debit ? t.creditorName : t.debtorName) ?? '',
    endToEndId: t.endToEndId ?? '',
    providerTxId: t.transactionId ?? t.internalTransactionId ?? '',
  };
}

export function consentExpiry(accepted: string | null, accessValidForDays: number | null): string | null {
  if (!accepted || !accessValidForDays) return null;
  const d = new Date(accepted);
  d.setUTCDate(d.getUTCDate() + accessValidForDays);
  return d.toISOString();
}

/** All failures throw Errors prefixed `bank feed provider` — the routes map that prefix to HTTP 502. */
export class GoCardlessProvider implements BankFeedProvider {
  readonly name = 'gocardless';
  private token: { access: string; expiresAt: number } | null = null;
  constructor(private secretId: string, private secretKey: string) {}

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.access;
    const res = await fetch(`${BASE}/token/new/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret_id: this.secretId, secret_key: this.secretKey }),
    });
    if (!res.ok) throw new Error(`bank feed provider: token request failed (${res.status})`);
    const body = (await res.json()) as { access: string; access_expires: number };
    this.token = { access: body.access, expiresAt: Date.now() + (body.access_expires - 60) * 1000 };
    return this.token.access;
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.accessToken();
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`bank feed provider: ${init?.method ?? 'GET'} ${path} failed (${res.status}) ${detail.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  async listInstitutions(country: string): Promise<Institution[]> {
    const list = await this.api<{ id: string; name: string; logo?: string }[]>(`/institutions/?country=${encodeURIComponent(country)}`);
    return list.map((i) => ({ id: i.id, name: i.name, logoUrl: i.logo }));
  }

  async startConsent(institutionId: string, redirectUrl: string, reference: string) {
    const req = await this.api<{ id: string; link: string }>('/requisitions/', {
      method: 'POST',
      body: JSON.stringify({ institution_id: institutionId, redirect: redirectUrl, reference }),
    });
    return { requisitionId: req.id, consentUrl: req.link };
  }

  async getRequisition(requisitionId: string): Promise<RequisitionState> {
    const req = await this.api<{ status: string; accounts: string[]; agreement?: string }>(`/requisitions/${requisitionId}/`);
    const status = mapRequisitionStatus(req.status);
    let consentExpiresAt: string | null = null;
    if (req.agreement) {
      const agr = await this.api<{ accepted?: string | null; access_valid_for_days?: number }>(`/agreements/enduser/${req.agreement}/`);
      consentExpiresAt = consentExpiry(agr.accepted ?? null, agr.access_valid_for_days ?? null);
    }
    const accounts: RequisitionState['accounts'] = [];
    if (status === 'linked') {
      for (const accountId of req.accounts) {
        const det = await this.api<{ account?: { iban?: string; currency?: string } }>(`/accounts/${accountId}/details/`);
        accounts.push({ providerAccountId: accountId, iban: det.account?.iban ?? '', currency: det.account?.currency ?? 'EUR' });
      }
    }
    return { status, consentExpiresAt, accounts };
  }

  async fetchTransactions(providerAccountId: string, fromDate: string): Promise<FeedTxn[]> {
    const body = await this.api<{ transactions?: { booked?: GcBookedTransaction[] } }>(
      `/accounts/${providerAccountId}/transactions/?date_from=${encodeURIComponent(fromDate)}`);
    return (body.transactions?.booked ?? []).map(mapBookedTransaction);
  }

  async deleteRequisition(requisitionId: string): Promise<void> {
    await this.api(`/requisitions/${requisitionId}/`, { method: 'DELETE' });
  }
}
