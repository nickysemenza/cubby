import { relatedViewRegistry } from "./generated/related-views.gen";
export { relatedViewRegistry } from "./generated/related-views.gen";
import { z } from "zod";
import type { Entity } from "./entity";
import { money } from "./money";
import { sortDirection } from "./pagination";
import { entitySchema } from "./entity-core";
import { imageUrlSummary } from "./image-summary";
import { nonEmptyTuple } from "./identifier-fields";

interface RelatedViewPresentationDefinition {
  key: string;
  source: Entity;
  relationship?: string;
  defaultVisible: boolean;
  /** Thematic band for this relation's optional table column. */
  columnGroup?: string;
  order: "alphabetical" | "newest" | "task";
  filterPrefix?: string;
  /**
   * The directional key that realizes this same relationship from the other
   * endpoint.  A relation can still be one-way when its reverse is not a
   * useful list/table concept; callers must not manufacture SQL from paths.
   */
  inverseKey?: string;
}

/** Fully resolved runtime projection; presentation declarations never carry paths. */
export interface RelatedViewDefinition extends RelatedViewPresentationDefinition {
  target: Entity;
  label: string;
}

export const relatedViewKeys = nonEmptyTuple(
  relatedViewRegistry.map((view) => view.key),
);
export const relatedViewKeySchema = z.enum(relatedViewKeys);
export type RelatedViewKey = z.infer<typeof relatedViewKeySchema>;

export const relatedPreviewInput = z.object({
  source: entitySchema,
  // Infinite tables accumulate pages. Keep one request bounded, but high
  // enough that loading a few pages never turns a successful list into a 400.
  sourceIds: z.array(z.string()).max(1000),
  relationKeys: z.array(relatedViewKeySchema).max(16),
});
export type RelatedPreviewInput = z.infer<typeof relatedPreviewInput>;

export const relatedPreviewItem = z.object({
  entity: entitySchema,
  id: z.string(),
  label: z.string(),
  displayImage: imageUrlSummary.nullable(),
});
export type RelatedPreviewItem = z.infer<typeof relatedPreviewItem>;

export const relatedPreviewGroup = z.object({
  sourceId: z.string(),
  relationKey: relatedViewKeySchema,
  totalCount: z.number().int().nonnegative(),
  items: z.array(relatedPreviewItem).max(3),
});
export type RelatedPreviewGroup = z.infer<typeof relatedPreviewGroup>;

export const relatedPreviewOutput = z.array(relatedPreviewGroup);

export const relatedBranchInput = z.object({
  relationKey: relatedViewKeySchema,
  sourceId: z.string().min(1),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(25),
});
export type RelatedBranchInput = z.infer<typeof relatedBranchInput>;

export const relatedBranchOutput = z.object({
  sourceId: z.string(),
  relationKey: relatedViewKeySchema,
  totalCount: z.number().int().nonnegative(),
  items: z.array(relatedPreviewItem),
  nextOffset: z.number().int().nonnegative().nullable(),
});

export const relatedSummaryRelationKeys = [
  "vendor.products",
  "vendor.projects",
  "purchase.projects",
  "project.vendors",
  "project.purchasedProducts",
  "product.vendors",
] as const;
export const relatedSummaryRelationKeySchema = z.enum(
  relatedSummaryRelationKeys,
);
export type RelatedSummaryRelationKey = z.infer<
  typeof relatedSummaryRelationKeySchema
>;

export const relatedSummarySortFieldSchema = z.enum([
  "target",
  "latestActivity",
  "netSpend",
  "purchaseCount",
  "expenseCount",
  "knownAcquiredUnits",
]);

export const relatedSummaryInput = z
  .object({
    relationKey: relatedSummaryRelationKeySchema,
    sourceId: z.string().min(1),
    includeSubProjects: z.boolean().optional(),
    search: z.string().trim().max(200).optional(),
    sort: z
      .object({
        field: relatedSummarySortFieldSchema,
        direction: sortDirection,
      })
      .strict()
      .optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict();
export type RelatedSummaryInput = z.infer<typeof relatedSummaryInput>;

const relatedSummaryImage = z
  .object({
    id: z.string(),
    url: z.string(),
    filename: z.string(),
    contentType: z.string(),
  })
  .strict();
const relatedSummaryTarget = z
  .object({
    // Summary targets are deliberately narrower than the general relationship
    // graph: these six aggregates only ever group products, projects, or
    // vendors. Keeping that in the public contract prevents UI casts from
    // masking a repository/registry mismatch.
    entity: z.enum(["product", "project", "vendor"]),
    id: z.string(),
    label: z.string(),
    image: relatedSummaryImage.nullable(),
  })
  .strict();
const relatedSummaryRow = z
  .object({
    target: relatedSummaryTarget.nullable(),
    expenseCount: z.number().int().nonnegative(),
    purchaseCount: z.number().int().nonnegative(),
    unpricedExpenseCount: z.number().int().nonnegative(),
    itemSpend: money,
    sharedChargeSpend: money,
    netSpend: money,
    incomplete: z.boolean(),
    latestActivity: z.string().nullable(),
    knownAcquiredUnits: z.number().int().nonnegative(),
    unknownAcquisitionQuantityCount: z.number().int().nonnegative(),
  })
  .strict();
const relatedSummaryTotals = z
  .object({
    expenseCount: z.number().int().nonnegative(),
    purchaseCount: z.number().int().nonnegative(),
    unpricedExpenseCount: z.number().int().nonnegative(),
    itemSpend: money,
    sharedChargeSpend: money,
    netSpend: money,
    incomplete: z.boolean(),
    knownAcquiredUnits: z.number().int().nonnegative(),
    unknownAcquisitionQuantityCount: z.number().int().nonnegative(),
  })
  .strict();
export const relatedSummaryOutput = z
  .object({
    data: z.array(relatedSummaryRow),
    count: z.number().int().nonnegative(),
    totals: relatedSummaryTotals,
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type RelatedSummaryOutput = z.infer<typeof relatedSummaryOutput>;
export type RelatedBranchOutput = z.infer<typeof relatedBranchOutput>;

export const relatedOptionsInput = z.object({
  relationKey: relatedViewKeySchema,
  search: z.string().trim().max(200).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export type RelatedOptionsInput = z.infer<typeof relatedOptionsInput>;

export const relatedOptionsOutput = z.array(
  z.object({
    entity: entitySchema,
    id: z.string(),
    label: z.string(),
    count: z.number().int().nonnegative(),
  }),
);
export type RelatedOptionsOutput = z.infer<typeof relatedOptionsOutput>;

export const relatedFilterPrefix = (view: RelatedViewDefinition): string =>
  view.filterPrefix ?? view.target;
