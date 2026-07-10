'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import styles from './payroll.module.css';

/** Payroll sub-navigation. Preserves the ?client= param on every tab. */
export function PayrollTabs({ client }: { client: string | null }) {
  const pathname = usePathname();
  const { t } = useMessages();
  const q = client ? `?client=${encodeURIComponent(client)}` : '';
  const tabs: { href: string; label: string; match: (p: string) => boolean }[] = [
    { href: `/payroll${q}`, label: t('pay.tab.employees'), match: (p) => p === '/payroll' || p.startsWith('/payroll/employees') },
    { href: `/payroll/orders${q}`, label: t('pay.tab.orders'), match: (p) => p.startsWith('/payroll/orders') },
    { href: `/payroll/runs${q}`, label: t('pay.tab.runs'), match: (p) => p.startsWith('/payroll/runs') },
  ];
  return (
    <nav className={styles.tabs} aria-label={t('pay.title')}>
      {tabs.map((tab) => (
        <Link key={tab.href} href={tab.href}
          className={`${styles.tab}${tab.match(pathname) ? ` ${styles.tabActive}` : ''}`}
          aria-current={tab.match(pathname) ? 'page' : undefined}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
