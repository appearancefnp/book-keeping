import { XMLParser } from 'fast-xml-parser';
import { escapeXml } from '../xml/escape.js';

export interface InvoiceParty { name: string; regNo: string; vatNo: string; }
export interface InvoiceLineIn { description: string; net: string; vatRate: number; vat: string; }
export interface EInvoice {
  invoiceNumber: string; issueDate: string; currency: string;
  supplier: InvoiceParty; customer: InvoiceParty; lines: InvoiceLineIn[];
  netTotal: string; vatTotal: string; grandTotal: string;
  dueDate?: string; note?: string; paymentTerms?: string;
}
export interface ECreditNote extends EInvoice { correctedInvoiceNumber?: string; }

const CUSTOMIZATION = 'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0';
const PROFILE = 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0';

function party(tag: string, p: InvoiceParty, cur: string): string {
  return [
    `  <cac:${tag}><cac:Party>`,
    `    <cac:PartyLegalEntity><cbc:RegistrationName>${escapeXml(p.name)}</cbc:RegistrationName><cbc:CompanyID>${escapeXml(p.regNo)}</cbc:CompanyID></cac:PartyLegalEntity>`,
    `    <cac:PartyTaxScheme><cbc:CompanyID>${escapeXml(p.vatNo)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>`,
    `  </cac:Party></cac:${tag}>`,
  ].join('\n');
}

export function buildUblInvoice(inv: EInvoice): string {
  const cur = inv.currency;
  const lines = inv.lines.map((l, i) => [
    `  <cac:InvoiceLine>`,
    `    <cbc:ID>${i + 1}</cbc:ID>`,
    `    <cbc:LineExtensionAmount currencyID="${cur}">${l.net}</cbc:LineExtensionAmount>`,
    `    <cac:Item><cbc:Name>${escapeXml(l.description)}</cbc:Name>`,
    `      <cac:ClassifiedTaxCategory><cbc:Percent>${l.vatRate}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>`,
    `  </cac:InvoiceLine>`,
  ].join('\n')).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">',
    `  <cbc:CustomizationID>${CUSTOMIZATION}</cbc:CustomizationID>`,
    `  <cbc:ProfileID>${PROFILE}</cbc:ProfileID>`,
    `  <cbc:ID>${escapeXml(inv.invoiceNumber)}</cbc:ID>`,
    `  <cbc:IssueDate>${escapeXml(inv.issueDate)}</cbc:IssueDate>`,
    inv.dueDate ? `  <cbc:DueDate>${escapeXml(inv.dueDate)}</cbc:DueDate>` : null,
    inv.note ? `  <cbc:Note>${escapeXml(inv.note)}</cbc:Note>` : null,
    `  <cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>`,
    party('AccountingSupplierParty', inv.supplier, cur),
    party('AccountingCustomerParty', inv.customer, cur),
    inv.paymentTerms ? `  <cac:PaymentTerms><cbc:Note>${escapeXml(inv.paymentTerms)}</cbc:Note></cac:PaymentTerms>` : null,
    `  <cac:TaxTotal><cbc:TaxAmount currencyID="${cur}">${inv.vatTotal}</cbc:TaxAmount></cac:TaxTotal>`,
    `  <cac:LegalMonetaryTotal>`,
    `    <cbc:LineExtensionAmount currencyID="${cur}">${inv.netTotal}</cbc:LineExtensionAmount>`,
    `    <cbc:TaxExclusiveAmount currencyID="${cur}">${inv.netTotal}</cbc:TaxExclusiveAmount>`,
    `    <cbc:TaxInclusiveAmount currencyID="${cur}">${inv.grandTotal}</cbc:TaxInclusiveAmount>`,
    `    <cbc:PayableAmount currencyID="${cur}">${inv.grandTotal}</cbc:PayableAmount>`,
    `  </cac:LegalMonetaryTotal>`,
    lines,
    '</Invoice>',
  ].filter(Boolean).join('\n');
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false });

function asArray<T>(v: T | T[] | undefined): T[] { return v === undefined ? [] : Array.isArray(v) ? v : [v]; }
function txt(v: unknown): string { return v && typeof v === 'object' && '#text' in (v as object) ? String((v as { '#text': unknown })['#text']) : String(v ?? ''); }
function readParty(p: Record<string, unknown>): InvoiceParty {
  return {
    name: String((p.PartyLegalEntity as { RegistrationName?: string })?.RegistrationName ?? ''),
    regNo: String((p.PartyLegalEntity as { CompanyID?: unknown })?.CompanyID ?? ''),
    vatNo: String((p.PartyTaxScheme as { CompanyID?: unknown })?.CompanyID ?? ''),
  };
}

export function parseUblInvoice(xml: string): EInvoice {
  const inv = parser.parse(xml)?.Invoice;
  if (!inv) throw new Error('Not a UBL Invoice');
  const sup = inv.AccountingSupplierParty?.Party ?? {};
  const cus = inv.AccountingCustomerParty?.Party ?? {};
  const mon = inv.LegalMonetaryTotal ?? {};
  return {
    invoiceNumber: String(inv.ID ?? ''),
    issueDate: String(inv.IssueDate ?? ''),
    currency: String(inv.DocumentCurrencyCode ?? ''),
    ...(inv.DueDate !== undefined && { dueDate: String(inv.DueDate) }),
    ...(inv.Note !== undefined && { note: String(inv.Note) }),
    ...((inv.PaymentTerms as { Note?: unknown })?.Note !== undefined && {
      paymentTerms: String((inv.PaymentTerms as { Note?: unknown }).Note),
    }),
    supplier: readParty(sup),
    customer: readParty(cus),
    lines: asArray(inv.InvoiceLine).map((l: Record<string, unknown>) => ({
      description: String((l.Item as { Name?: string })?.Name ?? ''),
      net: txt(l.LineExtensionAmount),
      vatRate: Number((((l.Item as { ClassifiedTaxCategory?: { Percent?: unknown } })?.ClassifiedTaxCategory)?.Percent) ?? 0),
      vat: '0',
    })),
    netTotal: txt(mon.LineExtensionAmount),
    vatTotal: txt(inv.TaxTotal?.TaxAmount),
    grandTotal: txt(mon.PayableAmount),
  };
}

export function buildUblCreditNote(cn: ECreditNote): string {
  const cur = cn.currency;
  const lines = cn.lines.map((l, i) => [
    `  <cac:CreditNoteLine>`,
    `    <cbc:ID>${i + 1}</cbc:ID>`,
    `    <cbc:CreditedQuantity unitCode="C62">1</cbc:CreditedQuantity>`,
    `    <cbc:LineExtensionAmount currencyID="${cur}">${l.net}</cbc:LineExtensionAmount>`,
    `    <cac:Item><cbc:Name>${escapeXml(l.description)}</cbc:Name>`,
    `      <cac:ClassifiedTaxCategory><cbc:Percent>${l.vatRate}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>`,
    `  </cac:CreditNoteLine>`,
  ].join('\n')).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">',
    `  <cbc:CustomizationID>${CUSTOMIZATION}</cbc:CustomizationID>`,
    `  <cbc:ProfileID>${PROFILE}</cbc:ProfileID>`,
    `  <cbc:ID>${escapeXml(cn.invoiceNumber)}</cbc:ID>`,
    `  <cbc:IssueDate>${escapeXml(cn.issueDate)}</cbc:IssueDate>`,
    cn.note ? `  <cbc:Note>${escapeXml(cn.note)}</cbc:Note>` : null,
    `  <cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>`,
    cn.correctedInvoiceNumber
      ? `  <cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${escapeXml(cn.correctedInvoiceNumber)}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>`
      : null,
    party('AccountingSupplierParty', cn.supplier, cur),
    party('AccountingCustomerParty', cn.customer, cur),
    `  <cac:TaxTotal><cbc:TaxAmount currencyID="${cur}">${cn.vatTotal}</cbc:TaxAmount></cac:TaxTotal>`,
    `  <cac:LegalMonetaryTotal>`,
    `    <cbc:LineExtensionAmount currencyID="${cur}">${cn.netTotal}</cbc:LineExtensionAmount>`,
    `    <cbc:TaxExclusiveAmount currencyID="${cur}">${cn.netTotal}</cbc:TaxExclusiveAmount>`,
    `    <cbc:TaxInclusiveAmount currencyID="${cur}">${cn.grandTotal}</cbc:TaxInclusiveAmount>`,
    `    <cbc:PayableAmount currencyID="${cur}">${cn.grandTotal}</cbc:PayableAmount>`,
    `  </cac:LegalMonetaryTotal>`,
    lines,
    '</CreditNote>',
  ].filter(Boolean).join('\n');
}

export function detectUblRoot(xml: string): 'Invoice' | 'CreditNote' | 'unknown' {
  const parsed = parser.parse(xml);
  if (parsed?.Invoice) return 'Invoice';
  if (parsed?.CreditNote) return 'CreditNote';
  return 'unknown';
}

export function parseUblCreditNote(xml: string): ECreditNote {
  const cn = parser.parse(xml)?.CreditNote;
  if (!cn) throw new Error('Not a UBL CreditNote');
  const sup = cn.AccountingSupplierParty?.Party ?? {};
  const cus = cn.AccountingCustomerParty?.Party ?? {};
  const mon = cn.LegalMonetaryTotal ?? {};
  const correctedInvoiceNumber = (cn.BillingReference as { InvoiceDocumentReference?: { ID?: unknown } })
    ?.InvoiceDocumentReference?.ID;
  return {
    invoiceNumber: String(cn.ID ?? ''),
    issueDate: String(cn.IssueDate ?? ''),
    currency: String(cn.DocumentCurrencyCode ?? ''),
    ...(cn.Note !== undefined && { note: String(cn.Note) }),
    ...(correctedInvoiceNumber !== undefined && { correctedInvoiceNumber: String(correctedInvoiceNumber) }),
    supplier: readParty(sup),
    customer: readParty(cus),
    lines: asArray(cn.CreditNoteLine).map((l: Record<string, unknown>) => ({
      description: String((l.Item as { Name?: string })?.Name ?? ''),
      net: txt(l.LineExtensionAmount),
      vatRate: Number((((l.Item as { ClassifiedTaxCategory?: { Percent?: unknown } })?.ClassifiedTaxCategory)?.Percent) ?? 0),
      vat: '0',
    })),
    netTotal: txt(mon.LineExtensionAmount),
    vatTotal: txt(cn.TaxTotal?.TaxAmount),
    grandTotal: txt(mon.PayableAmount),
  };
}
