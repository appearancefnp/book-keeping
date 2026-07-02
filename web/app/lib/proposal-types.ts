export type ProposalType = 'posting' | 'bank_match' | 'declaration' | 'task';

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
