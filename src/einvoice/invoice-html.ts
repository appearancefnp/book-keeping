import type { EInvoice } from './ubl.js';
import { escapeXml } from '../xml/escape.js';
import { toCents, fromCents } from '../db/money.js';

type DocLang = 'lv' | 'en' | 'ru';

type LabelSet = {
  invoice: string; from: string; billTo: string; regNo: string; vatNo: string;
  issue: string; due: string; desc: string; net: string; vat: string; lineVat: string;
  netTotal: string; vatTotal: string; grand: string; note: string; terms: string; print: string;
};

const LABELS: Record<DocLang, LabelSet> = {
  en: { invoice: 'Invoice', from: 'From', billTo: 'Bill to', regNo: 'Reg. No', vatNo: 'VAT No', issue: 'Issue date', due: 'Due date', desc: 'Description', net: 'Net', vat: 'VAT', lineVat: 'VAT amount', netTotal: 'Net total', vatTotal: 'VAT total', grand: 'Total', note: 'Note', terms: 'Payment terms', print: 'Print / Save as PDF' },
  lv: { invoice: 'Rēķins', from: 'No', billTo: 'Saņēmējs', regNo: 'Reģ. Nr.', vatNo: 'PVN Nr.', issue: 'Izrakstīšanas datums', due: 'Apmaksas termiņš', desc: 'Apraksts', net: 'Neto', vat: 'PVN', lineVat: 'PVN summa', netTotal: 'Neto kopā', vatTotal: 'PVN kopā', grand: 'Kopā', note: 'Piezīme', terms: 'Apmaksas nosacījumi', print: 'Drukāt / Saglabāt PDF' },
  ru: { invoice: 'Счёт', from: 'От', billTo: 'Получатель', regNo: 'Рег. №', vatNo: 'НДС №', issue: 'Дата выставления', due: 'Срок оплаты', desc: 'Описание', net: 'Нетто', vat: 'НДС', lineVat: 'Сумма НДС', netTotal: 'Нетто итого', vatTotal: 'НДС итого', grand: 'Итого', note: 'Примечание', terms: 'Условия оплаты', print: 'Печать / Сохранить PDF' },
};

const money = (v: string, cur: string) => `${escapeXml(v)}&nbsp;${escapeXml(cur)}`;

function lineVat(net: string, rate: number): string {
  return fromCents((toCents(net) * BigInt(Math.round(rate))) / 100n);
}

export function renderInvoiceHtml(
  inv: EInvoice,
  opts: { footer: string | null; logoDataUri: string | null; lang: DocLang },
): string {
  const L = LABELS[opts.lang] ?? LABELS.lv;
  const cur = inv.currency;
  const logo = opts.logoDataUri
    ? `<img class="logo" src="${escapeXml(opts.logoDataUri)}" alt="" />`
    : '';
  const rows = inv.lines.map((l) => `
        <tr>
          <td>${escapeXml(l.description)}</td>
          <td class="num">${money(l.net, cur)}</td>
          <td class="num">${escapeXml(String(l.vatRate))}%</td>
          <td class="num">${money(lineVat(l.net, l.vatRate), cur)}</td>
        </tr>`).join('');
  const party = (label: string, p: { name: string; regNo: string; vatNo: string }) => `
      <div class="party">
        <div class="party-label">${escapeXml(label)}</div>
        <div class="party-name">${escapeXml(p.name)}</div>
        <div>${escapeXml(L.regNo)}: ${escapeXml(p.regNo)}</div>
        <div>${escapeXml(L.vatNo)}: ${escapeXml(p.vatNo)}</div>
      </div>`;
  return `<div class="invoice-doc">
    <style>
      .invoice-doc { font-family: system-ui, sans-serif; color: #1a1a1a; max-width: 800px; margin: 0 auto; padding: 32px; }
      .invoice-doc .head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; }
      .invoice-doc .logo { max-height: 64px; max-width: 240px; }
      .invoice-doc h1 { font-size: 1.5rem; margin: 0 0 4px; }
      .invoice-doc .parties { display: flex; gap: 48px; margin-bottom: 24px; }
      .invoice-doc .party-label { font-size: 0.75rem; text-transform: none; color: #666; margin-bottom: 4px; }
      .invoice-doc .party-name { font-weight: 600; }
      .invoice-doc table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
      .invoice-doc th, .invoice-doc td { padding: 8px; border-bottom: 1px solid #ddd; text-align: left; }
      .invoice-doc .num { text-align: right; font-variant-numeric: tabular-nums; }
      .invoice-doc .totals { margin-left: auto; width: 260px; }
      .invoice-doc .totals .num { text-align: right; }
      .invoice-doc .grand { font-weight: 700; }
      .invoice-doc .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #ddd; color: #555; font-size: 0.85rem; white-space: pre-wrap; }
      @media print { .print-btn { display: none !important; } }
    </style>
    <div class="head">
      <div>${logo}</div>
      <div style="text-align:right">
        <h1>${escapeXml(L.invoice)}</h1>
        <div>${escapeXml(inv.invoiceNumber)}</div>
        <div>${escapeXml(L.issue)}: ${escapeXml(inv.issueDate)}</div>
        ${inv.dueDate ? `<div>${escapeXml(L.due)}: ${escapeXml(inv.dueDate)}</div>` : ''}
      </div>
    </div>
    <div class="parties">
      ${party(L.from, inv.supplier)}
      ${party(L.billTo, inv.customer)}
    </div>
    <table>
      <thead><tr>
        <th>${escapeXml(L.desc)}</th><th class="num">${escapeXml(L.net)}</th>
        <th class="num">${escapeXml(L.vat)}</th><th class="num">${escapeXml(L.lineVat)}</th>
      </tr></thead>
      <tbody>${rows}
      </tbody>
    </table>
    <table class="totals"><tbody>
      <tr><td>${escapeXml(L.netTotal)}</td><td class="num">${money(inv.netTotal, cur)}</td></tr>
      <tr><td>${escapeXml(L.vatTotal)}</td><td class="num">${money(inv.vatTotal, cur)}</td></tr>
      <tr class="grand"><td>${escapeXml(L.grand)}</td><td class="num">${money(inv.grandTotal, cur)}</td></tr>
    </tbody></table>
    ${inv.note ? `<div><strong>${escapeXml(L.note)}:</strong> ${escapeXml(inv.note)}</div>` : ''}
    ${inv.paymentTerms ? `<div><strong>${escapeXml(L.terms)}:</strong> ${escapeXml(inv.paymentTerms)}</div>` : ''}
    ${opts.footer ? `<div class="footer">${escapeXml(opts.footer)}</div>` : ''}
  </div>`;
}
