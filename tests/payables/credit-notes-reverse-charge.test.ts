import { expect, test } from 'vitest';
import { buildCreditNoteEntry, type NewVendorCreditNote } from '../../src/payables/credit-notes.js';

const accounts = { vatInputAccount: '5722', vatOutputAccount: '5721', payablesAccount: '5310' };

const base: Omit<NewVendorCreditNote, 'lines'> = {
  vendorPartyId: '00000000-0000-0000-0000-000000000001',
  creditNoteNumber: 'VCN-1', issueDate: '2026-06-20', currency: 'EUR', correctedBillNumber: null,
};

function totals(entry: { lines: { accountCode: string; debit: string; credit: string }[] }) {
  const d = entry.lines.reduce((a, l) => a + Number(l.debit), 0);
  const c = entry.lines.reduce((a, l) => a + Number(l.credit), 0);
  return { debit: d.toFixed(2), credit: c.toFixed(2) };
}

test('a domestic standard-rated credit note reverses exactly as before', () => {
  const e = buildCreditNoteEntry({ ...base, lines: [
    { description: 'Goods return', expenseAccount: '7710', net: '100.00', vatRate: 21, vat: '21.00' },
  ] }, accounts);
  expect(e.lines).toEqual([
    { accountCode: '7710', debit: '0', credit: '100.00', description: 'Goods return' },
    { accountCode: '5722', debit: '0', credit: '21.00', description: 'VAT input reversal' },
    { accountCode: '5310', debit: '121.00', credit: '0', description: 'Payable reduction' },
  ]);
});

test('a deductible reverse-charge (AE) line reverses both self-assessed legs and nets to zero VAT', () => {
  const e = buildCreditNoteEntry({ ...base, lines: [
    { description: 'EU service credit', expenseAccount: '7710', net: '1000.00', vatRate: 21, vat: '0.00', vatCategory: 'AE' },
  ] }, accounts);
  expect(e.lines).toEqual([
    { accountCode: '7710', debit: '0', credit: '1000.00', description: 'EU service credit' },
    { accountCode: '5722', debit: '0', credit: '210.00', description: 'VAT input reversal' },
    { accountCode: '5310', debit: '1000.00', credit: '0', description: 'Payable reduction' },
    { accountCode: '5721', debit: '210.00', credit: '0', description: 'Reverse-charge output VAT reversal' },
  ]);
  expect(totals(e)).toEqual({ debit: '1210.00', credit: '1210.00' });
});

test('a non-deductible reverse-charge line credits the expense with net + assessed, no VAT-input leg', () => {
  const e = buildCreditNoteEntry({ ...base, lines: [
    { description: 'Representation credit', expenseAccount: '7730', net: '1000.00', vatRate: 21, vat: '0.00', vatCategory: 'AE', vatDeductible: false },
  ] }, accounts);
  expect(e.lines).toEqual([
    { accountCode: '7730', debit: '0', credit: '1210.00', description: 'Representation credit' },
    { accountCode: '5310', debit: '1000.00', credit: '0', description: 'Payable reduction' },
    { accountCode: '5721', debit: '210.00', credit: '0', description: 'Reverse-charge output VAT reversal' },
  ]);
  expect(totals(e)).toEqual({ debit: '1210.00', credit: '1210.00' });
});

test('an intra-Community acquisition of goods (K) reverses like AE', () => {
  const e = buildCreditNoteEntry({ ...base, lines: [
    { description: 'EU goods credit', expenseAccount: '7710', net: '500.00', vatRate: 21, vat: '0.00', vatCategory: 'K' },
  ] }, accounts);
  expect(e.lines.find((l) => l.accountCode === '5721')?.debit).toBe('105.00');
  expect(e.lines.find((l) => l.accountCode === '5722')?.credit).toBe('105.00');
});

test('a mixed credit note combines invoiced and self-assessed input VAT into one reversal line', () => {
  const e = buildCreditNoteEntry({ ...base, lines: [
    { description: 'Domestic', expenseAccount: '7710', net: '100.00', vatRate: 21, vat: '21.00' },
    { description: 'EU service', expenseAccount: '7710', net: '200.00', vatRate: 21, vat: '0.00', vatCategory: 'AE' },
  ] }, accounts);
  expect(e.lines.find((l) => l.accountCode === '5722')?.credit).toBe('63.00'); // 21 invoiced + 42 self-assessed
  expect(e.lines.find((l) => l.accountCode === '5721')?.debit).toBe('42.00');
  expect(e.lines.find((l) => l.accountCode === '5310')?.debit).toBe('321.00'); // net 300 + invoiced VAT 21
  expect(totals(e)).toEqual({ debit: '363.00', credit: '363.00' });
});

test('an exempt line reverses net with no VAT legs at all', () => {
  const e = buildCreditNoteEntry({ ...base, lines: [
    { description: 'Exempt', expenseAccount: '7710', net: '100.00', vatRate: 0, vat: '0.00', vatCategory: 'E' },
  ] }, accounts);
  expect(e.lines).toEqual([
    { accountCode: '7710', debit: '0', credit: '100.00', description: 'Exempt' },
    { accountCode: '5310', debit: '100.00', credit: '0', description: 'Payable reduction' },
  ]);
});
