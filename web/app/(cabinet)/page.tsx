import { requireSession } from '@/app/lib/require-session';
import { QueueView } from './QueueView';
import { OwnerHome } from './OwnerHome';

export default async function Page() {
  const { role } = await requireSession();
  return role === 'owner' ? <OwnerHome /> : <QueueView />;
}
