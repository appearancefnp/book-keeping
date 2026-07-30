/**
 * EN 16931 VAT category codes (BT-151, UNCL5305 subset) and every rule derived from them.
 * Pure — no DB, no side effects — so both the domain and the UBL layer can share it.
 */
export type VatCategory = 'S' | 'Z' | 'E' | 'AE' | 'K' | 'G' | 'O';

/** S standard · Z zero-rated · E exempt · AE reverse charge · K intra-Community · G export · O out of scope. */
export const VAT_CATEGORIES: readonly VatCategory[] = ['S', 'Z', 'E', 'AE', 'K', 'G', 'O'];

export function isVatCategory(v: string): v is VatCategory {
  return (VAT_CATEGORIES as readonly string[]).includes(v);
}

/** Only a standard-rated line charges VAT to the counterparty. */
export function chargesVat(cat: VatCategory): boolean {
  return cat === 'S';
}

/** On the purchase side, AE and K mean the buyer self-assesses the VAT. */
export function selfAssesses(cat: VatCategory): boolean {
  return cat === 'AE' || cat === 'K';
}

/** Sales in these categories belong on the EC Sales List (PVN 2). */
export function inEcsl(cat: VatCategory): boolean {
  return cat === 'AE' || cat === 'K';
}

/**
 * An intra-EU goods supply is categorised K; an intra-EU B2B service where the customer
 * accounts for the VAT is AE. The category therefore carries the ECSL supply type and no
 * separate goods/services column is needed.
 */
export function ecslSupplyType(cat: VatCategory): 'goods' | 'services' | null {
  if (cat === 'K') return 'goods';
  if (cat === 'AE') return 'services';
  return null;
}

export interface ExemptionReason { code?: string; text: string }

/**
 * BT-120 (reason code) / BT-121 (reason text). S needs none; Z needs none either
 * (BR-Z requires a zero rate, not a reason).
 */
export function exemptionReasonFor(cat: VatCategory): ExemptionReason | null {
  switch (cat) {
    case 'S': return null;
    case 'Z': return null;
    case 'E': return { code: 'VATEX-EU-132', text: 'Exempt supply' };
    case 'AE': return { text: 'Reverse charge' };
    case 'K': return { code: 'VATEX-EU-IC', text: 'Intra-Community supply' };
    case 'G': return { code: 'VATEX-EU-147', text: 'Export outside the EU' };
    case 'O': return { text: 'Not subject to VAT' };
  }
}

/**
 * Self-assessed VAT for one line: net × rate, half-up to the cent. Same arithmetic as
 * the inbound per-line derivation in src/einvoice/inbound.ts, kept in one place.
 */
export function selfAssessedVatCents(netCents: bigint, vatRate: number): bigint {
  const rateBp = BigInt(Math.round(vatRate * 100)); // 21 -> 2100 basis points
  return (netCents * rateBp + 5000n) / 10000n;
}

/**
 * Consistency rules between a line's category, its rate, and its *invoiced* VAT.
 * Returns EN 16931-flavoured issue strings; empty means consistent. Shared by the zod
 * schemas (bills, credit notes) and validateEn16931 so both reject the same shapes.
 */
export function categoryIssues(
  line: { vatCategory: VatCategory; vatRate: number; vatCents: bigint },
): string[] {
  const issues: string[] = [];
  const { vatCategory: cat, vatRate: rate, vatCents: vat } = line;

  if (cat === 'S') {
    if (!(rate > 0)) issues.push('BR-S-5: a standard-rated line requires a VAT rate greater than zero');
    return issues;
  }

  // Every non-standard category invoices zero VAT. AE/K still carry the rate that
  // self-assessment multiplies by, so a zero rate there is a mistake.
  if (vat !== 0n) {
    const rule = cat === 'K' ? 'BR-IC-8' : cat === 'AE' ? 'BR-AE-8' : `BR-${cat}-8`;
    issues.push(`${rule}: a '${cat}' line must carry zero invoiced VAT`);
  }
  if (selfAssesses(cat)) {
    if (!(rate > 0)) {
      const rule = cat === 'K' ? 'BR-IC-5' : 'BR-AE-5';
      issues.push(`${rule}: a '${cat}' line requires the domestic VAT rate used for self-assessment`);
    }
  } else if (rate !== 0) {
    issues.push(`BR-${cat}-5: a '${cat}' line must have a zero VAT rate`);
  }
  return issues;
}
