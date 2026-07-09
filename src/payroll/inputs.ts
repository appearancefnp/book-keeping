import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';
import { firstDayOfMonth, lastDayOfMonth } from './workdays.js';

export type AbsenceType = 'vacation' | 'sick_a' | 'sick_b' | 'unpaid' | 'other';
export type ComponentKind =
  | 'bonus' | 'night_hours' | 'overtime_hours' | 'holiday_hours'
  | 'hours_worked' | 'other_taxable' | 'severance_exempt' | 'deduction';

const HOUR_KINDS: readonly ComponentKind[] = ['night_hours', 'overtime_hours', 'holiday_hours', 'hours_worked'];

export interface AbsenceRow {
  id: string; employeeId: string; type: AbsenceType;
  dateFrom: string; dateTo: string; sourceOrderId: string | null; note: string | null;
}
export interface ComponentRow {
  id: string; employeeId: string; kind: ComponentKind;
  amount: string | null; quantity: string | null; sourceOrderId: string | null; note: string | null;
}

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const absenceSchema = z.object({
  employeeId: z.string().uuid(),
  type: z.enum(['vacation', 'sick_a', 'sick_b', 'unpaid', 'other']),
  dateFrom: dateStr, dateTo: dateStr,
  sourceOrderId: z.string().uuid().nullable().optional(),
  note: z.string().nullable().optional(),
}).refine((a) => a.dateTo >= a.dateFrom, { message: 'dateTo must be >= dateFrom' });

export async function addAbsence(
  tx: PoolClient, ctx: TenantContext,
  input: z.input<typeof absenceSchema>,
): Promise<{ id: string }> {
  const a = absenceSchema.parse(input);
  if (a.type === 'sick_a') {
    const days = (Date.parse(`${a.dateTo}T00:00:00Z`) - Date.parse(`${a.dateFrom}T00:00:00Z`)) / 86_400_000 + 1;
    if (days > 9) throw new Error('sick_a may cover at most 9 calendar days — record day 10+ as sick_b (B lapa)');
  }
  const res = await tx.query(
    `INSERT INTO absences(client_company_id, employee_id, type, date_from, date_to, source_order_id, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ctx.clientCompanyId, a.employeeId, a.type, a.dateFrom, a.dateTo, a.sourceOrderId ?? null, a.note ?? null],
  );
  const id = res.rows[0].id as string;
  await appendAudit(tx, ctx, { action: 'create', entityType: 'absence', entityId: id, before: null, after: a });
  return { id };
}

export async function listAbsencesOverlapping(
  tx: PoolClient, ctx: TenantContext, employeeId: string, year: number, month: number,
): Promise<AbsenceRow[]> {
  const res = await tx.query(
    `SELECT id, employee_id AS "employeeId", type,
            to_char(date_from,'YYYY-MM-DD') AS "dateFrom", to_char(date_to,'YYYY-MM-DD') AS "dateTo",
            source_order_id AS "sourceOrderId", note
     FROM absences
     WHERE employee_id = $1 AND client_company_id = $2 AND date_from <= $4 AND date_to >= $3
     ORDER BY date_from`,
    [employeeId, ctx.clientCompanyId, firstDayOfMonth(year, month), lastDayOfMonth(year, month)],
  );
  return res.rows;
}

const componentSchema = z.object({
  employeeId: z.string().uuid(),
  year: z.number().int(), month: z.number().int().min(1).max(12),
  kind: z.enum(['bonus', 'night_hours', 'overtime_hours', 'holiday_hours',
    'hours_worked', 'other_taxable', 'severance_exempt', 'deduction']),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  quantity: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  sourceOrderId: z.string().uuid().nullable().optional(),
  note: z.string().nullable().optional(),
}).refine((c) => HOUR_KINDS.includes(c.kind) ? c.quantity !== undefined && c.amount === undefined
                                             : c.amount !== undefined && c.quantity === undefined,
  { message: 'hour kinds take quantity; money kinds take amount' });

export async function addPayComponent(
  tx: PoolClient, ctx: TenantContext,
  input: z.input<typeof componentSchema>,
): Promise<{ id: string }> {
  const c = componentSchema.parse(input);
  const res = await tx.query(
    `INSERT INTO pay_components(client_company_id, employee_id, year, month, kind, amount, quantity, source_order_id, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [ctx.clientCompanyId, c.employeeId, c.year, c.month, c.kind,
     c.amount ?? null, c.quantity ?? null, c.sourceOrderId ?? null, c.note ?? null],
  );
  const id = res.rows[0].id as string;
  await appendAudit(tx, ctx, { action: 'create', entityType: 'pay_component', entityId: id, before: null, after: c });
  return { id };
}

export async function listComponents(
  tx: PoolClient, ctx: TenantContext, employeeId: string, year: number, month: number,
): Promise<ComponentRow[]> {
  const res = await tx.query(
    `SELECT id, employee_id AS "employeeId", kind, amount::text, quantity::text,
            source_order_id AS "sourceOrderId", note
     FROM pay_components
     WHERE employee_id = $1 AND client_company_id = $2 AND year = $3 AND month = $4
     ORDER BY created_at`,
    [employeeId, ctx.clientCompanyId, year, month],
  );
  return res.rows;
}
