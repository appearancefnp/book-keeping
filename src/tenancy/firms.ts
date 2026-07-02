import { z } from 'zod';
import { appPool } from '../db/pool.js';

export interface Firm { id: string; name: string; }
export interface ClientCompany {
  id: string; firmId: string; name: string; regNo: string; baseCurrency: string;
}

const newClientSchema = z.object({
  name: z.string().min(1),
  regNo: z.string().min(1),
  baseCurrency: z.string().length(3).default('EUR'),
});

export async function createFirm(name: string): Promise<Firm> {
  const res = await appPool.query('INSERT INTO firms(name) VALUES ($1) RETURNING id, name', [name]);
  return res.rows[0];
}

export async function createClientCompany(
  firmId: string,
  input: { name: string; regNo: string; baseCurrency?: string },
): Promise<ClientCompany> {
  const parsed = newClientSchema.parse(input);
  const res = await appPool.query(
    `INSERT INTO client_companies(firm_id, name, reg_no, base_currency)
     VALUES ($1, $2, $3, $4)
     RETURNING id, firm_id AS "firmId", name, reg_no AS "regNo", base_currency AS "baseCurrency"`,
    [firmId, parsed.name, parsed.regNo, parsed.baseCurrency],
  );
  return res.rows[0];
}
