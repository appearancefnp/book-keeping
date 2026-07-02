import { expect, test } from 'vitest';
import { parseCamt053 } from '../../src/banking/camt-parser.js';

// Minimal camt.053 with two entries (one credit, one debit).
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Acct><Id><IBAN>LV80BANK0000435195001</IBAN></Id></Acct>
      <Ntry>
        <Amt Ccy="EUR">121.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2026-03-10</Dt></BookgDt>
        <NtryDtls><TxDtls>
          <Refs><EndToEndId>INV-2026-001</EndToEndId></Refs>
          <RltdPties><Dbtr><Nm>SIA Klients</Nm></Dbtr></RltdPties>
          <RmtInf><Ustrd>Payment for INV-2026-001</Ustrd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">60.50</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt><Dt>2026-03-11</Dt></BookgDt>
        <NtryDtls><TxDtls>
          <Refs><EndToEndId>PO-77</EndToEndId></Refs>
          <RltdPties><Cdtr><Nm>SIA Piegādātājs</Nm></Cdtr></RltdPties>
        </TxDtls></NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

test('parses account and both entries with sign, cents, refs', () => {
  const stmt = parseCamt053(XML);
  expect(stmt.account).toBe('LV80BANK0000435195001');
  expect(stmt.transactions).toHaveLength(2);
  const credit = stmt.transactions[0]!;
  expect(credit.side).toBe('credit');
  expect(credit.amountCents).toBe('12100');
  expect(credit.currency).toBe('EUR');
  expect(credit.endToEndId).toBe('INV-2026-001');
  expect(credit.counterparty).toBe('SIA Klients');
  const debit = stmt.transactions[1]!;
  expect(debit.side).toBe('debit');
  expect(debit.amountCents).toBe('6050');
  expect(debit.counterparty).toBe('SIA Piegādātājs');
});
