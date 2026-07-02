import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createFirm, createClientCompany } from '../../src/tenancy/firms.js';
import { createUser } from '../../src/auth/users.js';
import { totpCodeFor } from '../../src/auth/totp.js';
import { login } from '../../src/auth/sessions.js';
import { assignUserToClient } from '../../src/auth/context.js';
import { createProposal } from '../../src/proposals/proposals.js';
import { createTask } from '../../src/collab/tasks.js';
import { createDocument, setDocumentStatus } from '../../src/documents/documents.js';
import { homeSummaryHandler } from '../../src/api/summary-handler.js';

const NOW = 1_700_000_000;

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('home summary returns pending-approval, needs-review, and open-task counts', async () => {
  const firm = await createFirm('Firm');
  const client = await createClientCompany(firm.id, { name: 'SIA K', regNo: '40100000000' });
  const { id: userId, totpSecret } = await createUser({ firmId: firm.id, email: 'a@b.lv', password: 'password123', role: 'owner' });
  await assignUserToClient(userId, client.id);
  const { sessionToken } = await login('a@b.lv', 'password123', totpCodeFor(totpSecret, NOW), NOW);
  const cid = { firmId: firm.id, clientCompanyId: client.id, actorId: userId, actorRole: 'owner' };
  await withTenant(cid, async (tx) => {
    await createProposal(tx, cid, { type: 'posting', payload: {}, rationale: {}, status: 'pending_approval' });
    await createTask(tx, cid, { title: 'Missing contract' });
    const d = await createDocument(tx, cid, { source: 'mobile', storageKey: 'k', mime: 'image/jpeg', uploadedBy: userId });
    await setDocumentStatus(tx, cid, d.id, 'needs_review');
  });
  const res = await homeSummaryHandler({ token: sessionToken, clientCompanyId: client.id, atUnixSeconds: NOW });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ pendingApprovals: 1, documentsNeedingReview: 1, openTasks: 1 });
});
