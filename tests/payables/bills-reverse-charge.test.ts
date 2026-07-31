import { expect, test } from 'vitest';
import { buildBillEntry, type NewBill } from '../../src/payables/bills.js';

const accounts = { vatInputAccount: '5722', vatOutputAccount: '5721', payablesAccount: '5310' };

const base: Omit<NewBill, 'lines'> = {
  vendorPartyId: '00000000-0000-0000-0000-000000000001',
  billNumber: 'B-1', issueDate: '2026-06-10', dueDate: '2026-07-10', currency: 'EUR',
};

function totals(entry: { lines: { accountCode: string; debit: string; credit: string }[] }) {
  const d = entry.lines.reduce((a, l) => a + Number(l.debit), 0);
  const c = entry.lines.reduce((a, l) => a + Number(l.credit), 0);
  return { debit: d.toFixed(2), credit: c.toFixed(2) };
}

test('a domestic standard-rated bill posts exactly as before', () => {
  const e = buildBillEntry({ ...base, lines: [
    { description: 'Goods', expenseAccount: '7710', net: '100.00', vatRate: 21, vat: '21.00' },
  ] }, accounts);
  expect(e.lines).toEqual([
    { accountCode: '7710', debit: '100.00', credit: '0', description: 'Goods' },
    { accountCode: '5722', debit: '21.00', credit: '0', description: 'VAT input' },
    { accountCode: '5310', debit: '0', credit: '121.00', description: 'Payable' },
  ]);
});

test('a deductible reverse-charge line self-assesses both legs and nets to zero VAT', () => {
  const e = buildBillEntry({ ...base, lines: [
    { description: 'EU service', expenseAccount: '7710', net: '1000.00', vatRate: 21, vat: '0.00', vatCategory: 'AE' },
  ] }, accounts);
  expect(e.lines).toEqual([
    { accountCode: '7710', debit: '1000.00', credit: '0', description: 'EU service' },
    { accountCode: '5722', debit: '210.00', credit: '0', description: 'VAT input' },
    { accountCode: '5310', debit: '0', credit: '1000.00', description: 'Payable' },
    { accountCode: '5721', debit: '0', credit: '210.00', description: 'Reverse-charge output VAT' },
  ]);
  expect(totals(e)).toEqual({ debit: '1210.00', credit: '1210.00' });
});

test('a non-deductible reverse-charge line capitalises the VAT into the expense', () => {
  const e = buildBillEntry({ ...base, lines: [
    { description: 'Representation', expenseAccount: '7730', net: '1000.00', vatRate: 21, vat: '0.00', vatCategory: 'AE', vatDeductible: false },
  ] }, accounts);
  expect(e.lines).toEqual([
    { accountCode: '7730', debit: '1210.00', credit: '0', description: 'Representation' },
    { accountCode: '5310', debit: '0', credit: '1000.00', description: 'Payable' },
    { accountCode: '5721', debit: '0', credit: '210.00', description: 'Reverse-charge output VAT' },
  ]);
  expect(totals(e)).toEqual({ debit: '1210.00', credit: '1210.00' });
});

test('an intra-Community acquisition of goods self-assesses like AE', () => {
  const e = buildBillEntry({ ...base, lines: [
    { description: 'EU goods', expenseAccount: '7710', net: '500.00', vatRate: 21, vat: '0.00', vatCategory: 'K' },
  ] }, accounts);
  expect(e.lines.find((l) => l.accountCode === '5721')?.credit).toBe('105.00');
  expect(e.lines.find((l) => l.accountCode === '5722')?.debit).toBe('105.00');
});

test('a mixed bill combines invoiced and self-assessed input VAT into one line', () => {
  const e = buildBillEntry({ ...base, lines: [
    { description: 'Domestic', expenseAccount: '7710', net: '100.00', vatRate: 21, vat: '21.00' },
    { description: 'EU service', expenseAccount: '7710', net: '200.00', vatRate: 21, vat: '0.00', vatCategory: 'AE' },
  ] }, accounts);
  expect(e.lines.find((l) => l.accountCode === '5722')?.debit).toBe('63.00'); // 21 invoiced + 42 self-assessed
  expect(e.lines.find((l) => l.accountCode === '5721')?.credit).toBe('42.00');
  expect(e.lines.find((l) => l.accountCode === '5310')?.credit).toBe('321.00'); // net 300 + invoiced VAT 21
  // 100 + 200 net debits + 63 combined VAT-input debit = 321 payable + 42 output-VAT credit.
  expect(totals(e)).toEqual({ debit: '363.00', credit: '363.00' });
});

test('an exempt line posts net with no VAT legs at all', () => {
  const e = buildBillEntry({ ...base, lines: [
    { description: 'Exempt', expenseAccount: '7710', net: '100.00', vatRate: 0, vat: '0.00', vatCategory: 'E' },
  ] }, accounts);
  expect(e.lines).toEqual([
    { accountCode: '7710', debit: '100.00', credit: '0', description: 'Exempt' },
    { accountCode: '5310', debit: '0', credit: '100.00', description: 'Payable' },
  ]);
});
