'use client';
import { useMessages } from '../lib/i18n-context';
import type { Lang } from '../lib/i18n';
import styles from './LanguageSwitcher.module.css';

const LANGS: { code: Lang; label: string }[] = [
  { code: 'lv', label: 'LV' },
  { code: 'en', label: 'EN' },
  { code: 'ru', label: 'RU' },
];

export function LanguageSwitcher() {
  const { lang, setLang } = useMessages();
  return (
    <div className={styles.switcher} role="group" aria-label="Language">
      {LANGS.map(({ code, label }) => (
        <button
          key={code}
          type="button"
          className={`${styles.btn}${lang === code ? ` ${styles.active}` : ''}`}
          aria-pressed={lang === code}
          onClick={() => setLang(code)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
