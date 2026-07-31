'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { fetchClients, type ClientCompany } from '@/app/lib/api-client';
import { ErrorState } from '@/app/components/ErrorState';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { VAT_CATEGORIES, chargesVat, type VatCategory } from '@domain/tax/categories.js';
import styles from './page.module.css';

interface PartyRow { id: string; kind: 'customer' | 'vendor' | 'both'; name: string; regNo: string | null; vatNo: string | null; }
interface LineDraft { description: string; net: string; vatRate: number; vatCategory: VatCategory; }
interface InvoiceProfileLine { description: string; net: string; vatRate: number; }
interface InvoiceProfileDTO {
  paymentTerms: string | null;
  note: string | null;
  dueDateOffsetDays: number | null;
  numberPrefix: string | null;
  defaultLines: InvoiceProfileLine[];
}

function toCents(s: string): number {
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
function fromCents(c: number): string {
  return (c / 100).toFixed(2);
}
function lineVatCents(l: LineDraft): number {
  // Sales side: only 'S' charges VAT. Every other category (including AE/K, whose rate
  // must be 0 per BR-AE-5/BR-IC-5) invoices zero VAT — the customer self-assesses.
  if (!chargesVat(l.vatCategory)) return 0;
  return Math.round((toCents(l.net) * l.vatRate) / 100);
}

function ComposerInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { t } = useMessages();
  const clientCompanyId = searchParams.get('client');

  const [customers, setCustomers] = useState<PartyRow[] | null>(null);
  const [company, setCompany] = useState<ClientCompany | null>(null);
  const [defaultRate, setDefaultRate] = useState<number>(21);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [docType, setDocType] = useState<'invoice' | 'credit_note' | 'recurring'>('invoice');
  const [correctedInvoiceNumber, setCorrectedInvoiceNumber] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [issueDate, setIssueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [customerId, setCustomerId] = useState('');
  const [peppolId, setPeppolId] = useState('');
  const [supplierVatNo, setSupplierVatNo] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([{ description: '', net: '', vatRate: 21, vatCategory: 'S' }]);
  const [note, setNote] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [offsetDays, setOffsetDays] = useState<number | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);

  const [anchorDay, setAnchorDay] = useState('1');
  const [intervalMonths, setIntervalMonths] = useState('1');
  const [firstRunDate, setFirstRunDate] = useState('');
  const [recTermsDays, setRecTermsDays] = useState('');
  const [recEndDate, setRecEndDate] = useState('');
  const [recOccurrences, setRecOccurrences] = useState('');
  const [autonomyMode, setAutonomyMode] = useState<'auto' | 'approval'>('approval');

  const load = useCallback(async (id: string) => {
    setLoadError(null);
    try {
      const [pRes, cBody, rRes, pfRes] = await Promise.all([
        fetch(`/api/parties?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' }),
        fetchClients(),
        fetch(`/api/vat-rate?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' }),
        fetch(`/api/invoice-profile?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' }),
      ]);
      if (!pRes.ok) throw new Error(((await pRes.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${pRes.status}`);
      const parties = ((await pRes.json()) as { parties: PartyRow[] }).parties;
      setCustomers(parties.filter((p) => p.kind === 'customer' || p.kind === 'both'));
      const mine = cBody.clients.find((c) => c.id === id) ?? null;
      setCompany(mine);
      if (mine?.regNo) setSupplierVatNo(`LV${mine.regNo}`);
      if (rRes.ok) {
        const body = (await rRes.json()) as { rate?: number };
        if (typeof body.rate === 'number' && Number.isFinite(body.rate)) {
          setDefaultRate(body.rate);
          setLines((ls) => ls.map((l) => ({ ...l, vatRate: chargesVat(l.vatCategory) ? body.rate! : 0 })));
        }
      }
      if (pfRes.ok) {
        const profile = ((await pfRes.json()) as { profile: InvoiceProfileDTO | null }).profile;
        if (profile) {
          if (profile.numberPrefix && !invoiceNumber.trim()) setInvoiceNumber(profile.numberPrefix);
          if (profile.defaultLines?.length) {
            setLines(profile.defaultLines.map((l) => ({ description: l.description, net: l.net, vatRate: l.vatRate, vatCategory: 'S' })));
          }
          setNote(profile.note ?? '');
          setPaymentTerms(profile.paymentTerms ?? '');
          setOffsetDays(profile.dueDateOffsetDays ?? null);
        }
      }
    } catch (err) {
      setLoadError((err as Error).message ?? t('state.error'));
    }
  }, [t]);

  useEffect(() => {
    if (clientCompanyId) load(clientCompanyId);
  }, [clientCompanyId, load]);

  const customer = useMemo(() => customers?.find((c) => c.id === customerId) ?? null, [customers, customerId]);

  useEffect(() => {
    if (customer?.regNo) setPeppolId(`0088:${customer.regNo}`);
  }, [customer]);

  useEffect(() => {
    if (offsetDays === null) return;
    const base = new Date(issueDate);
    if (Number.isNaN(base.getTime())) return;
    base.setDate(base.getDate() + offsetDays);
    setDueDate(base.toISOString().slice(0, 10));
  }, [issueDate, offsetDays]);

  useEffect(() => {
    if (!clientCompanyId) return;
    fetch(`/api/autonomy?clientCompanyId=${encodeURIComponent(clientCompanyId)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { policies?: { operationType: string; mode: 'auto' | 'approval' }[] } | null) => {
        const p = b?.policies?.find((x) => x.operationType === 'recurring_invoice');
        setAutonomyMode(p?.mode === 'auto' ? 'auto' : 'approval'); // default-closed
      })
      .catch(() => setAutonomyMode('approval'));
  }, [clientCompanyId]);

  const netTotalCents = lines.reduce((acc, l) => acc + toCents(l.net), 0);
  const vatTotalCents = lines.reduce((acc, l) => acc + lineVatCents(l), 0);
  const grandTotalCents = netTotalCents + vatTotalCents;

  const canIssue =
    !!clientCompanyId && !!company && !!customer && !!peppolId.trim() &&
    (docType === 'recurring' ? !!firstRunDate : !!invoiceNumber.trim()) &&
    lines.length > 0 && lines.every((l) => l.description.trim() && toCents(l.net) > 0);

  async function issue() {
    if (!canIssue || !clientCompanyId || !company || !customer) return;
    setIssuing(true);
    setIssueError(null);
    const invoice = {
      invoiceNumber: invoiceNumber.trim(),
      issueDate,
      currency: company.baseCurrency || 'EUR',
      supplier: { name: company.name, regNo: company.regNo, vatNo: supplierVatNo.trim() },
      customer: { name: customer.name, regNo: customer.regNo ?? '', vatNo: customer.vatNo ?? '' },
      lines: lines.map((l) => ({
        description: l.description.trim(),
        net: fromCents(toCents(l.net)),
        vatRate: l.vatRate,
        vat: fromCents(lineVatCents(l)),
        vatCategory: l.vatCategory,
      })),
      netTotal: fromCents(netTotalCents),
      vatTotal: fromCents(vatTotalCents),
      grandTotal: fromCents(grandTotalCents),
      ...(dueDate.trim() && { dueDate: dueDate.trim() }),
      ...(note.trim() && { note: note.trim() }),
      ...(paymentTerms.trim() && { paymentTerms: paymentTerms.trim() }),
      ...(docType === 'credit_note' && correctedInvoiceNumber.trim() && { correctedInvoiceNumber: correctedInvoiceNumber.trim() }),
    };
    try {
      if (docType === 'recurring') {
        const { invoiceNumber: _n, issueDate: _d, dueDate: _due, ...invoicePayload } = invoice;
        const res = await fetch('/api/recurring', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientCompanyId,
            template: {
              customerPartyId: customer.id,
              recipientPeppolId: peppolId.trim(),
              invoicePayload,
              anchorDay: Number(anchorDay),
              intervalMonths: Number(intervalMonths),
              firstRunDate,
              ...(recTermsDays !== '' ? { paymentTermsDays: Number(recTermsDays) } : {}),
              ...(recEndDate !== '' ? { endDate: recEndDate } : {}),
              ...(recOccurrences !== '' ? { occurrencesRemaining: Number(recOccurrences) } : {}),
            },
          }),
        });
        const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        router.push(`/invoices?client=${encodeURIComponent(clientCompanyId)}`);
        return;
      }
      const endpoint = docType === 'credit_note' ? '/api/credit-notes' : '/api/einvoices';
      const payload =
        docType === 'credit_note'
          ? { clientCompanyId, creditNote: invoice, recipientPeppolId: peppolId.trim() }
          : {
              clientCompanyId,
              invoice,
              recipientPeppolId: peppolId.trim(),
              customerPartyId: customer.id,
              ...(dueDate.trim() && { dueDate: dueDate.trim() }),
            };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      router.push(`/invoices?client=${encodeURIComponent(clientCompanyId)}`);
    } catch (err) {
      setIssueError((err as Error).message ?? t('state.error'));
      setIssuing(false);
    }
  }

  if (loadError) {
    return (
      <div className={styles.page}><main className={styles.main}>
        <ErrorState message={loadError} onRetry={() => clientCompanyId && load(clientCompanyId)} />
      </main></div>
    );
  }
  if (!customers) {
    return (
      <div className={styles.page}><main className={styles.main}>
        <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>
      </main></div>
    );
  }

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 className={styles.pageHeading}>
          {docType === 'credit_note'
            ? t('einv.composeCreditNote')
            : docType === 'recurring'
              ? t('einv.rec.new')
              : t('einv.compose')}
        </h1>

        {customers.length === 0 ? (
          <p className={styles.notice}>{t('einv.noCustomers')}</p>
        ) : (
          <form className={styles.composer} onSubmit={(e) => { e.preventDefault(); issue(); }}>
            <section className={styles.card}>
              <div className={styles.fieldGrid}>
                <label className={styles.field}>
                  <span>{t('einv.docType')}</span>
                  <select value={docType} onChange={(e) => setDocType(e.target.value as 'invoice' | 'credit_note' | 'recurring')}>
                    <option value="invoice">{t('einv.mode.invoice')}</option>
                    <option value="credit_note">{t('einv.mode.creditNote')}</option>
                    <option value="recurring">{t('einv.mode.recurring')}</option>
                  </select>
                </label>
                {docType !== 'recurring' && (
                  <>
                    <label className={styles.field}>
                      <span>{t('einv.number')}</span>
                      <input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} required />
                    </label>
                    <label className={styles.field}>
                      <span>{t('einv.issueDate')}</span>
                      <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required />
                    </label>
                  </>
                )}
                <label className={styles.field}>
                  <span>{t('einv.customer')}</span>
                  <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} required>
                    <option value="">{t('einv.customer.pick')}</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </label>
                <label className={styles.field}>
                  <span>{t('einv.peppolId')}</span>
                  <input value={peppolId} onChange={(e) => setPeppolId(e.target.value)} required />
                </label>
                <label className={styles.field}>
                  <span>{t('inv.dueDate')}</span>
                  <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                </label>
                <label className={styles.field}>
                  <span>{t('inv.paymentTerms')}</span>
                  <input value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} />
                </label>
                <label className={styles.field}>
                  <span>{t('inv.note')}</span>
                  <input value={note} onChange={(e) => setNote(e.target.value)} />
                </label>
                {docType === 'credit_note' && (
                  <label className={styles.field}>
                    <span>{t('einv.correctedInvoice')}</span>
                    <input value={correctedInvoiceNumber} onChange={(e) => setCorrectedInvoiceNumber(e.target.value)} />
                  </label>
                )}
                {docType === 'recurring' && (
                  <>
                    <label className={styles.field}>
                      <span>{t('einv.rec.firstRunDate')}</span>
                      <input type="date" value={firstRunDate} required
                             onChange={(e) => setFirstRunDate(e.target.value)} />
                    </label>
                    <label className={styles.field}>
                      <span>{t('einv.rec.anchorDay')}</span>
                      <input type="number" inputMode="numeric" min={1} max={31} value={anchorDay} required
                             onChange={(e) => setAnchorDay(e.target.value)} />
                    </label>
                    <label className={styles.field}>
                      <span>{t('einv.rec.intervalMonths')}</span>
                      <input type="number" inputMode="numeric" min={1} value={intervalMonths} required
                             onChange={(e) => setIntervalMonths(e.target.value)} />
                    </label>
                    <label className={styles.field}>
                      <span>{t('einv.rec.paymentTermsDays')}</span>
                      <input type="number" inputMode="numeric" min={0} max={365} value={recTermsDays}
                             onChange={(e) => setRecTermsDays(e.target.value)} />
                    </label>
                    <label className={styles.field}>
                      <span>{t('einv.rec.endDate')}</span>
                      <input type="date" value={recEndDate} onChange={(e) => setRecEndDate(e.target.value)} />
                    </label>
                    <label className={styles.field}>
                      <span>{t('einv.rec.occurrences')}</span>
                      <input type="number" inputMode="numeric" min={1} value={recOccurrences}
                             onChange={(e) => setRecOccurrences(e.target.value)} />
                    </label>
                  </>
                )}
              </div>
              {docType === 'recurring' && (
                // resolveAutonomy is default-closed, so with no autonomy policy set these queue for
                // approval. Stating it here means the accountant is not surprised by queue items.
                <p className={styles.notice}>
                  {t(autonomyMode === 'auto' ? 'einv.rec.autoNote' : 'einv.rec.approvalNote')}
                </p>
              )}
            </section>

            <section className={styles.card}>
              <h2 className={styles.sectionHeading}>{t('einv.supplier')}</h2>
              <div className={styles.fieldGrid}>
                <label className={styles.field}>
                  <span>{t('einv.supplier.name')}</span>
                  <input value={company?.name ?? ''} readOnly />
                </label>
                <label className={styles.field}>
                  <span>{t('parties.regNo')}</span>
                  <input value={company?.regNo ?? ''} readOnly />
                </label>
                <label className={styles.field}>
                  <span>{t('parties.vatNo')}</span>
                  <input value={supplierVatNo} onChange={(e) => setSupplierVatNo(e.target.value)} />
                </label>
              </div>
            </section>

            <section className={styles.card}>
              <h2 className={styles.sectionHeading}>{t('einv.lines')}</h2>
              <div className={styles.tableWrapper}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">{t('einv.line.description')}</th>
                      <th scope="col" className={styles.colAmount}>{t('einv.line.net')}</th>
                      <th scope="col">{t('vat.category')}</th>
                      <th scope="col" className={styles.colAmount}>{t('einv.line.vatRate')}</th>
                      <th scope="col" className={styles.colAmount}>{t('einv.line.vat')}</th>
                      <th scope="col"><span className="sr-only">{t('einv.line.remove')}</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={i}>
                        <td>
                          <input
                            aria-label={t('einv.line.description')}
                            value={l.description}
                            onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
                          />
                        </td>
                        <td className={styles.colAmount}>
                          <input
                            aria-label={t('einv.line.net')}
                            inputMode="decimal"
                            className={styles.amountInput}
                            value={l.net}
                            onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, net: e.target.value } : x)))}
                          />
                        </td>
                        <td>
                          <select
                            aria-label={t('vat.category')}
                            className={styles.catInput}
                            value={l.vatCategory}
                            onChange={(e) => {
                              const vatCategory = e.target.value as VatCategory;
                              setLines(lines.map((x, j) => (j === i ? {
                                ...x,
                                vatCategory,
                                // Sales side: only 'S' carries a rate — AE/K must state 0
                                // (BR-AE-5 / BR-IC-5), and every other category is zero-rated too.
                                vatRate: vatCategory === 'S' ? (x.vatRate > 0 ? x.vatRate : defaultRate) : 0,
                              } : x)));
                            }}
                          >
                            {VAT_CATEGORIES.map((c) => <option key={c} value={c}>{t(`vat.category.${c}`)}</option>)}
                          </select>
                        </td>
                        <td className={styles.colAmount}>
                          <input
                            aria-label={t('einv.line.vatRate')}
                            inputMode="numeric"
                            className={styles.rateInput}
                            value={String(l.vatRate)}
                            disabled={l.vatCategory !== 'S'}
                            onChange={(e) => {
                              const v = Number(e.target.value);
                              setLines(lines.map((x, j) => (j === i ? { ...x, vatRate: Number.isFinite(v) ? v : defaultRate } : x)));
                            }}
                          />
                        </td>
                        <td className={styles.colAmount}>{fromCents(lineVatCents(l))}</td>
                        <td>
                          <button
                            type="button"
                            className={styles.ghostBtn}
                            onClick={() => setLines(lines.filter((_, j) => j !== i))}
                            disabled={lines.length === 1}
                          >
                            {t('einv.line.remove')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button
                type="button"
                className={styles.ghostBtn}
                onClick={() => setLines([...lines, { description: '', net: '', vatRate: defaultRate, vatCategory: 'S' }])}
              >
                {t('einv.line.add')}
              </button>
            </section>

            <section className={styles.card}>
              <dl className={styles.totals}>
                <div><dt>{t('einv.netTotal')}</dt><dd>{fromCents(netTotalCents)}</dd></div>
                <div><dt>{t('einv.vatTotal')}</dt><dd>{fromCents(vatTotalCents)}</dd></div>
                <div className={styles.grand}><dt>{t('einv.grandTotal')}</dt><dd>{fromCents(grandTotalCents)} {company?.baseCurrency ?? 'EUR'}</dd></div>
              </dl>
              {issueError && <p className={styles.formError} role="alert">{issueError}</p>}
              <button type="submit" className={styles.primaryBtn} disabled={!canIssue || issuing}>
                {issuing
                  ? t('einv.issuing')
                  : docType === 'credit_note'
                    ? t('einv.issueCreditNote')
                    : docType === 'recurring'
                      ? t('einv.rec.create')
                      : t('einv.issue')}
              </button>
            </section>
          </form>
        )}
      </main>
    </div>
  );
}

function ComposerSkeleton() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>
      </main>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<ComposerSkeleton />}>
      <ComposerInner />
    </Suspense>
  );
}
