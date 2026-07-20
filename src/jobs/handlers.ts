import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export type JobHandler = (
  tx: PoolClient, ctx: TenantContext, payload: Record<string, unknown>,
) => Promise<void>;

const handlers = new Map<string, JobHandler>();

export function registerHandler(type: string, fn: JobHandler): void {
  handlers.set(type, fn);
}

export function getHandler(type: string): JobHandler | undefined {
  return handlers.get(type);
}
