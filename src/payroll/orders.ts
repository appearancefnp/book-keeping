import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';
import { updateEmployee } from './employees.js';
import { addAbsence, addPayComponent } from './inputs.js';
import { applyTermination } from './termination.js';

export type OrderType = 'hire' | 'termination' | 'bonus' | 'vacation' | 'wage_change';

export interface OrderRow {
  id: string; orderType: OrderType; status: 'draft' | 'approved';
  employeeIds: string[]; amount: string | null;
  dateFrom: string | null; dateTo: string | null; effectiveDate: string;
  reason: string; payload: Record<string, unknown>;
  createdBy: string; approvedBy: string | null; approvedAt: string | null;
}

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const moneyStr = z.string().regex(/^\d+(\.\d{1,2})?$/);

const newOrderSchema = z.object({
  orderType: z.enum(['hire', 'termination', 'bonus', 'vacation', 'wage_change']),
  employeeIds: z.array(z.string().uuid()).min(1),
  amount: moneyStr.optional(),
  dateFrom: dateStr.optional(),
  dateTo: dateStr.optional(),
  effectiveDate: dateStr,
  reason: z.string().min(1),
  payload: z.record(z.unknown()).default({}),
}).superRefine((o, issues) => {
  if ((o.orderType === 'bonus' || o.orderType === 'wage_change') && o.amount === undefined) {
    issues.addIssue({ code: z.ZodIssueCode.custom, message: `${o.orderType} order requires amount` });
  }
  if ((o.orderType === 'vacation' || o.orderType === 'termination') && (!o.dateFrom || !o.dateTo)) {
    issues.addIssue({ code: z.ZodIssueCode.custom, message: `${o.orderType} order requires dateFrom/dateTo` });
  }
  if (o.orderType !== 'bonus' && o.employeeIds.length > 1) {
    issues.addIssue({ code: z.ZodIssueCode.custom, message: 'only bonus orders may target multiple employees' });
  }
});
export type NewOrder = z.input<typeof newOrderSchema>;

const SELECT_COLS = `id, order_type AS "orderType", status, employee_ids AS "employeeIds",
  amount::text, to_char(date_from,'YYYY-MM-DD') AS "dateFrom", to_char(date_to,'YYYY-MM-DD') AS "dateTo",
  to_char(effective_date,'YYYY-MM-DD') AS "effectiveDate", reason, payload,
  created_by AS "createdBy", approved_by AS "approvedBy", approved_at::text AS "approvedAt"`;

export async function createOrder(tx: PoolClient, ctx: TenantContext, input: NewOrder): Promise<{ id: string }> {
  const o = newOrderSchema.parse(input);
  const res = await tx.query(
    `INSERT INTO payroll_orders(client_company_id, order_type, employee_ids, amount,
       date_from, date_to, effective_date, reason, payload, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [ctx.clientCompanyId, o.orderType, o.employeeIds, o.amount ?? null,
     o.dateFrom ?? null, o.dateTo ?? null, o.effectiveDate, o.reason, o.payload, ctx.actorId],
  );
  const id = res.rows[0].id as string;
  await appendAudit(tx, ctx, { action: 'create', entityType: 'payroll_order', entityId: id, before: null, after: o });
  return { id };
}

export async function getOrder(tx: PoolClient, ctx: TenantContext, id: string): Promise<OrderRow> {
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM payroll_orders WHERE id = $1 AND client_company_id = $2`,
    [id, ctx.clientCompanyId],
  );
  if (!res.rowCount) throw new Error(`Order not found: ${id}`);
  return res.rows[0];
}

export async function listOrders(
  tx: PoolClient, ctx: TenantContext, filter: { orderType?: OrderType },
): Promise<OrderRow[]> {
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM payroll_orders
     WHERE client_company_id = $1 AND ($2::text IS NULL OR order_type = $2)
     ORDER BY created_at DESC`,
    [ctx.clientCompanyId, filter.orderType ?? null],
  );
  return res.rows;
}

function ym(iso: string): { year: number; month: number } {
  return { year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) };
}

/**
 * Approve a draft order and apply its effects (doc 4.2 step 4). After this the
 * order is immutable — there is no update function, and approval is one-way.
 */
export async function approveOrder(tx: PoolClient, ctx: TenantContext, id: string): Promise<void> {
  const before = await getOrder(tx, ctx, id);
  if (before.status !== 'draft') throw new Error(`Order ${id} is not a draft (status: ${before.status})`);

  switch (before.orderType) {
    case 'hire':
      break; // the employee card already exists; the order is the paper trail
    case 'bonus': {
      const { year, month } = ym(before.effectiveDate);
      for (const employeeId of before.employeeIds) {
        await addPayComponent(tx, ctx, {
          employeeId, year, month, kind: 'bonus', amount: before.amount!,
          sourceOrderId: id, note: before.reason,
        });
      }
      break;
    }
    case 'vacation':
      await addAbsence(tx, ctx, {
        employeeId: before.employeeIds[0]!, type: 'vacation',
        dateFrom: before.dateFrom!, dateTo: before.dateTo!,
        sourceOrderId: id, note: before.reason,
      });
      break;
    case 'wage_change':
      await updateEmployee(tx, ctx, before.employeeIds[0]!, { wage: before.amount! });
      break;
    case 'termination':
      await applyTermination(tx, ctx, {
        orderId: id, employeeId: before.employeeIds[0]!, lastDay: before.dateTo!,
        severance: before.payload['severance'] === true,
      });
      break;
  }

  await tx.query(
    `UPDATE payroll_orders SET status = 'approved', approved_by = $1, approved_at = now()
     WHERE id = $2 AND client_company_id = $3`,
    [ctx.actorId, id, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, {
    action: 'approve', entityType: 'payroll_order', entityId: id,
    before, after: { ...before, status: 'approved' },
  });
}
