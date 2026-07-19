/** Dev bootstrap (migrate+seed+sign-in) must never run in production or on Vercel. */
export function devBootstrapAllowed(env: { NODE_ENV?: string; VERCEL_ENV?: string }): boolean {
  return env.NODE_ENV !== 'production' && !env.VERCEL_ENV;
}
