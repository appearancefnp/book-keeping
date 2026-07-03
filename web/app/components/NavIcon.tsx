// Monochrome line icons for the sidebar, matching the stroked-SVG convention
// used across RationaleBlock/PostingLines/EmptyState (currentColor, ~1.5px).
// Replaces the earlier emoji glyphs, which read as a foreign icon family.

export type NavIconName =
  | 'queue'
  | 'documents'
  | 'overview'
  | 'tasks'
  | 'notifications'
  | 'admin';

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
