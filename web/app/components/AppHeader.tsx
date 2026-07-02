'use client';

import styles from './AppHeader.module.css';

export interface AppHeaderProps {
  clients: { id: string; name: string; regNo: string; baseCurrency: string }[];
  selectedClientId: string | null;
  onSelectClient: (id: string) => void;
  role: string | null;
  language?: string; // default 'LV'
}

export function AppHeader({
  clients,
  selectedClientId,
  onSelectClient,
  role,
  language = 'LV',
}: AppHeaderProps) {
  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <span className={styles.appName}>Bookkeeping Cabinet</span>
      </div>

      <div className={styles.switcher}>
        {clients.length > 0 ? (
          <>
            <label htmlFor="client-switcher" className={styles.switcherLabel}>
              Client
            </label>
            <select
              id="client-switcher"
              className={styles.switcherSelect}
              value={selectedClientId ?? ''}
              onChange={(e) => onSelectClient(e.target.value)}
            >
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.regNo}
                </option>
              ))}
            </select>
          </>
        ) : (
          <span className={styles.noClients}>No clients assigned</span>
        )}
      </div>

      <div className={styles.meta}>
        {role && <span className={styles.role}>{role}</span>}
        <span className={styles.lang}>{language}</span>
      </div>
    </header>
  );
}
