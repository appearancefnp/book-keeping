import type { PoolClient } from 'pg';

export interface TaxRate { ruleType: string; value: string; effectiveFrom: string; }

/** Look up the rule value effective on `onDate` (latest effective_from <= onDate). Global/national data. */
export async function getTaxRate(tx: PoolClient, ruleType: string, onDate: string): Promise<TaxRate> {
  const res = await tx.query(
    `SELECT rule_type AS "ruleType", value, to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom"
     FROM tax_rules
     WHERE rule_type = $1 AND effective_from <= $2
     ORDER BY effective_from DESC
     LIMIT 1`,
    [ruleType, onDate],
  );
  if (!res.rowCount) throw new Error(`No tax rule '${ruleType}' effective on ${onDate}`);
  return res.rows[0];
}
