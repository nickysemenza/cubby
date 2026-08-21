import { collectionSlugPattern } from "@cubby/shared/collection-tag";
import { z } from "zod";
import { locationShortcode, productShortcode } from "./identifiers";

export const collectionSlug = z
  .string()
  .min(1)
  .max(64)
  .regex(collectionSlugPattern, "Use a lowercase kebab-case Collection name");
export type CollectionSlug = z.infer<typeof collectionSlug>;

export const collectionSubject = z.discriminatedUnion("subject", [
  z.object({ subject: z.literal("product"), id: productShortcode }),
  z.object({ subject: z.literal("location"), id: locationShortcode }),
]);
export type CollectionSubject = z.infer<typeof collectionSubject>;

export const collectionSummaryOut = z.object({
  slug: collectionSlug,
  productCount: z.number().int().nonnegative(),
  rootLocationCount: z.number().int().nonnegative(),
});
export type CollectionSummaryOut = z.infer<typeof collectionSummaryOut>;

export const collectionLocationOut = z.object({
  id: locationShortcode,
  name: z.string(),
  path: z.array(z.string()),
});

export const collectionProductPlacementOut = z.object({
  id: locationShortcode,
  name: z.string(),
  path: z.array(z.string()),
});

export const collectionProductOut = z.object({
  id: productShortcode,
  name: z.string(),
  manufacturer: z.string(),
  direct: z.boolean(),
  inherited: z.boolean(),
  placements: z.array(collectionProductPlacementOut),
});
export type CollectionProductOut = z.infer<typeof collectionProductOut>;

export const collectionDetailInput = z.object({
  collection: collectionSlug,
  search: z.string().trim().optional(),
  pagination: z
    .object({
      pageIndex: z.number().int().nonnegative().default(0),
      pageSize: z.number().int().min(1).max(100).default(25),
    })
    .optional()
    .default({ pageIndex: 0, pageSize: 25 }),
});

export const collectionDetailOut = z.object({
  collection: collectionSummaryOut,
  roots: z.array(collectionLocationOut),
  products: z.array(collectionProductOut),
  totalCount: z.number().int().nonnegative(),
});
export type CollectionDetailOut = z.infer<typeof collectionDetailOut>;

export const collectionCellState = z.enum([
  "empty",
  "direct",
  "inherited",
  "both",
]);
export type CollectionCellState = z.infer<typeof collectionCellState>;

export const collectionMatrixSort = z.enum([
  "name-asc",
  "name-desc",
  "secondary-asc",
  "secondary-desc",
]);
export type CollectionMatrixSort = z.infer<typeof collectionMatrixSort>;

export const collectionMatrixMembership = z.enum([
  "member",
  "direct",
  "inherited",
  "unassigned",
]);
export type CollectionMatrixMembership = z.infer<
  typeof collectionMatrixMembership
>;

export const collectionMatrixInput = z.object({
  subject: z.enum(["product", "location"]),
  search: z.string().trim().optional(),
  sort: collectionMatrixSort.default("name-asc"),
  collection: collectionSlug.optional(),
  membership: collectionMatrixMembership.optional(),
  pagination: z
    .object({
      pageIndex: z.number().int().nonnegative().default(0),
      pageSize: z.number().int().min(1).max(500).default(500),
    })
    .optional()
    .default({ pageIndex: 0, pageSize: 500 }),
});

export const collectionMatrixRowOut = z.object({
  id: z.string(),
  name: z.string(),
  secondary: z.string().nullable(),
  imageUrl: z.string().nullable(),
  states: z.record(collectionSlug, collectionCellState),
});

export const collectionMatrixOut = z.object({
  collections: z.array(collectionSlug),
  rows: z.array(collectionMatrixRowOut),
  totalCount: z.number().int().nonnegative(),
});
export type CollectionMatrixOut = z.infer<typeof collectionMatrixOut>;

export const collectionTagSetInput = collectionSubject.and(
  z.object({ collection: collectionSlug, assigned: z.boolean() }),
);
export type CollectionTagSetInput = z.infer<typeof collectionTagSetInput>;

export const collectionTagSetOut = z.object({
  collection: collectionSlug,
  assigned: z.boolean(),
});

export const collectionCreateInput = collectionSubject.and(
  z.object({ collection: collectionSlug }),
);
