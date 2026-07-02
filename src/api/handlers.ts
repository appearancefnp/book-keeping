import { withTenant } from '../db/pool.js';
import { resolveTenantContext } from '../auth/context.js';
import type { AuthedRequest, ApiResponse } from './types.js';
import { listProposals, getProposal } from '../proposals/proposals.js';
import { approveProposal, rejectProposal } from '../proposals/lifecycle.js';
import { postApprovedPosting } from '../proposals/post-proposal.js';
import { postApprovedBankMatch } from '../banking/confirm-match.js';
import { trialBalance } from '../ledger/balances.js';

/** Wraps a handler: resolves auth+RBAC, maps errors to 401/403, else runs the body with a TenantContext. */
export async function authed(req: AuthedRequest, fn: (ctx: import('../tenancy/context.js').TenantContext) => Promise<ApiResponse>): Promise<ApiResponse> {
  let ctx;
  try {
    ctx = await resolveTenantContext(req.token, req.clientCompanyId, req.atUnixSeconds);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /session/i.test(msg) ? 401 : 403;
    return { status, body: { error: msg } };
  }
  return fn(ctx);
}

export function approvalQueueHandler(req: AuthedRequest): Promise<ApiResponse> {
  return authed(req, async (ctx) => {
    const proposals = await withTenant(ctx, (tx) => listProposals(tx, ctx, { status: 'pending_approval' }));
    return { status: 200, body: { proposals } };
  });
}

export function approveHandler(req: AuthedRequest): Promise<ApiResponse> {
  return authed(req, async (ctx) => {
    const id = req.params?.id;
    if (!id) return { status: 400, body: { error: 'missing proposal id' } };
    const result = await withTenant(ctx, async (tx) => {
      const prop = await getProposal(tx, ctx, id);
      await approveProposal(tx, ctx, id);
      // Dispatch to the correct post function by type.
      if (prop.type === 'posting') return postApprovedPosting(tx, ctx, id);
      if (prop.type === 'bank_match') return postApprovedBankMatch(tx, ctx, id);
      return { entryId: null }; // declaration/task: approval only, no ledger post here
    });
    return { status: 200, body: result };
  });
}

export function rejectHandler(req: AuthedRequest): Promise<ApiResponse> {
  return authed(req, async (ctx) => {
    const id = req.params?.id;
    if (!id) return { status: 400, body: { error: 'missing proposal id' } };
    const reason = (req.body as { reason?: string })?.reason ?? 'rejected';
    await withTenant(ctx, (tx) => rejectProposal(tx, ctx, id, reason));
    return { status: 200, body: { ok: true } };
  });
}

export function financialsHandler(req: AuthedRequest): Promise<ApiResponse> {
  return authed(req, async (ctx) => {
    const tb = await withTenant(ctx, (tx) => trialBalance(tx, ctx));
    return { status: 200, body: { trialBalance: tb } };
  });
}
