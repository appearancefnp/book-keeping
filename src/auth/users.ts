import { z } from 'zod';
import { appPool } from '../db/pool.js';
import { hashPassword } from './passwords.js';
import { generateTotpSecret } from './totp.js';

export type UserRole = 'firm_admin' | 'accountant' | 'owner' | 'employee';
export interface UserRow { id: string; firmId: string; email: string; role: UserRole; language: string; }

const newUserSchema = z.object({
  firmId: z.string().uuid(),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['firm_admin', 'accountant', 'owner', 'employee']),
  language: z.enum(['lv', 'ru', 'en']).default('lv'),
});

export async function createUser(input: {
  firmId: string; email: string; password: string; role: UserRole; language?: string;
}): Promise<{ id: string; totpSecret: string }> {
  const p = newUserSchema.parse(input);
  const totpSecret = generateTotpSecret();
  const res = await appPool.query(
    `INSERT INTO users(firm_id, email, password_hash, totp_secret, role, language)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [p.firmId, p.email, hashPassword(p.password), totpSecret, p.role, p.language],
  );
  return { id: res.rows[0].id, totpSecret };
}

export async function findUserByEmail(email: string): Promise<(UserRow & { passwordHash: string; totpSecret: string }) | null> {
  const res = await appPool.query(
    `SELECT id, firm_id AS "firmId", email, role, language, password_hash AS "passwordHash", totp_secret AS "totpSecret"
     FROM users WHERE email = $1`,
    [email],
  );
  return res.rows[0] ?? null;
}

export async function listUsersForFirm(firmId: string): Promise<UserRow[]> {
  const res = await appPool.query(
    `SELECT id, firm_id AS "firmId", email, role, language
     FROM users WHERE firm_id = $1 ORDER BY email ASC`,
    [firmId],
  );
  return res.rows;
}
