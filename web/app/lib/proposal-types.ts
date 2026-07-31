export type ProposalType = 'posting' | 'bank_match' | 'declaration' | 'task' | 'ecsl' | 'recurring_invoice';

export interface Rationale {
  ruleRef?: string;
  computation?: string;
  sourceRefs?: unknown;
  // low-confidence / flags may live in sourceRefs or at top-level; keep flexible
}

export interface PostingLine {
  accountCode: string;
  debit: string;
  credit: string;
}

export interface PostingPayload {
  date?: string;
  currency?: string;
  memo?: string;
  lines?: PostingLine[];
}

export interface Proposal {
  id: string;
  type: ProposalType;
  status: string;
  payload: unknown;
  rationale: Rationale;
  documentId: string | null;
  resolvedEntryId: string | null;
  rejectReason: string | null;
  createdAt?: string;
}

// Type guard for posting payloads
export function asPostingPayload(payload: unknown): PostingPayload | null {
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if (Array.isArray(p['lines'])) return p as PostingPayload;
    // still allow memo/date-only postings
    if ('memo' in p || 'date' in p || 'lines' in p) return p as PostingPayload;
  }
  return null;
}

export interface BankMatchPayload {
  amountCents?: string;
  bankAccount?: string;
  receivablesAccount?: string;
}

// Type guard for bank-match payloads (settling a bank line against a ledger entry)
export function asBankMatchPayload(payload: unknown): BankMatchPayload | null {
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if ('amountCents' in p || 'bankAccount' in p || 'receivablesAccount' in p) {
      return p as BankMatchPayload;
    }
  }
  return null;
}

export interface DeclarationPayload {
  period?: { fromDate?: string; toDate?: string };
  ruleRef?: { value?: string; ruleType?: string; effectiveFrom?: string };
  inputVat?: string;
  outputVat?: string;
  netPayable?: string;
}

// Type guard for VAT declaration payloads
export function asDeclarationPayload(payload: unknown): DeclarationPayload | null {
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if ('netPayable' in p || 'outputVat' in p || 'inputVat' in p || 'period' in p) {
      return p as DeclarationPayload;
    }
  }
  return null;
}
