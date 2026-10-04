/**
 * The unpriced-stock note ("no pricing for 2, 1 misc") from the bare counts
 * persisted on `location.valuation`; the server's valuation report and the
 * web inventory summary both read it.
 */
export function formatPricingCountsSummary(
  counts: { missingPricing: number; miscNoPrice: number } | undefined | null,
): string | null {
  if (!counts) return null;
  const parts: string[] = [];
  if (counts.missingPricing > 0) {
    parts.push(`no pricing for ${counts.missingPricing}`);
  }
  if (counts.miscNoPrice > 0) {
    parts.push(`${counts.miscNoPrice} misc`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}
