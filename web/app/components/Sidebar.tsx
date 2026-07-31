'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { NavIcon, type NavIconName } from './NavIcon';
import styles from './Sidebar.module.css';

interface NavItem {
  key: 'nav.home' | 'nav.queue' | 'nav.documents' | 'nav.overview' | 'nav.tasks' | 'nav.notifications' | 'nav.admin' | 'nav.parties' | 'nav.invoices' | 'nav.bills' | 'nav.bank' | 'nav.journal' | 'nav.payroll' | 'nav.settings' | 'nav.reports' | 'nav.expenses' | 'nav.filings';
  /** Compact label for the mobile bottom tab bar, where six full-length LV/RU labels can't fit. */
  shortKey: 'nav.short.home' | 'nav.short.queue' | 'nav.short.documents' | 'nav.short.overview' | 'nav.short.tasks' | 'nav.short.notifications' | 'nav.short.admin' | 'nav.short.parties' | 'nav.short.invoices' | 'nav.short.bills' | 'nav.short.bank' | 'nav.short.journal' | 'nav.short.payroll' | 'nav.short.settings' | 'nav.short.reports' | 'nav.short.expenses' | 'nav.short.filings';
  href: string;
  icon: NavIconName;
}

const BASE_ITEMS: NavItem[] = [
  { key: 'nav.queue',          shortKey: 'nav.short.queue',          href: '/',              icon: 'queue' },
  { key: 'nav.documents',      shortKey: 'nav.short.documents',      href: '/documents',     icon: 'documents' },
  { key: 'nav.invoices',       shortKey: 'nav.short.invoices',       href: '/invoices',      icon: 'invoices' },
  { key: 'nav.bills',          shortKey: 'nav.short.bills',          href: '/bills',         icon: 'bills' },
  { key: 'nav.expenses',       shortKey: 'nav.short.expenses',       href: '/expenses',      icon: 'expenses' },
  { key: 'nav.bank',           shortKey: 'nav.short.bank',           href: '/bank',          icon: 'bank' },
  { key: 'nav.journal',        shortKey: 'nav.short.journal',        href: '/journal',       icon: 'journal' },
  { key: 'nav.reports',        shortKey: 'nav.short.reports',        href: '/reports',       icon: 'reports' },
  { key: 'nav.filings',        shortKey: 'nav.short.filings',        href: '/filings',       icon: 'filings' },
  { key: 'nav.overview',       shortKey: 'nav.short.overview',       href: '/overview',      icon: 'overview' },
  { key: 'nav.tasks',          shortKey: 'nav.short.tasks',          href: '/tasks',         icon: 'tasks' },
  { key: 'nav.notifications',  shortKey: 'nav.short.notifications',  href: '/notifications', icon: 'notifications' },
  { key: 'nav.parties',        shortKey: 'nav.short.parties',        href: '/parties',       icon: 'parties' },
];

const ADMIN_ITEM: NavItem = { key: 'nav.admin', shortKey: 'nav.short.admin', href: '/admin', icon: 'admin' };

const ADMIN_ITEMS: NavItem[] = [
  { key: 'nav.payroll', shortKey: 'nav.short.payroll', href: '/payroll', icon: 'payroll' },
  { key: 'nav.settings', shortKey: 'nav.short.settings', href: '/settings', icon: 'settings' },
  ADMIN_ITEM,
];

const OWNER_ITEMS: NavItem[] = [
  { key: 'nav.home',          shortKey: 'nav.short.home',          href: '/',              icon: 'overview' },
  { key: 'nav.documents',     shortKey: 'nav.short.documents',     href: '/documents',     icon: 'documents' },
  { key: 'nav.expenses',      shortKey: 'nav.short.expenses',      href: '/expenses',      icon: 'expenses' },
  { key: 'nav.reports',       shortKey: 'nav.short.reports',       href: '/reports',       icon: 'reports' },
  { key: 'nav.filings',       shortKey: 'nav.short.filings',       href: '/filings',       icon: 'filings' },
  { key: 'nav.notifications', shortKey: 'nav.short.notifications', href: '/notifications', icon: 'notifications' },
];

const ADMIN_ROLES = new Set(['accountant', 'firm_admin']);

interface SidebarProps {
  role: string;
  unreadCount?: number;
}

export function Sidebar({ role, unreadCount = 0 }: SidebarProps) {
  const pathname = usePathname();
  const { t } = useMessages();

  const items = role === 'owner'
    ? OWNER_ITEMS
    : ADMIN_ROLES.has(role)
      ? [...BASE_ITEMS, ...ADMIN_ITEMS]
      : BASE_ITEMS;

  function isActive(href: string) {
    if (href === '/') return pathname === '/';
    return pathname.startsWith(href);
  }

  return (
    <nav className={styles.sidebar} aria-label="Main navigation">
      <div className={styles.brand}>
        <span className={styles.brandName}>Cabinet</span>
      </div>

      <ul className={styles.navList} role="list">
        {items.map(({ key, shortKey, href, icon }) => {
          const active = isActive(href);
          const isNotif = href === '/notifications';
          const label = t(key);
          const ariaLabel = isNotif && unreadCount > 0
            ? `${label} (${unreadCount} unread)`
            : label;

          return (
            <li key={href}>
              <Link
                href={href}
                className={`${styles.navLink}${active ? ` ${styles.navLinkActive}` : ''}`}
                aria-current={active ? 'page' : undefined}
                aria-label={ariaLabel}
              >
                <span className={styles.iconWrap}>
                  <NavIcon name={icon} />
                  {isNotif && unreadCount > 0 && (
                    <span className={styles.badge} aria-hidden="true">
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  )}
                </span>
                <span className={styles.label}>{label}</span>
                <span className={styles.labelShort} aria-hidden="true">{t(shortKey)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
