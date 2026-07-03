import { requireSession } from '@/app/lib/require-session';
import { AppShell } from '@/app/components/AppShell';

export default async function CabinetLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();
  return <AppShell role={session.role}>{children}</AppShell>;
}
