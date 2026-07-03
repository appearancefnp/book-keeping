'use client';

import { useRouter } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { logout } from '@/app/lib/api-client';
import type { ClientCompany } from '@/app/lib/api-client';
import { LanguageSwitcher } from './LanguageSwitcher';
import styles from './TopBar.module.css';

interface TopBarProps {
  clients: ClientCompany[];
  activeClientId: string | null;
  onClientChange: (id: string) => void;
  role: string;
  onAsk: () => void;
}

export function TopBar({ clients, activeClientId, onClientChange, role, onAsk }: TopBarProps) {
  const { t } = useMessages();
  const router = useRouter();

  async function handleSignOut() {
    try {
      await logout();
    } catch {
      // Proceed to login regardless
    }
    router.push('/login');
  }

  return (
    <header className={styles.topBar}>
      {/* Client switcher */}
      <div className={styles.clientSwitcher}>
        {clients.length > 0 ? (
          <>
            <label htmlFor="top-client-switcher" className={styles.switcherLabel}>
              {t('top.client')}
            </label>
            <select
              id="top-client-switcher"
              className={styles.switcherSelect}
              value={activeClientId ?? ''}
              onChange={(e) => onClientChange(e.target.value)}
            >
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.regNo}
                </option>
              ))}
            </select>
          </>
        ) : null}
      </div>

      {/* Right-side controls */}
      <div className={styles.controls}>
        <LanguageSwitcher />

        <button
          type="button"
          className={styles.askBtn}
          onClick={onAsk}
          aria-label={t('top.ask')}
        >
          {t('top.ask')}
        </button>

        <div className={styles.userArea}>
          <span className={styles.roleTag}>{role}</span>
          <button
            type="button"
            className={styles.signOutBtn}
            onClick={handleSignOut}
          >
            {t('top.signOut')}
          </button>
        </div>
      </div>
    </header>
  );
}
