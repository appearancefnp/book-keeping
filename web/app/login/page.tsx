import { LanguageProvider } from '@/app/lib/i18n-context';
import { LoginForm } from './login-form';
import styles from './login.module.css';

export const metadata = {
  title: 'Sign in — Bookkeeping Cabinet',
};

export default function LoginPage() {
  return (
    <LanguageProvider>
      <div className={styles.page}>
        <div className={styles.card}>
          <LoginTitle />
          <LoginForm />
        </div>
      </div>
    </LanguageProvider>
  );
}

// Server component can't use useMessages — render the title as a plain string.
// The i18n context is client-side only; the page title is set via metadata above.
function LoginTitle() {
  return <h1 className={styles.title}>Sign in</h1>;
}
