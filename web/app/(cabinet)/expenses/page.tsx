import { requireSession } from '@/app/lib/require-session';
import { ExpensesClient } from './ExpensesClient';

// Mirrors web/app/(cabinet)/page.tsx: role is resolved server-side once (requireSession) and
// handed to the client component as a prop — there's no client-side "who am I" fetch in this
// codebase. /expenses is a single page shared by employee/owner (self-service) and
// accountant/firm_admin (firm-wide + reimbursement) — the client component reads `role` to
// decide which extras to render; every write is still independently re-enforced server-side.
export default async function Page() {
  const { role } = await requireSession();
  return <ExpensesClient role={role} />;
}
