'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import styles from '../page.module.css';

function CallbackInner() {
  const { t } = useMessages();
  const router = useRouter();
  const searchParams = useSearchParams();
  const cid = searchParams.get('cid');
  const client = searchParams.get('client');
  const [state, setState] = useState<'working' | 'done' | 'fail'>('working');
  const [detail, setDetail] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    if (!cid || !client) {
      setState('fail');
      return;
    }
    ran.current = true;
    (async () => {
      try {
        const res = await fetch(`/api/bank/connections/${cid}/finalize`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientCompanyId: client }),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setState('done');
        setTimeout(() => router.replace(`/bank?client=${encodeURIComponent(client)}`), 1200);
      } catch (err) {
        setDetail((err as Error).message);
        setState('fail');
      }
    })();
  }, [cid, client, router]);

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 className={styles.pageHeading}>{t('bankfeedcb.title')}</h1>
        <section className={styles.card}>
          {state === 'working' && <p className={styles.hint} role="status">{t('bankfeedcb.working')}</p>}
          {state === 'done' && <p className={styles.okMsg} role="status">{t('bankfeedcb.done')}</p>}
          {state === 'fail' && (
            <>
              <p className={styles.formError} role="alert">{t('bankfeedcb.fail')}{detail ? ` — ${detail}` : ''}</p>
              <a className={styles.primaryBtn} href={client ? `/bank?client=${encodeURIComponent(client)}` : '/bank'}>
                {t('bankfeedcb.back')}
              </a>
            </>
          )}
        </section>
      </main>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={null}><CallbackInner /></Suspense>;
}
