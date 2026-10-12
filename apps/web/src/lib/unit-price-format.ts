import { formatCurrency } from "~/lib/number-format";

/**
 * A comparable unit price needs more precision than money usually does: onions
 * land near $0.003/g, and the 2-decimal default renders that as $0.00 — worse
 * than showing nothing, because it reads as free.
 *
 * So the precision follows the magnitude, and only far enough to carry two
 * significant digits. Sub-cent values are the common case here, not an edge one.
 */
export const formatUnitPrice = (price: number): string => {
  if (price === 0) return formatCurrency(0);
  const magnitude = Math.abs(price);
  const decimals = magnitude >= 1 ? 2 : magnitude >= 0.01 ? 3 : 5;
  return formatCurrency(price, decimals);
};

/**
 * "$3.49/ea", "$0.085/fl oz": one unit price against its natural basis. A
 * count reads "ea" so a table column stays narrow; measures keep their names.
 */
export const formatPerUnitPrice = (natural: {
  price: number;
  unit: string;
}): string =>
  `${formatUnitPrice(natural.price)}/${natural.unit === "each" ? "ea" : natural.unit}`;
