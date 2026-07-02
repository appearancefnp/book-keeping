// Shared, locale-aware formatting for the cabinet UI.
// Matches the posting table's convention: lv-LV grouping, 2 decimals, currency as a suffix.

export function formatMoney(value: number, currency = 'EUR'): string {
  if (!isFinite(value)) return `${value}`;
  const n = new Intl.NumberFormat('lv-LV', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
  return currency ? `${n} ${currency}` : n;
}

// Ledger money is stored as integer cents (as a string on the wire).
export function formatCents(cents: string | number | undefined, currency = 'EUR'): string | null {
  if (cents === undefined || cents === null || cents === '') return null;
  const n = typeof cents === 'number' ? cents : Number(cents);
  if (isNaN(n)) return null;
  return formatMoney(n / 100, currency);
}

// Decimal-string money (e.g. "21.00") straight from a VAT computation.
export function formatDecimal(value: string | number | undefined, currency = 'EUR'): string | null {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (isNaN(n)) return null;
  return formatMoney(n, currency);
}

// A closed date range, rendered consistently with the posting card's ISO dates.
export function formatDateRange(from?: string, to?: string): string | null {
  if (from && to) return `${from} – ${to}`;
  return from || to || null;
}
