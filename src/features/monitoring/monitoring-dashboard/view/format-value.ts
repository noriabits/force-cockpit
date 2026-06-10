/**
 * Pure value formatter shared by chart axes/tooltips, metric tiles, and tables.
 * No DOM access — string-in/string-out so it can be unit-tested in isolation.
 *
 * `currency` → locale string with 2 decimals. `percent` → one decimal + '%'.
 * Otherwise: integers get thousands separators, decimals are capped at 2 places.
 * Non-numeric input is returned as-is (empty string for null/undefined).
 */
export function formatValue(value: unknown, format?: string): string {
  const num = Number(value);
  if (isNaN(num)) return String(value ?? '');
  if (format === 'currency') {
    return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (format === 'percent') {
    return num.toFixed(1) + '%';
  }
  if (Number.isInteger(num)) return num.toLocaleString();
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
