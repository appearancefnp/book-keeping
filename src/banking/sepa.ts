import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { escapeXml } from '../xml/escape.js';

/** Minimal SEPA pain.001 credit-transfer initiation. Representative; refined with bank specifics later. */
export function generateSepaCreditTransfer(
  payments: { iban: string; amount: string; reference: string }[],
): string {
  const txs = payments.map((p, i) => [
    '      <CdtTrfTxInf>',
    `        <PmtId><EndToEndId>${escapeXml(p.reference || `E2E-${i + 1}`)}</EndToEndId></PmtId>`,
    `        <Amt><InstdAmt Ccy="EUR">${p.amount}</InstdAmt></Amt>`,
    `        <CdtrAcct><Id><IBAN>${escapeXml(p.iban)}</IBAN></Id></CdtrAcct>`,
    `        <RmtInf><Ustrd>${escapeXml(p.reference)}</Ustrd></RmtInf>`,
    '      </CdtTrfTxInf>',
  ].join('\n')).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">',
    '  <CstmrCdtTrfInitn>',
    `    <GrpHdr><NbOfTxs>${payments.length}</NbOfTxs></GrpHdr>`,
    '    <PmtInf>',
    txs,
    '    </PmtInf>',
    '  </CstmrCdtTrfInitn>',
    '</Document>',
  ].join('\n');
}

/** Net debit balance (outstanding receivables) on the given account, in integer cents. */
export async function outstandingReceivables(
  tx: PoolClient, ctx: TenantContext, receivablesAccount: string,
): Promise<{ balanceCents: string }> {
  const res = await tx.query(
    `SELECT COALESCE(SUM((ROUND(jl.debit*100))::bigint - (ROUND(jl.credit*100))::bigint), 0)::text AS "balanceCents"
     FROM journal_lines jl
     JOIN accounts a ON a.id = jl.account_id
     WHERE jl.client_company_id = $1 AND a.code = $2`,
    [ctx.clientCompanyId, receivablesAccount],
  );
  return { balanceCents: res.rows[0].balanceCents };
}
