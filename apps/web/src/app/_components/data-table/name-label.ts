/**
 * The label a name column renders for one row.
 *
 * Exists as its own alias-free module because the rule below is the fix for a
 * real bug: `String(null)` rendered the literal text "null" in the cell, the
 * tooltip, AND the link.
 *
 * `stored` is what's actually persisted; `label` is what to display. They
 * differ for an unnamed row, and the caller must keep them apart: the inline
 * editor has to receive `stored`, or it would prefill with the derived
 * fallback and quietly persist it as a real name on the next save.
 */
import { z } from "zod";

const nameValueSchema = z.unknown();
type NameValueInput = z.input<typeof nameValueSchema>;

interface NameLabel {
  stored: string;
  label: string;
}

export const nameLabel = <T>(
  raw: NameValueInput,
  row: T,
  emptyLabel?: (row: T) => string,
): NameLabel => {
  const stored = raw == null ? "" : String(raw);
  return { stored, label: stored || emptyLabel?.(row) || "" };
};
