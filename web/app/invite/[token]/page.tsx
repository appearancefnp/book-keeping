import { LanguageProvider } from '@/app/lib/i18n-context';
import { InviteForm } from './invite-form';
import styles from './invite.module.css';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Activate account — Bookkeeping Cabinet' };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <LanguageProvider>
      <div className={styles.page}>
        <div className={styles.card}>
          <InviteForm token={token} />
        </div>
      </div>
    </LanguageProvider>
  );
}
