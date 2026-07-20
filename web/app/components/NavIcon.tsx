// Monochrome line icons for the sidebar, matching the stroked-SVG convention
// used across RationaleBlock/PostingLines/EmptyState (currentColor, ~1.5px).
// Replaces the earlier emoji glyphs, which read as a foreign icon family.

export type NavIconName =
  | 'queue'
  | 'documents'
  | 'overview'
  | 'tasks'
  | 'notifications'
  | 'admin'
  | 'parties'
  | 'invoices'
  | 'bank'
  | 'journal'
  | 'payroll'
  | 'settings'
  | 'reports'
  | 'bills'
  | 'expenses';

const PATHS: Record<NavIconName, React.ReactNode> = {
  // Checklist / approval queue
  queue: (
    <>
      <path d="M8 5.5h9M8 10h9M8 14.5h9" strokeLinecap="round" />
      <path d="M3.5 5.5l1 1 1.5-1.75M3.5 10l1 1 1.5-1.75M3.5 14.5l1 1 1.5-1.75" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // Document
  documents: (
    <path
      d="M6 2.75h5.5L16 7.25V17a1.25 1.25 0 01-1.25 1.25h-8.5A1.25 1.25 0 015 17V4A1.25 1.25 0 016 2.75zM11.25 3v4h4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  // Bar chart / overview
  overview: (
    <>
      <path d="M3.5 16.5h13" strokeLinecap="round" />
      <path d="M6 16.5v-4M10 16.5v-8M14 16.5v-5.5" strokeLinecap="round" />
    </>
  ),
  // Checkmark circle / tasks
  tasks: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M6.75 10.25l2 2 4.5-4.75" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // Bell / notifications
  notifications: (
    <path
      d="M10 3.25a4 4 0 00-4 4c0 3.5-1.25 4.75-1.75 5.5h11.5C15.25 12 14 10.75 14 7.25a4 4 0 00-4-4zM8.5 15.5a1.5 1.5 0 003 0"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  // Gear / admin
  admin: (
    <>
      <circle cx="10" cy="10" r="2.25" />
      <path
        d="M10 2.75l.9 1.9 2-.55.35 2.05 1.95.75-.95 1.85.95 1.85-1.95.75-.35 2.05-2-.55-.9 1.9-.9-1.9-2 .55-.35-2.05-1.95-.75.95-1.85-.95-1.85 1.95-.75.35-2.05 2 .55z"
        strokeLinejoin="round"
      />
    </>
  ),
  // Invoice: document with ruled lines
  invoices: (
    <>
      <path d="M5.5 2.75h9A1.25 1.25 0 0115.75 4v13.25l-2.25-1.5-1.75 1.5-1.75-1.5-1.75 1.5-2.25-1.5V4A1.25 1.25 0 015.5 2.75z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.5 6.5h5M7.5 9.25h5M7.5 12h3" strokeLinecap="round" />
    </>
  ),
  // Two-person silhouette / parties
  parties: (
    <>
      <circle cx="7.5" cy="7" r="2.5" />
      <path d="M3.5 16.5c0-2.5 1.8-4 4-4s4 1.5 4 4" strokeLinecap="round" />
      <circle cx="13.75" cy="7.75" r="2" />
      <path d="M13 12.75c2 0 3.5 1.4 3.5 3.5" strokeLinecap="round" />
    </>
  ),
  // Bank: pediment + columns
  bank: (
    <>
      <path d="M3.5 8h13L10 3.5 3.5 8z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.5 8v6M10 8v6M14.5 8v6" strokeLinecap="round" />
      <path d="M3.5 16.5h13" strokeLinecap="round" />
    </>
  ),
  // Open ledger book
  journal: (
    <>
      <path d="M10 4.5c-1.5-1.2-3.5-1.5-6-1.2V15c2.5-.3 4.5 0 6 1.2 1.5-1.2 3.5-1.5 6-1.2V3.3c-2.5-.3-4.5 0-6 1.2z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 4.5v11.7" strokeLinecap="round" />
    </>
  ),
  // Sliders / settings
  settings: (
    <>
      <path d="M3.5 6h13M3.5 10h13M3.5 14h13" strokeLinecap="round" />
      <circle cx="8" cy="6" r="1.75" fill="var(--surface, #fff)" />
      <circle cx="12.5" cy="10" r="1.75" fill="var(--surface, #fff)" />
      <circle cx="6.5" cy="14" r="1.75" fill="var(--surface, #fff)" />
    </>
  ),
  // Payroll — stylised payslip with a coin
  payroll: (
    <>
      <path d="M4 4.75h9.5A1.25 1.25 0 0114.75 6v9.25A1.25 1.25 0 0113.5 16.5H4A1.25 1.25 0 012.75 15.25V6A1.25 1.25 0 014 4.75z" strokeLinejoin="round" />
      <path d="M5.5 8h6M5.5 11h3.5" strokeLinecap="round" />
      <circle cx="14" cy="13" r="3.25" />
      <path d="M14 11.75v2.5M12.9 13h2.2" strokeLinecap="round" />
    </>
  ),
  // Reports / financial statements (trend line on axes)
  reports: (
    <>
      <path d="M4 4v12h12" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7 12l3-3 2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // Bills / accounts payable — inbox tray receiving an incoming bill
  bills: (
    <>
      <path d="M3.5 12v3.25c0 .69.56 1.25 1.25 1.25h10.5c.69 0 1.25-.56 1.25-1.25V12" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.5 12h3.75l1.25 2h2.5l1.25-2h3.75" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 3.25v7.5M7 8l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // Expense claims — a receipt (curled bottom edge) with a coin, mirrors payroll's payslip+coin idiom
  expenses: (
    <>
      <path d="M5.5 2.75h9v13.3l-1.4-1-1.4 1-1.4-1-1.4 1-1.4-1-1.4 1-1.4-1z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.25 6h5.5M7.25 8.5h3.5" strokeLinecap="round" />
      <circle cx="14" cy="13" r="2.75" fill="var(--surface, #fff)" />
      <path d="M14 11.9v2.2M13.1 13h1.8" strokeLinecap="round" />
    </>
  ),
};

export function NavIcon({ name }: { name: NavIconName }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
