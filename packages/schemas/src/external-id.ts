import { z } from "zod";

export const externalIdSource = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "source must be a lowercase kebab-case slug",
  );

export const externalIdKind = z.enum([
  "asin",
  "retailer_sku",
  "internet_number",
  "item_number",
  "catalog_number",
  "legacy_unspecified",
]);
export type ExternalIdKind = z.infer<typeof externalIdKind>;

export const canonicalExternalIdUrl = (value: {
  source: string;
  kind: ExternalIdKind;
  externalId: string;
  url?: string | null;
}): string | null =>
  value.source === "amazon" && value.kind === "asin"
    ? `https://www.amazon.com/dp/${encodeURIComponent(value.externalId)}`
    : (value.url ?? null);

/** Canonical Amazon links are derived from ASIN rather than stored twice. */
export const storedExternalIdUrl = (value: {
  source: string;
  kind: ExternalIdKind;
  url?: string | null;
}): string | null =>
  value.source === "amazon" && value.kind === "asin"
    ? null
    : (value.url ?? null);

const externalIdValueFields = {
  source: externalIdSource.describe(
    "Canonical provider slug (e.g. 'amazon', 'home-depot', 'mcmaster')",
  ),
  kind: externalIdKind,
  externalId: z
    .string()
    .min(1)
    .describe("The actual identifier (ASIN, part number, etc.)"),
  url: z
    .string()
    .url()
    .nullish()
    .describe("Optional direct link to the product page"),
};

export const externalIdValueInput = z.object(externalIdValueFields);

export const externalIdInput = z.object({
  ...externalIdValueFields,
  id: z.uuid().optional(),
});

export type ExternalIdInput = z.infer<typeof externalIdInput>;

const uniqueExternalIdSlots = <T extends z.ZodType>(item: T) =>
  z.array(item).superRefine((values, ctx) => {
    const slots = new Set<string>();
    for (const [index, value] of values.entries()) {
      const entry = value as { source: string; kind: ExternalIdKind };
      const key = `${entry.source}\u0000${entry.kind}`;
      if (slots.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: "each Product may have only one identifier per source/kind",
          path: [index, "kind"],
        });
      }
      slots.add(key);
    }
  });

export const externalIdInputs = uniqueExternalIdSlots(externalIdInput);
export const externalIdValues = uniqueExternalIdSlots(externalIdValueInput);

export const externalIdOut = z.object({
  id: z.uuid(),
  source: externalIdSource.describe(
    "Canonical provider slug (e.g. 'amazon', 'home-depot', 'mcmaster')",
  ),
  kind: externalIdKind,
  externalId: z
    .string()
    .min(1)
    .describe("The actual identifier (ASIN, part number, etc.)"),
  url: z
    .string()
    .url()
    .nullish()
    .describe("Optional direct link to the product page"),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ExternalIdOut = z.infer<typeof externalIdOut>;
