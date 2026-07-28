/**
 * The label a name column renders for one row.
 *
 * Exists as its own alias-free module for two reasons: the rule below is the
 * fix for a real bug (`String(null)` rendered the literal text "null" in the
 * cell, the tooltip, AND the link), and `columnHelpers.tsx` transitively
 * reaches the WASM unit engine, which the jsdom test project can't load — so
 * this is the only way to pin the rule in a unit test.
 *
 * `stored` is what's actually persisted; `label` is what to display. They
 * differ for an unnamed row, and the caller must keep them apart: the inline
 * editor has to receive `stored`, or it would prefill with the derived
 * fallback and quietly persist it as a real name on the next save.
 */
export const nameLabel = <T>(
  raw: unknown,
  row: T,
  emptyLabel?: (row: T) => string,
): { stored: string; label: string } => {
  const stored = raw == null ? "" : String(raw);
  return { stored, label: stored || emptyLabel?.(row) || "" };
};
