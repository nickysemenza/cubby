import { z } from "zod";

export const amount = z.object({
  value: z.number(),
  unit: z.string().min(1),
});
export type Amount = z.infer<typeof amount>;

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
