'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ChatPanel } from '@/app/components/ChatPanel';
import { useMessages } from '@/app/lib/i18n-context';
import styles from './page.module.css';

function AssistantPageInner() {
  const searchParams = useSearchParams();
  const { t } = useMessages();
  const clientCompanyId = searchParams.get('client');

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>{t('asst.title')}</h1>
      <div className={styles.panelWrap}>
        <ChatPanel clientCompanyId={clientCompanyId} />
      </div>
    </div>
  );
}

export default function AssistantPage() {
  return (
    <Suspense>
      <AssistantPageInner />
    </Suspense>
  );
}
