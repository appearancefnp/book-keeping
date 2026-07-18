'use client';

import { useState } from 'react';
import { useMessages } from '@/app/lib/i18n-context';
import type { ClientCompany } from './AdminTables';
import { ROLE_KEYS } from './AdminTables';
import styles from './AdminTables.module.css';

export interface InviteResult {
  inviteUrl: string;
  expiresAt: string;
}

const ROLE_OPTIONS = ['firm_admin', 'accountant', 'owner', 'employee'] as const;
type RoleOption = (typeof ROLE_OPTIONS)[number];

interface InviteUserPanelProps {
  clients: ClientCompany[];
  onInvited: (result: InviteResult) => void;
}

// Firm-admin-only form to invite a new user. The route itself enforces the
// `users.write` permission server-side regardless of this UI gate — the
// parent only renders this panel for firm_admin viewers (defence in depth).
export function InviteUserPanel({ clients, onInvited }: InviteUserPanelProps) {
  const { t } = useMessages();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<RoleOption>('accountant');
  const [selectedClients, setSelectedClients] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  function toggleClient(id: string) {
    setSelectedClients((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  }

  async function submit() {
    if (!email.trim()) {
      setError(true);
      return;
    }
    setBusy(true);
    setError(false);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, role, clientCompanyIds: selectedClients }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as InviteResult;
      setEmail('');
      setSelectedClients([]);
      onInvited(data);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.invitePanel}>
      <h3 className={styles.inviteHeading}>{t('admin.inviteUser')}</h3>
      <div className={styles.inviteForm}>
        <label className={styles.inviteField}>
          {t('admin.inviteEmail')}
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
          />
        </label>
        <label className={styles.inviteField}>
          {t('admin.inviteRole')}
          <select value={role} onChange={(e) => setRole(e.target.value as RoleOption)} disabled={busy}>
            {ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {t(ROLE_KEYS[r]!)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={submit} disabled={busy || !email.trim()}>
          {t('admin.inviteCreate')}
        </button>
      </div>
      {clients.length > 0 && (
        <fieldset className={styles.inviteClients}>
          <legend>{t('admin.inviteClients')}</legend>
          {clients.map((c) => (
            <label key={c.id} className={styles.inviteCheckbox}>
              <input
                type="checkbox"
                checked={selectedClients.includes(c.id)}
                onChange={() => toggleClient(c.id)}
                disabled={busy}
              />
              {c.name}
            </label>
          ))}
        </fieldset>
      )}
      {error && (
        <p className={styles.error} role="status" aria-live="polite">
          {t('admin.onb.error')}
        </p>
      )}
    </div>
  );
}

// Shown once, immediately after an invite is created or reset — the caller
// holds the result in plain component state so it is never re-rendered
// after a reload or navigation away from the page.
export function InviteLinkDisplay({ invite }: { invite: InviteResult }) {
  const { t } = useMessages();
  const fullUrl = typeof window !== 'undefined' ? `${window.location.origin}${invite.inviteUrl}` : invite.inviteUrl;

  async function copy() {
    try {
      await navigator.clipboard.writeText(fullUrl);
    } catch {
      // Clipboard access can be denied by the browser; the link is still
      // selectable/readable from the input, so this is not fatal.
    }
  }

  return (
    <div className={styles.inviteLink}>
      <label className={styles.inviteLinkLabel} htmlFor="invite-link-input">
        {t('admin.inviteLink')}
      </label>
      <div className={styles.inviteLinkRow}>
        <input id="invite-link-input" className={styles.inviteLinkInput} readOnly value={fullUrl} />
        <button type="button" onClick={copy}>
          {t('admin.inviteCopy')}
        </button>
      </div>
    </div>
  );
}
