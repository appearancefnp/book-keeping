import type { ReportLabels } from '@domain/reports/tabular.js';
import { EN, LV, RU } from '@/app/lib/i18n';

export type ExportLang = 'lv' | 'en' | 'ru';
const PACKS: Record<ExportLang, Record<keyof typeof EN, string>> = { en: EN, lv: LV, ru: RU };

/** Map the report-export i18n keys into the domain ReportLabels shape, plus the print button label. */
export function reportLabels(lang: ExportLang): ReportLabels & { print: string } {
  const m = PACKS[lang] ?? PACKS.lv;
  return {
    pl: m['reports.tab.pl'], bs: m['reports.tab.bs'], gl: m['reports.tab.gl'], trial: m['reports.tab.trial'], apAging: m['reports.tab.apaging'], arAging: m['reports.tab.araging'],
    cashFlow: m['reports.tab.cashflow'], equityStmt: m['reports.tab.equity'],
    period: m['reports.from'], asOf: m['reports.asOf'], comparisonPeriod: m['reports.compareTo'], client: m['top.client'], generated: m['export.generated'],
    income: m['reports.income'], expense: m['reports.expense'], assets: m['reports.assets'], liabilities: m['reports.liabilities'], equity: m['reports.equity'],
    netProfit: m['reports.netProfit'], currentResult: m['reports.currentResult'], totalAssets: m['reports.totalAssets'], totalLiabEquity: m['reports.totalLiabEquity'],
    operating: m['reports.cf.operating'], investing: m['reports.cf.investing'], financing: m['reports.cf.financing'],
    netChange: m['reports.cf.netChange'], openingCash: m['reports.cf.openingCash'], closingCash: m['reports.cf.closingCash'],
    movement: m['reports.eq.movement'], resultForPeriod: m['reports.eq.result'],
    code: m['reports.col.code'], account: m['reports.gl.account'], amount: m['reports.col.amount'],
    current: m['reports.col.current'], comparison: m['reports.col.comparison'], variance: m['reports.col.variance'], variancePct: m['reports.col.variancePct'],
    date: m['reports.col.date'], memo: m['reports.col.memo'], description: m['reports.col.description'], debit: m['reports.col.debit'], credit: m['reports.col.credit'],
    balance: m['reports.col.balance'], opening: m['reports.gl.opening'], closing: m['reports.gl.closing'], total: m['reports.aging.total'],
    bucketCurrent: m['reports.aging.current'], d1_30: m['reports.aging.d1_30'], d31_60: m['reports.aging.d31_60'], d61_90: m['reports.aging.d61_90'], d90plus: m['reports.aging.d90plus'],
    vatReturn: m['filings.tab.vatreturn'], ecsl: m['filings.tab.ecsl'],
    category: m['filings.col.category'], salesNet: m['filings.col.salesNet'], salesVat: m['filings.col.salesVat'],
    purchaseNet: m['filings.col.purchaseNet'], purchaseVat: m['filings.col.purchaseVat'], selfAssessedVat: m['filings.col.selfAssessedVat'],
    country: m['filings.col.country'], vatNo: m['filings.col.vatNo'], supplyType: m['filings.col.supplyType'],
    goods: m['filings.goods'], services: m['filings.services'], invoices: m['filings.col.invoices'],
    outputVat: m['filings.outputVat'], inputVat: m['filings.inputVat'], netPayable: m['filings.netPayable'],
    reconciled: m['filings.reconciled'], notReconciled: m['filings.notReconciled'],
    print: m['export.print'],
  };
}
