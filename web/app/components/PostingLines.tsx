'use client';

import type { PostingPayload, PostingLine } from '../lib/proposal-types';
import { useMessages } from '../lib/i18n-context';
import styles from './PostingLines.module.css';

function formatAmount(value: string, currency?: string): string {
  const num = Number(value);
  if (isNaN(num)) return value;
  return new Intl.NumberFormat('lv-LV', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num) + (currency ? ` ${currency}` : '');
}

function sumLines(lines: PostingLine[], field: 'debit' | 'credit'): number {
  return lines.reduce((acc, line) => {
    const n = Number(line[field]);
    return acc + (isNaN(n) ? 0 : n);
  }, 0);
}

function formatTotal(amount: number, currency?: string): string {
  return new Intl.NumberFormat('lv-LV', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount) + (currency ? ` ${currency}` : '');
}

export function PostingLines({ payload }: { payload: PostingPayload }) {
  const { t } = useMessages();
  const { lines = [], memo, date, currency } = payload;

  const totalDebit = sumLines(lines, 'debit');
  const totalCredit = sumLines(lines, 'credit');
  const balanced = Math.abs(totalDebit - totalCredit) < 0.005;

  return (
    <div className={styles.root}>
      {(memo || date) && (
        <div className={styles.meta}>
          {date && (
            <span className={styles.metaItem}>
              <span className={styles.metaLabel}>{t('post.date')}</span>
              <span className={styles.metaValue}>{date}</span>
            </span>
          )}
          {memo && (
            <span className={styles.metaItem}>
              <span className={styles.metaLabel}>{t('post.memo')}</span>
              <span className={styles.metaValue}>{memo}</span>
            </span>
          )}
        </div>
      )}

      {lines.length > 0 && (
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col" className={styles.colAccount}>{t('over.account')}</th>
                <th scope="col" className={styles.colAmount}>{t('over.debit')}</th>
                <th scope="col" className={styles.colAmount}>{t('over.credit')}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, i) => (
                <tr key={i}>
                  <td className={styles.cellAccount}>{line.accountCode}</td>
                  <td className={styles.cellAmount}>
                    {line.debit && line.debit !== '0' && line.debit !== '0.00'
                      ? formatAmount(line.debit, currency)
                      : <span className={styles.nil}>—</span>}
                  </td>
                  <td className={styles.cellAmount}>
                    {line.credit && line.credit !== '0' && line.credit !== '0.00'
                      ? formatAmount(line.credit, currency)
                      : <span className={styles.nil}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className={styles.totalRow}>
                <td className={styles.totalLabel}>{t('post.total')}</td>
                <td className={styles.cellAmount}>{formatTotal(totalDebit, currency)}</td>
                <td className={styles.cellAmount}>{formatTotal(totalCredit, currency)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className={styles.balanceRow}>
        {balanced ? (
          <span className={styles.balanced}>
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M4.5 7l1.8 1.8L9.5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {t('post.balanced')}
          </span>
        ) : (
          <span className={styles.unbalanced}>
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M7 4v3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              <circle cx="7" cy="10" r="0.75" fill="currentColor"/>
            </svg>
            {t('post.notBalanced')}
          </span>
        )}
      </div>
    </div>
  );
}
