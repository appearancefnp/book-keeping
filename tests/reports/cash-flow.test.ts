import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { cashFlow, classifyActivity } from '../../src/reports/cash-flow.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function chart(tx: import('pg').PoolClient, t: Awaited<ReturnType<typeof makeFirmAndClient>>) {
  await createAccount(tx, ctx(t), { code: '2620', name: 'Bank', type: 'asset' });           // cash (26)
  await createAccount(tx, ctx(t), { code: '2310', name: 'Debtors', type: 'asset' });         // operating wc
  await createAccount(tx, ctx(t), { code: '5310', name: 'Payables', type: 'liability' });     // operating wc
  await createAccount(tx, ctx(t), { code: '1210', name: 'Fixed assets', type: 'asset' });     // investing (12)
  await createAccount(tx, ctx(t), { code: '5110', name: 'Long-term loan', type: 'liability' });// financing (51)
  await createAccount(tx, ctx(t), { code: '3300', name: 'Share capital', type: 'equity' });   // financing (equity)
  await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });           // operating net profit
  await createAccount(tx, ctx(t), { code: '7710', name: 'Expenses', type: 'expense' });        // operating net profit
}

test('classifyActivity gates cash on asset type so a cash-prefixed non-asset is not mis-bucketed', () => {
  const cfg = { cash: ['26'], investing: ['12'], financing: ['51'] };
  expect(classifyActivity({ code: '2620', type: 'asset' }, cfg)).toBe('cash');
  // Non-asset codes that happen to start with a cash prefix must NOT become cash.
  expect(classifyActivity({ code: '2600', type: 'equity' }, cfg)).toBe('financing');
  expect(classifyActivity({ code: '2690', type: 'income' }, cfg)).toBe('operating');
  expect(classifyActivity({ code: '2695', type: 'expense' }, cfg)).toBe('operating');
  // Type-gated long-term buckets, and the operating residual.
  expect(classifyActivity({ code: '1210', type: 'asset' }, cfg)).toBe('investing');
  expect(classifyActivity({ code: '5110', type: 'liability' }, cfg)).toBe('financing');
  expect(classifyActivity({ code: '5310', type: 'liability' }, cfg)).toBe('operating'); // trade payable
  expect(classifyActivity({ code: '3300', type: 'equity' }, cfg)).toBe('financing');
});

test('cash flow classifies operating / investing / financing and reconciles', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await chart(tx, t);
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    const post = (date: string, memo: string, lines: { accountCode: string; debit: string; credit: string }[]) =>
      postEntry(tx, ctx(t), { date, memo, currency: 'EUR', lines });
    await post('2026-03-01', 'Capital', [{ accountCode: '2620', debit: '1000.00', credit: '0' }, { accountCode: '3300', debit: '0', credit: '1000.00' }]);
    await post('2026-03-02', 'Loan', [{ accountCode: '2620', debit: '500.00', credit: '0' }, { accountCode: '5110', debit: '0', credit: '500.00' }]);
    await post('2026-03-03', 'Buy asset', [{ accountCode: '1210', debit: '800.00', credit: '0' }, { accountCode: '2620', debit: '0', credit: '800.00' }]);
    await post('2026-03-10', 'Sale on credit', [{ accountCode: '2310', debit: '300.00', credit: '0' }, { accountCode: '6110', debit: '0', credit: '300.00' }]);
    await post('2026-03-15', 'Collect debtor', [{ accountCode: '2620', debit: '200.00', credit: '0' }, { accountCode: '2310', debit: '0', credit: '200.00' }]);
    await post('2026-03-18', 'Expense paid', [{ accountCode: '7710', debit: '120.00', credit: '0' }, { accountCode: '2620', debit: '0', credit: '120.00' }]);
    await post('2026-03-20', 'Expense on credit', [{ accountCode: '7710', debit: '60.00', credit: '0' }, { accountCode: '5310', debit: '0', credit: '60.00' }]);
  });

  const cf = await withTenant(ctx(t), (tx) => cashFlow(tx, ctx(t), { from: '2026-03-01', to: '2026-03-31' }));

  expect(cf.netProfit).toBe('120.00');            // sales 300 - expenses 180
  const debtors = cf.workingCapital.find((l) => l.code === '2310');
  const payables = cf.workingCapital.find((l) => l.code === '5310');
  expect(debtors?.amount).toBe('-100.00');        // net receivable increase ties up cash
  expect(payables?.amount).toBe('60.00');          // payable increase preserves cash
  expect(cf.operatingSubtotal).toBe('80.00');      // 120 - 40

  expect(cf.investing.find((l) => l.code === '1210')?.amount).toBe('-800.00');
  expect(cf.investingSubtotal).toBe('-800.00');

  expect(cf.financing.find((l) => l.code === '3300')?.amount).toBe('1000.00');
  expect(cf.financing.find((l) => l.code === '5110')?.amount).toBe('500.00');
  expect(cf.financingSubtotal).toBe('1500.00');

  expect(cf.netChange).toBe('780.00');
  expect(cf.openingCash).toBe('0.00');
  expect(cf.closingCash).toBe('780.00');
  expect(cf.reconciles).toBe(true);
});

test('opening cash reflects prior-period balances excluded from the period sections', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await chart(tx, t);
    await openPeriod(tx, ctx(t), { year: 2026, month: 2 });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    // February capital — before the reporting period
    await postEntry(tx, ctx(t), { date: '2026-02-10', memo: 'Capital', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '100.00', credit: '0' }, { accountCode: '3300', debit: '0', credit: '100.00' },
    ]});
    // March sale for cash
    await postEntry(tx, ctx(t), { date: '2026-03-10', memo: 'Sale', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '50.00', credit: '0' }, { accountCode: '6110', debit: '0', credit: '50.00' },
    ]});
  });

  const cf = await withTenant(ctx(t), (tx) => cashFlow(tx, ctx(t), { from: '2026-03-01', to: '2026-03-31' }));
  expect(cf.openingCash).toBe('100.00');    // February capital carried in
  expect(cf.financing).toHaveLength(0);     // the equity movement was in February, not this period
  expect(cf.netProfit).toBe('50.00');
  expect(cf.netChange).toBe('50.00');
  expect(cf.closingCash).toBe('150.00');
  expect(cf.reconciles).toBe(true);
});

test('empty ledger reconciles at zero', async () => {
  const t = await makeFirmAndClient();
  const cf = await withTenant(ctx(t), (tx) => cashFlow(tx, ctx(t), { from: '2026-03-01', to: '2026-03-31' }));
  expect(cf.netChange).toBe('0.00');
  expect(cf.openingCash).toBe('0.00');
  expect(cf.closingCash).toBe('0.00');
  expect(cf.workingCapital).toHaveLength(0);
  expect(cf.investing).toHaveLength(0);
  expect(cf.financing).toHaveLength(0);
  expect(cf.reconciles).toBe(true);
});
