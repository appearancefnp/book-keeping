import { requireSession } from '@/app/lib/require-session';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { getEinvoiceUbl } from '@domain/einvoice/query.js';
import { parseUblInvoice } from '@domain/einvoice/ubl.js';
import { getInvoiceProfile } from '@domain/einvoice/invoice-profile.js';
import { renderInvoiceHtml } from '@domain/einvoice/invoice-html.js';
import { makeBlobStore } from '@domain/blob/factory.js';
import { PrintButton } from './PrintButton';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const blob = makeBlobStore();
const LABEL_PRINT: Record<'lv' | 'en' | 'ru', string> = { lv: 'Drukāt / Saglabāt PDF', en: 'Print / Save as PDF', ru: 'Печать / Сохранить PDF' };

export default async function InvoiceDocumentPage(
  { params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ client?: string; lang?: string }> },
) {
  await requireSession();
  const { id } = await params;
  const sp = await searchParams;
  const client = sp.client;
  const lang = (sp.lang === 'en' || sp.lang === 'ru' ? sp.lang : 'lv') as 'lv' | 'en' | 'ru';
  if (!client) return <main style={{ padding: 32 }}>Missing client.</main>;

  const token = await getSessionToken();
  let html: string | null = null;
  try {
    const ctx = await resolveTenantContext(token!, client, nowUnix());
    const data = await withTenant(ctx, async (tx) => {
      const ei = await getEinvoiceUbl(tx, ctx, id);
      if (!ei) return null;
      const profile = await getInvoiceProfile(tx, ctx);
      return { ei, profile };
    });
    if (data) {
      const inv = parseUblInvoice(data.ei.ublXml);
      let logoDataUri: string | null = null;
      if (data.profile?.logoBlobKey) {
        try {
          const { bytes, mime } = await blob.get(data.profile.logoBlobKey);
          logoDataUri = `data:${mime};base64,${bytes.toString('base64')}`;
        } catch { logoDataUri = null; }
      }
      html = renderInvoiceHtml(inv, { footer: data.profile?.footer ?? null, logoDataUri, lang });
    }
  } catch {
    html = null;
  }

  if (!html) return <main style={{ padding: 32 }}>Invoice not found.</main>;
  return (
    <main>
      <PrintButton label={LABEL_PRINT[lang] ?? LABEL_PRINT.lv} />
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </main>
  );
}
