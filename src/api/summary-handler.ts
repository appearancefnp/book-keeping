import { withTenant } from '../db/pool.js';
import { authed } from './handlers.js';
import type { AuthedRequest, ApiResponse } from './types.js';
import { listProposals } from '../proposals/proposals.js';
import { listTasks } from '../collab/tasks.js';
import { listDocuments } from '../documents/documents.js';

export function homeSummaryHandler(req: AuthedRequest): Promise<ApiResponse> {
  return authed(req, async (ctx) => {
    const summary = await withTenant(ctx, async (tx) => {
      const [pending, needsReview, openTasks] = await Promise.all([
        listProposals(tx, ctx, { status: 'pending_approval' }),
        listDocuments(tx, ctx, { status: 'needs_review' }),
        listTasks(tx, ctx, { status: 'open' }),
      ]);
      return { pendingApprovals: pending.length, documentsNeedingReview: needsReview.length, openTasks: openTasks.length };
    });
    return { status: 200, body: summary };
  });
}
