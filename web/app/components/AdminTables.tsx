'use client';

import { useMessages } from '@/app/lib/i18n-context';
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

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

// ── Clients table ─────────────────────────────────────────────────────────────

function ClientsTable({ clients }: { clients: ClientCompany[] }) {
  const { t } = useMessages();
  if (clients.length === 0) {
    return <EmptyState message="No clients found." detail="No client companies are registered for this firm." />;
  }
  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{t('top.client')}</th>
            <th scope="col">{t('admin.regNo')}</th>
            <th scope="col" className={styles.colCurrency}>Currency</th>
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
    return <EmptyState message="No users found." detail="No users are registered for this firm." />;
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
              <td className={styles.role}>{u.role}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Audit table ───────────────────────────────────────────────────────────────

function AuditTable({ audit }: { audit: AuditRow[] }) {
  const { t } = useMessages();
  if (audit.length === 0) {
    return <EmptyState message="No audit entries." detail="No activity has been recorded for this client yet." />;
  }
  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Action</th>
            <th scope="col">Entity type</th>
            <th scope="col">Actor</th>
            <th scope="col" className={styles.colDate}>{t('admin.audit')}</th>
          </tr>
        </thead>
        <tbody>
          {audit.map((row, i) => (
            <tr key={i}>
              <td className={styles.mono}>{row.action}</td>
              <td>{row.entityType}</td>
              <td className={styles.mono}>{row.actorId}</td>
              <td className={styles.colDate}>{fmtDate(row.createdAt)}</td>
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
        <AuditTable audit={audit} />
      </section>
    </div>
  );
}
