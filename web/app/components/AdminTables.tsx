'use client';

import { useMessages } from '@/app/lib/i18n-context';
import { LOCALE_FOR, type Lang, type MsgKey } from '@/app/lib/i18n';
import { EmptyState } from './EmptyState';
import styles from './AdminTables.module.css';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ClientCompany {
  id: string;
  firmId: string;
  name: string;
  regNo: string;
  baseCurrency: string;
}

export interface UserRow {
  id: string;
  firmId: string;
  email: string;
  role: string;
  language: string;
}

export interface AuditRow {
  action: string;
  entityType: string;
  entityId: string | null;
  actorId: string;
  createdAt: string;
}

interface AdminTablesProps {
  clients: ClientCompany[];
  users: UserRow[];
  audit: AuditRow[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string, lang: Lang): string {
  try {
    return new Date(iso).toLocaleDateString(LOCALE_FOR[lang], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

// Known machine values → message keys. Unknown values fall back to the raw
// string so new audit vocabulary degrades visibly instead of breaking.
const ROLE_KEYS: Record<string, MsgKey> = {
  accountant: 'role.accountant',
  firm_admin: 'role.firm_admin',
  owner: 'role.owner',
  employee: 'role.employee',
};

const ACTION_KEYS: Record<string, MsgKey> = {
  create: 'audit.action.create',
  update: 'audit.action.update',
  status: 'audit.action.status',
  resolve: 'audit.action.resolve',
  extract: 'audit.action.extract',
  import: 'audit.action.import',
  post: 'audit.action.post',
  posted: 'audit.action.posted',
  send: 'audit.action.send',
  set: 'audit.action.set',
  vid_submit: 'audit.action.vid_submit',
  assistant_answer: 'audit.action.assistant_answer',
  suggested: 'audit.action.suggested',
  pending_approval: 'audit.action.pending_approval',
  approved: 'audit.action.approved',
  rejected: 'audit.action.rejected',
};

const ENTITY_KEYS: Record<string, MsgKey> = {
  document: 'audit.entity.document',
  party: 'audit.entity.party',
  proposal: 'audit.entity.proposal',
  task: 'audit.entity.task',
  bank_statement: 'audit.entity.bank_statement',
  journal_entry: 'audit.entity.journal_entry',
  bank_match: 'audit.entity.bank_match',
  einvoice: 'audit.entity.einvoice',
  autonomy_policy: 'audit.entity.autonomy_policy',
  chat: 'audit.entity.chat',
  account: 'audit.entity.account',
  period: 'audit.entity.period',
  tariff: 'audit.entity.tariff',
};

function translated(map: Record<string, MsgKey>, raw: string, t: (k: MsgKey) => string): string {
  const key = map[raw];
  return key ? t(key) : raw;
}

// ── Clients table ─────────────────────────────────────────────────────────────

function ClientsTable({ clients }: { clients: ClientCompany[] }) {
  const { t } = useMessages();
  if (clients.length === 0) {
    return <EmptyState message={t('admin.noClients')} detail={t('admin.noClientsDetail')} />;
  }
  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{t('top.client')}</th>
            <th scope="col">{t('admin.regNo')}</th>
            <th scope="col" className={styles.colCurrency}>{t('admin.currency')}</th>
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td className={styles.mono}>{c.regNo}</td>
              <td className={styles.colCurrency}>{c.baseCurrency}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Users table ───────────────────────────────────────────────────────────────

function UsersTable({ users }: { users: UserRow[] }) {
  const { t } = useMessages();
  if (users.length === 0) {
    return <EmptyState message={t('admin.noUsers')} detail={t('admin.noUsersDetail')} />;
  }
  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{t('admin.email')}</th>
            <th scope="col">{t('admin.role')}</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.email}</td>
              <td className={styles.role}>{translated(ROLE_KEYS, u.role, t)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Audit table ───────────────────────────────────────────────────────────────

function AuditTable({ audit, users }: { audit: AuditRow[]; users: UserRow[] }) {
  const { t, lang } = useMessages();
  if (audit.length === 0) {
    return <EmptyState message={t('admin.noAudit')} detail={t('admin.noAuditDetail')} />;
  }
  // Resolve actor UUIDs to emails; a UUID means the user is no longer in the
  // firm's list — show a short fragment rather than the full opaque id.
  const emailById = new Map(users.map((u) => [u.id, u.email]));
  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{t('admin.action')}</th>
            <th scope="col">{t('admin.entityType')}</th>
            <th scope="col">{t('admin.actor')}</th>
            <th scope="col" className={styles.colDate}>{t('admin.date')}</th>
          </tr>
        </thead>
        <tbody>
          {audit.map((row, i) => (
            <tr key={i}>
              <td>{translated(ACTION_KEYS, row.action, t)}</td>
              <td>{translated(ENTITY_KEYS, row.entityType, t)}</td>
              <td>
                {emailById.get(row.actorId) ?? (
                  <code className={styles.mono}>{row.actorId.slice(0, 8)}…</code>
                )}
              </td>
              <td className={styles.colDate}>{fmtDate(row.createdAt, lang)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Default export ────────────────────────────────────────────────────────────

export function AdminTables({ clients, users, audit }: AdminTablesProps) {
  const { t } = useMessages();
  return (
    <div className={styles.sections}>
      <section className={styles.section} aria-labelledby="admin-clients-heading">
        <h2 id="admin-clients-heading" className={styles.sectionHeading}>{t('admin.clients')}</h2>
        <ClientsTable clients={clients} />
      </section>

      <section className={styles.section} aria-labelledby="admin-users-heading">
        <h2 id="admin-users-heading" className={styles.sectionHeading}>{t('admin.users')}</h2>
        <UsersTable users={users} />
      </section>

      <section className={styles.section} aria-labelledby="admin-audit-heading">
        <h2 id="admin-audit-heading" className={styles.sectionHeading}>{t('admin.audit')}</h2>
        <AuditTable audit={audit} users={users} />
      </section>
    </div>
  );
}
