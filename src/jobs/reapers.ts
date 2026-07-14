import type { PoolClient } from 'pg';
import { withSupervisor } from '../db/pool.js';

export type Reaper = (tx: PoolClient, args: { now: Date }) => Promise<{ seeded: number }>;

const reapers: Reaper[] = [];

export function registerReaper(fn: Reaper): void {
  reapers.push(fn);
}

export function getReapers(): Reaper[] {
  return reapers;
}

/**
 * One reap sweep: run every registered reaper inside a single supervisor transaction and return
 * the total number of recovery jobs seeded. Reapers must be idempotent (at-least-once queue).
 */
export async function reapOnce(args: { now: Date }): Promise<{ seeded: number }> {
  return withSupervisor(async (tx) => {
    let seeded = 0;
    for (const reap of reapers) {
      const r = await reap(tx, args);
      seeded += r.seeded;
    }
    return { seeded };
  });
}
