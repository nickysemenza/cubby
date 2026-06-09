/**
 * Format a number as USD currency, e.g. `1234.5` → `"$1,234.50"`.
 * Shared by web and mobile so price formatting can't drift between platforms.
 *
 * @param value - The amount in dollars
 * @param decimals - Maximum fraction digits (default: 2)
 */
export function formatCurrency(value: number, decimals = 2): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: decimals,
  }).format(value);
}
