import { XMLParser } from 'fast-xml-parser';
import { toCents } from '../db/money.js';
import type { BankTxn } from './types.js';

export interface BankStatement { account: string; transactions: BankTxn[]; }

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true });

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export function parseCamt053(xml: string): BankStatement {
  const doc = parser.parse(xml);
  const stmt = doc?.Document?.BkToCstmrStmt?.Stmt;
  if (!stmt) throw new Error('Not a camt.053 statement');
  const account = String(stmt?.Acct?.Id?.IBAN ?? '');

  const transactions: BankTxn[] = asArray(stmt.Ntry).map((ntry: Record<string, unknown>) => {
    const amt = (ntry.Amt as { '#text'?: string | number; '@_Ccy'?: string }) ?? {};
    const txDtls = ((ntry.NtryDtls as { TxDtls?: Record<string, unknown> })?.TxDtls) ?? {};
    const refs = (txDtls.Refs as { EndToEndId?: string }) ?? {};
    const parties = (txDtls.RltdPties as { Dbtr?: { Nm?: string }; Cdtr?: { Nm?: string } }) ?? {};
    const side = String(ntry.CdtDbtInd) === 'CRDT' ? 'credit' : 'debit';
    return {
      bookingDate: String((ntry.BookgDt as { Dt?: string })?.Dt ?? ''),
      amountCents: toCents(String(amt['#text'] ?? amt as unknown as string)).toString(),
      currency: String(amt['@_Ccy'] ?? ''),
      side,
      reference: String((txDtls.RmtInf as { Ustrd?: string })?.Ustrd ?? ''),
      counterparty: String((side === 'credit' ? parties.Dbtr?.Nm : parties.Cdtr?.Nm) ?? ''),
      endToEndId: String(refs.EndToEndId ?? ''),
    };
  });

  return { account, transactions };
}
