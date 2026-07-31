import { afterEach, expect, test } from 'vitest';
import { outboundInvoiceAccounts } from '../../src/einvoice/accounts.js';
import { getAccessPoint } from '../../src/einvoice/access-point-factory.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';

const ENV_KEYS = ['EINVOICE_RECEIVABLE_ACCOUNT', 'EINVOICE_SALES_ACCOUNT', 'EINVOICE_VAT_ACCOUNT'] as const;

afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });

test('outboundInvoiceAccounts falls back to the LR chart defaults', () => {
  expect(outboundInvoiceAccounts()).toEqual({ receivable: '2310', sales: '6110', vat: '5721' });
});

test('outboundInvoiceAccounts honours env overrides', () => {
  process.env.EINVOICE_RECEIVABLE_ACCOUNT = '1234';
  process.env.EINVOICE_SALES_ACCOUNT = '5678';
  process.env.EINVOICE_VAT_ACCOUNT = '9012';
  expect(outboundInvoiceAccounts()).toEqual({ receivable: '1234', sales: '5678', vat: '9012' });
});

test('getAccessPoint returns a stable singleton', () => {
  const a = getAccessPoint();
  const b = getAccessPoint();
  expect(a).toBe(b);
  expect(a).toBeInstanceOf(StubAccessPoint);
});
