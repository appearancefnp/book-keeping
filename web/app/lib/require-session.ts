import { redirect } from 'next/navigation';
import { validateSession } from '@domain/auth/sessions.js';
import { getSessionToken, nowUnix } from './session';

export async function requireSession(): Promise<{ userId: string; firmId: string; role: string }> {
  const token = await getSessionToken();
  const session = token ? await validateSession(token, nowUnix()) : null;
  if (!session) redirect('/login');
  return session;
}
