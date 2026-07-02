'use client';

import { useState } from 'react';
import type { Proposal } from '../lib/proposal-types';
import { asPostingPayload } from '../lib/proposal-types';
import { StatusBadge } from './StatusBadge';
import { PostingLines } from './PostingLines';
import { RationaleBlock } from './RationaleBlock';
import styles from './ProposalCard.module.css';

export interface ProposalCardProps {
  proposal: Proposal;
  onApprove: (id: string) => void | Promise<void>;
  onReject: (id: string, reason: string) => void | Promise<void>;
  busy?: boolean;
  leaving?: boolean;
}

function formatCreatedAt(iso: string): string {
  try {
    return new Intl.DateTimeFormat('lv-LV', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function renderUnknownPayload(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

export function ProposalCard({
  proposal,
  onApprove,
  onReject,
  busy = false,
  leaving = false,
}: ProposalCardProps) {
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  const postingPayload =
    proposal.type === 'posting' ? asPostingPayload(proposal.payload) : null;

  function handleApprove() {
    if (!busy) onApprove(proposal.id);
  }

  function handleRejectConfirm() {
    if (!busy) {
      onReject(proposal.id, rejectReason);
      setRejectOpen(false);
      setRejectReason('');
    }
  }

  function handleRejectCancel() {
    setRejectOpen(false);
    setRejectReason('');
  }

  return (
    <article
      className={[styles.card, leaving ? styles.leaving : ''].filter(Boolean).join(' ')}
      aria-label={`Proposal ${proposal.id}`}
    >
      {/* Header */}
      <div className={styles.header}>
        <StatusBadge type={proposal.type} />
        {proposal.createdAt && (
          <time
            dateTime={proposal.createdAt}
            className={styles.createdAt}
          >
            {formatCreatedAt(proposal.createdAt)}
          </time>
        )}
      </div>

      {/* Payload / draft section */}
      <div className={styles.payload}>
        {postingPayload ? (
          <PostingLines payload={postingPayload} />
        ) : (
          <div className={styles.rawPayload}>
            <p className={styles.rawPayloadLabel}>Payload</p>
            <pre className={styles.rawPayloadPre}>
              {renderUnknownPayload(proposal.payload)}
            </pre>
          </div>
        )}
      </div>

      {/* Rationale — the core differentiator */}
      <RationaleBlock rationale={proposal.rationale} />

      {/* Actions */}
      <div className={styles.actions}>
        {!rejectOpen ? (
          <>
            <button
              type="button"
              className={styles.btnApprove}
              onClick={handleApprove}
              disabled={busy}
              aria-busy={busy}
            >
              {busy ? 'Approving…' : 'Approve'}
            </button>
            <button
              type="button"
              className={styles.btnReject}
              onClick={() => setRejectOpen(true)}
              disabled={busy}
            >
              Reject
            </button>
          </>
        ) : (
          <div className={styles.rejectPanel}>
            <label htmlFor={`reject-reason-${proposal.id}`} className={styles.rejectLabel}>
              Reason for rejection <span className={styles.rejectOptional}>(optional)</span>
            </label>
            <textarea
              id={`reject-reason-${proposal.id}`}
              className={styles.rejectTextarea}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Describe why this proposal is being rejected…"
              rows={3}
              disabled={busy}
            />
            <div className={styles.rejectActions}>
              <button
                type="button"
                className={styles.btnConfirmReject}
                onClick={handleRejectConfirm}
                disabled={busy}
                aria-busy={busy}
              >
                {busy ? 'Rejecting…' : 'Confirm rejection'}
              </button>
              <button
                type="button"
                className={styles.btnCancel}
                onClick={handleRejectCancel}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}
