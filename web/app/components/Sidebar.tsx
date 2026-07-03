'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import styles from './Sidebar.module.css';

interface NavItem {
  key: 'nav.queue' | 'nav.documents' | 'nav.overview' | 'nav.tasks' | 'nav.notifications' | 'nav.admin';
  href: string;
  icon: string;
}

const BASE_ITEMS: NavItem[] = [
  { key: 'nav.queue',          href: '/',              icon: '◉' },
  { key: 'nav.documents',      href: '/documents',     icon: '📄' },
  { key: 'nav.overview',       href: '/overview',      icon: '📊' },
  { key: 'nav.tasks',          href: '/tasks',         icon: '✓' },
  { key: 'nav.notifications',  href: '/notifications', icon: '🔔' },
];

const ADMIN_ITEM: NavItem = { key: 'nav.admin', href: '/admin', icon: '⚙' };

const ADMIN_ROLES = new Set(['accountant', 'firm_admin']);

interface SidebarProps {
  role: string;
}

export function Sidebar({ role }: SidebarProps) {
  const pathname = usePathname();
  const { t } = useMessages();

  const items = ADMIN_ROLES.has(role) ? [...BASE_ITEMS, ADMIN_ITEM] : BASE_ITEMS;

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
        {items.map(({ key, href, icon }) => {
          const active = isActive(href);
          return (
            <li key={href}>
              <Link
                href={href}
                className={`${styles.navLink}${active ? ` ${styles.navLinkActive}` : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                <span className={styles.icon} aria-hidden="true">{icon}</span>
                <span className={styles.label}>{t(key)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
