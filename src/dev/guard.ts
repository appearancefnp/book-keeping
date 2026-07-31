/**
 * Dev bootstrap (migrate + seed + sign-in) must never run against real data. The route
 * is unauthenticated and signs the caller in as a known demo user, so the guard is a
 * positive opt-in: DEV_ROUTES_ENABLED=1 is required, and production or any Vercel
 * environment still vetoes. Off Vercel, NODE_ENV was previously the only signal — a
 * container missing NODE_ENV=production would have opened the route on real books.
 */
export function devBootstrapAllowed(
  env: { NODE_ENV?: string; VERCEL_ENV?: string; DEV_ROUTES_ENABLED?: string },
): boolean {
  if (env.DEV_ROUTES_ENABLED !== '1') return false;
  return env.NODE_ENV !== 'production' && !env.VERCEL_ENV;
}
