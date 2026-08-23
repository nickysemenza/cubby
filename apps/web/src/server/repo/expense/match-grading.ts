import type { ExpenseMatchRatioLabel } from "@cubby/schemas/project";

/**
 * Pure presentation-grade signals for reconciliation candidates. They must
 * never decide which rows SQL returns; see match.ts for the query boundary.
 */

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "pack",
  "pc",
  "pcs",
  "set",
  "the",
  "to",
  "with",
  "x",
]);

/** Lowercase alphanumeric tokens, stopwords and 1-character noise dropped. */
export const tokenizeMatchLabel = (
  value: string | null | undefined,
): Set<string> => {
  if (!value) return new Set();
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 1 && !STOPWORDS.has(token)),
  );
};

export const countTokenOverlap = (a: Set<string>, b: Set<string>): number => {
  let n = 0;
  for (const token of a) if (b.has(token)) n += 1;
  return n;
};

/**
 * Classify `cost / amount` against the tax rate. A one-cent difference is
 * exact; all other bands are deliberately explanatory rather than filters.
 */
export const classifyMatchRatio = (
  amountDelta: number | null,
  ratio: number | null,
  taxRate: number,
): ExpenseMatchRatioLabel => {
  if (amountDelta !== null && Math.round(Math.abs(amountDelta) * 100) <= 1)
    return "exact";
  if (ratio === null) return "other";
  const band = 0.005;
  if (Math.abs(ratio - (1 + taxRate)) <= band) return "plus_tax";
  if (Math.abs(ratio - 1 / (1 + taxRate)) <= band) return "pre_tax";
  return "other";
};
