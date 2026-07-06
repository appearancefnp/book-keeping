import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';
import { isLatvianHoliday } from './holidays.js';

export interface VidClient { submit(ublXml: string): Promise<{ ok: boolean; detail: string }>; }

/**
 * Add N working days, skipping Sat/Sun and Latvian public holidays. Returns 'YYYY-MM-DD'.
 * `isHoliday` is injectable (defaults to the LR statutory calendar) so the holiday set
 * stays accountant-confirmable without changing this arithmetic (spec §10.1).
 */
export function addWorkingDays(
  date: string, n: number, isHoliday: (d: string) => boolean = isLatvianHoliday,
): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  let added = 0;
  while (added < n) {
    dt.setUTCDate(dt.getUTCDate() + 1);
    const day = dt.getUTCDay();
    const iso = dt.toISOString().slice(0, 10);
    if (day !== 0 && day !== 6 && !isHoliday(iso)) added++;
  }
  return dt.toISOString().slice(0, 10);
}

export async function submitToVid(
  tx: PoolClient, ctx: TenantContext, einvoiceId: string, vid: VidClient,
): Promise<{ status: string }> {
  const row = await tx.query(
    `SELECT ubl_xml AS "ublXml", to_char(issue_date,'YYYY-MM-DD') AS "issueDate", vid_due_date
     FROM einvoices WHERE id = $1 AND client_company_id = $2 AND direction = 'outbound'`,
    [einvoiceId, ctx.clientCompanyId],
  );
  if (!row.rowCount) throw new Error(`Outbound einvoice not found: ${einvoiceId}`);
  const { ublXml, issueDate } = row.rows[0];
  const dueDate = addWorkingDays(issueDate, 5);

  let result: { ok: boolean; detail: string };
  try {
    result = await vid.submit(ublXml);
  } catch (err) {
    result = { ok: false, detail: `submit threw: ${String(err)}` };
  }
  const status = result.ok ? 'submitted' : 'failed';

  await tx.query(
    `UPDATE einvoices SET vid_status = $1, vid_due_date = $2 WHERE id = $3 AND client_company_id = $4`,
    [status, dueDate, einvoiceId, ctx.clientCompanyId],
  );
  await tx.query(
    `INSERT INTO vid_submission_attempts(client_company_id, einvoice_id, ok, detail) VALUES ($1,$2,$3,$4)`,
    [ctx.clientCompanyId, einvoiceId, result.ok, result.detail],
  );
  await appendAudit(tx, ctx, { action: 'vid_submit', entityType: 'einvoice', entityId: einvoiceId, before: null, after: { status, dueDate } });
  return { status };
}

/** Outbound einvoices not yet submitted whose due date has passed as of `asOf` — for alerting. */
export async function findOverdueVidSubmissions(
  tx: PoolClient, ctx: TenantContext, asOf: string,
): Promise<{ einvoiceId: string; dueDate: string }[]> {
  const res = await tx.query(
    `SELECT id AS "einvoiceId", to_char(vid_due_date,'YYYY-MM-DD') AS "dueDate"
     FROM einvoices
     WHERE client_company_id = $1 AND direction = 'outbound'
       AND vid_status IN ('pending','failed') AND vid_due_date IS NOT NULL AND vid_due_date < $2
     ORDER BY vid_due_date`,
    [ctx.clientCompanyId, asOf],
  );
  return res.rows;
}

export interface VidDeadline {
  einvoiceId: string;
  invoiceNumber: string;
  dueDate: string;
  overdue: boolean;
}

/** Outbound invoices still awaiting VID submission, with their 5-working-day
 *  due date (stored one if present, else computed from issue date). */
export async function upcomingVidDeadlines(
  tx: PoolClient,
  ctx: TenantContext,
  asOf: string,
): Promise<VidDeadline[]> {
  const res = await tx.query(
    `SELECT id, invoice_number,
            to_char(issue_date, 'YYYY-MM-DD') AS issue_date,
            to_char(vid_due_date, 'YYYY-MM-DD') AS vid_due_date
       FROM einvoices
      WHERE client_company_id = $1 AND direction = 'outbound' AND vid_status = 'pending'
      ORDER BY issue_date ASC`,
    [ctx.clientCompanyId],
  );
  return res.rows.map((r) => {
    const dueDate: string = r.vid_due_date ?? addWorkingDays(r.issue_date, 5);
    return { einvoiceId: r.id, invoiceNumber: r.invoice_number, dueDate, overdue: dueDate < asOf };
  });
}
