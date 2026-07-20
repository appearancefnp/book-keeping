'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { fetchClients, type ClientCompany } from '@/app/lib/api-client';
import { ErrorState } from '@/app/components/ErrorState';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import styles from './page.module.css';

interface PartyRow { id: string; kind: 'customer' | 'vendor' | 'both'; name: string; regNo: string | null; vatNo: string | null; }
interface LineDraft { description: string; net: string; vatRate: number; }
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

  const [docType, setDocType] = useState<'invoice' | 'credit_note'>('invoice');
  const [correctedInvoiceNumber, setCorrectedInvoiceNumber] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [issueDate, setIssueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [customerId, setCustomerId] = useState('');
  const [peppolId, setPeppolId] = useState('');
  const [supplierVatNo, setSupplierVatNo] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([{ description: '', net: '', vatRate: 21 }]);
  const [note, setNote] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [offsetDays, setOffsetDays] = useState<number | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);

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
          setLines((ls) => ls.map((l) => ({ ...l, vatRate: body.rate! })));
        }
      }
      if (pfRes.ok) {
        const profile = ((await pfRes.json()) as { profile: InvoiceProfileDTO | null }).profile;
        if (profile) {
          if (profile.numberPrefix && !invoiceNumber.trim()) setInvoiceNumber(profile.numberPrefix);
          if (profile.defaultLines?.length) {
            setLines(profile.defaultLines.map((l) => ({ description: l.description, net: l.net, vatRate: l.vatRate })));
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

  const netTotalCents = lines.reduce((acc, l) => acc + toCents(l.net), 0);
  const vatTotalCents = lines.reduce((acc, l) => acc + lineVatCents(l), 0);
  const grandTotalCents = netTotalCents + vatTotalCents;

  const canIssue =
    !!clientCompanyId && !!company && !!customer && !!invoiceNumber.trim() && !!peppolId.trim() &&
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
          {docType === 'credit_note' ? t('einv.composeCreditNote') : t('einv.compose')}
        </h1>

        {customers.length === 0 ? (
          <p className={styles.notice}>{t('einv.noCustomers')}</p>
        ) : (
          <form className={styles.composer} onSubmit={(e) => { e.preventDefault(); issue(); }}>
            <section className={styles.card}>
              <div className={styles.fieldGrid}>
                <label className={styles.field}>
                  <span>{t('einv.docType')}</span>
                  <select value={docType} onChange={(e) => setDocType(e.target.value as 'invoice' | 'credit_note')}>
                    <option value="invoice">{t('einv.mode.invoice')}</option>
                    <option value="credit_note">{t('einv.mode.creditNote')}</option>
                  </select>
                </label>
                <label className={styles.field}>
                  <span>{t('einv.number')}</span>
                  <input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} required />
                </label>
                <label className={styles.field}>
                  <span>{t('einv.issueDate')}</span>
                  <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required />
                </label>
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
              </div>
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
                        <td className={styles.colAmount}>
                          <input
                            aria-label={t('einv.line.vatRate')}
                            inputMode="numeric"
                            className={styles.rateInput}
                            value={String(l.vatRate)}
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
                onClick={() => setLines([...lines, { description: '', net: '', vatRate: defaultRate }])}
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
