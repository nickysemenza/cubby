import { z } from "zod";

export const amount = z
  .object({
    value: z.number(),
    unit: z.string().min(1),
    // Range upper bound for amounts like "2–3 cups" (lower is `value`). Absent
    // for ordinary point amounts. The ingredient parser emits this; costing and
    // nutrition propagate both bounds.
    upperValue: z.number().positive().optional(),
  })
  .refine((a) => a.upperValue === undefined || a.upperValue > a.value, {
    error: "Upper bound must be greater than the amount",
    path: ["upperValue"],
  });
export type Amount = z.infer<typeof amount>;

// Write boundaries require a positive lower value. Output schemas keep using the
// looser `amount` so legacy rows and parser output can still be displayed.
export const positiveAmount = amount.refine((a) => a.value > 0, {
  error: "Amount must be greater than zero",
  path: ["value"],
});

// Section names must be 2+ chars to satisfy recipeSectionInput validation
// downstream; drop anything shorter (or blank) to an unnamed section. Shared by
// the URL scraper, the EPUB cookbook adapter, and the Notion mapping so they all
// apply one rule.
export const sanitizeSectionName = (
  name: string | undefined | null,
): string | null => {
  const trimmed = name?.trim();
  return trimmed && trimmed.length >= 2 ? trimmed : null;
};

export const baseKind = z.enum(["weight", "volume", "money", "calories"]);
export type BaseKind = z.infer<typeof baseKind>;
