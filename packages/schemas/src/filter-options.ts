import { z } from "zod";

/** High-cardinality rosters served to list filters without hydrating entities. */
export const filterOptionKind = z.enum([
  "ingredientWithProduct",
  "locationIdentityProduct",
  "locationWithInventory",
  "product",
  "project",
  "task",
  "vendor",
]);
export type FilterOptionKind = z.infer<typeof filterOptionKind>;

export const filterOptionsInput = z.object({
  kind: filterOptionKind,
  search: z.string().trim().max(100).default(""),
  cursor: z.string().regex(/^\d+$/u).optional(),
  selectedIds: z.array(z.string().min(1)).max(50).default([]),
  limit: z.number().int().min(1).max(50).default(25),
});
export type FilterOptionsInput = z.infer<typeof filterOptionsInput>;

export const filterOptionItem = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string().optional(),
});
export type FilterOptionItem = z.infer<typeof filterOptionItem>;

export const filterOptionsOut = z.object({
  items: z.array(filterOptionItem),
  nextCursor: z.string().nullable(),
});
export type FilterOptionsOut = z.infer<typeof filterOptionsOut>;
