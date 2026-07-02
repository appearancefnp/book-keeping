import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { createFirm, createClientCompany } from '../../src/tenancy/firms.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('creates a firm and returns its id', async () => {
  const firm = await createFirm('Acme Bookkeeping');
  expect(firm.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(firm.name).toBe('Acme Bookkeeping');
});

test('creates a client company under a firm', async () => {
  const firm = await createFirm('Acme Bookkeeping');
  const client = await createClientCompany(firm.id, { name: 'SIA Klients', regNo: '40000000000' });
  expect(client.firmId).toBe(firm.id);
  expect(client.regNo).toBe('40000000000');
  expect(client.baseCurrency).toBe('EUR');
});
