import { cookies } from 'next/headers';

export const SESSION_COOKIE = 'bk_session';

export async function getSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

export function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}
