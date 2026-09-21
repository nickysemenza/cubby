import { collectionSlugPattern } from "@cubby/shared/collection-tag";
import { z } from "zod";
import { plainDate } from "./base-entity";
import {
  locationShortcode,
  ledgerPartyShortcode,
  inventoryShortcode,
  productShortcode,
  purchaseShortcode,
} from "./identifiers";
import { amount } from "./codec";
import { productCategoryShortcode } from "./identifier-fields";
import { productCategoryFeature } from "./product-category-fields";
import { tradeSchema } from "./project";

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
  imageUrl: z.string().nullable(),
});

export const collectionProductPlacementOut = z.object({
  id: locationShortcode,
  name: z.string(),
  path: z.array(z.string()),
});
export type CollectionProductPlacementOut = z.infer<
  typeof collectionProductPlacementOut
>;

export const collectionProductPurchaseOut = z.object({
  id: purchaseShortcode,
  orderId: z.string().nullable(),
  displayLabel: z.string().nullable(),
  date: plainDate,
  vendorName: z.string().nullable(),
  trades: z.array(tradeSchema),
});
export type CollectionProductPurchaseOut = z.infer<
  typeof collectionProductPurchaseOut
>;

const ruleText = z.string().trim().min(1).max(200);
export const smartCollectionRule = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("categoryFeatureEquals"),
    value: productCategoryFeature,
  }),
  z.strictObject({
    kind: z.literal("effectiveOwnerEquals"),
    value: ledgerPartyShortcode,
  }),
  z.strictObject({
    kind: z.literal("categoryEquals"),
    value: productCategoryShortcode,
  }),
  z.strictObject({ kind: z.literal("productTagEquals"), value: ruleText }),
  z.strictObject({ kind: z.literal("manufacturerEquals"), value: ruleText }),
  z.strictObject({ kind: z.literal("locationNameContains"), value: ruleText }),
  z.strictObject({
    kind: z.literal("historicalExpenseTrade"),
    value: tradeSchema,
  }),
]);
export type SmartCollectionRule = z.infer<typeof smartCollectionRule>;
export const smartCollectionKey = z.enum(["painting", "measuring", "festool"]);
const smartCollectionDefinitionKey = z.enum([
  ...smartCollectionKey.options,
  "wardrobe",
]);
export type SmartCollectionKey = z.infer<typeof smartCollectionKey>;
export const smartCollectionDefinition = z.strictObject({
  key: smartCollectionDefinitionKey,
  name: z.string().trim().min(1).max(100),
  rules: z.array(smartCollectionRule).max(20),
  match: z.enum(["all", "any"]).optional(),
});
export type SmartCollectionDefinition = z.infer<
  typeof smartCollectionDefinition
>;
export const SMART_COLLECTION_STARTERS: readonly SmartCollectionDefinition[] = [
  {
    key: "painting",
    name: "Painting & finishing",
    rules: [
      { kind: "historicalExpenseTrade", value: "finishes" },
      { kind: "locationNameContains", value: "paint" },
      { kind: "productTagEquals", value: "collection:painting" },
    ],
  },
  {
    key: "measuring",
    name: "Measuring & layout",
    rules: [{ kind: "locationNameContains", value: "measuring" }],
  },
  {
    key: "festool",
    name: "Festool system",
    rules: [
      { kind: "manufacturerEquals", value: "Festool" },
      { kind: "locationNameContains", value: "festool" },
    ],
  },
];
export const smartCollectionMatch = z.object({
  ruleIndex: z.number().int().nonnegative(),
  kind: z.enum([
    "effectiveOwnerEquals",
    "categoryEquals",
    "categoryFeatureEquals",
    "productTagEquals",
    "manufacturerEquals",
    "locationNameContains",
    "historicalExpenseTrade",
  ]),
  value: z.string(),
  evidence: z.array(z.string()),
});
export type SmartCollectionMatch = z.infer<typeof smartCollectionMatch>;

export const collectionProductOut = z.object({
  id: productShortcode,
  name: z.string(),
  manufacturer: z.string(),
  imageUrl: z.string().nullable(),
  direct: z.boolean(),
  inherited: z.boolean(),
  matches: z.array(smartCollectionMatch).optional(),
  placements: z.array(collectionProductPlacementOut),
  purchases: z.array(collectionProductPurchaseOut),
  inventory: z
    .array(
      z.object({
        id: inventoryShortcode,
        locationId: locationShortcode,
        amount,
      }),
    )
    .optional(),
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
  placements: z.array(collectionProductPlacementOut),
  purchases: z.array(collectionProductPurchaseOut),
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

export const smartCollectionSummary = z.object({
  key: smartCollectionDefinitionKey,
  name: z.string(),
  totalCount: z.number().int().nonnegative(),
  sourceCounts: z.object({
    effectiveOwnerEquals: z.number().int().nonnegative(),
    categoryEquals: z.number().int().nonnegative(),
    categoryFeatureEquals: z.number().int().nonnegative(),
    productTagEquals: z.number().int().nonnegative(),
    manufacturerEquals: z.number().int().nonnegative(),
    locationNameContains: z.number().int().nonnegative(),
    historicalExpenseTrade: z.number().int().nonnegative(),
  }),
});
export type SmartCollectionSummary = z.infer<typeof smartCollectionSummary>;
export const smartCollectionListInput = z.strictObject({
  definitions: z
    .array(smartCollectionDefinition)
    .max(3)
    .refine(
      (definitions) =>
        new Set(definitions.map((item) => item.key)).size ===
        definitions.length,
      "Starter keys must be unique",
    ),
});
export const smartCollectionPagination = z.strictObject({
  pageIndex: z.number().int().nonnegative(),
  pageSize: z.number().int().min(1).max(100),
});
export const smartCollectionDetailInput = z.strictObject({
  definition: smartCollectionDefinition,
  search: z.string().trim().max(200).optional(),
  pagination: smartCollectionPagination,
});
export const smartCollectionDetailOut = z.object({
  summary: smartCollectionSummary,
  products: z.array(collectionProductOut),
  totalCount: z.number().int().nonnegative(),
});
export type SmartCollectionDetailOut = z.infer<typeof smartCollectionDetailOut>;

export const smartCollectionReference = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("starter"),
    key: z.enum(["painting", "measuring", "festool"]),
  }),
  z.object({ kind: z.literal("wardrobe"), ownerId: ledgerPartyShortcode }),
]);
export const smartCollectionReferenceInput = smartCollectionDetailInput
  .omit({ definition: true })
  .extend({ reference: smartCollectionReference });
export function collectionDefinitionForReference(
  reference: z.infer<typeof smartCollectionReference>,
): SmartCollectionDefinition {
  if (reference.kind === "wardrobe")
    return {
      key: "wardrobe",
      name: "Wardrobe",
      match: "all",
      rules: [
        { kind: "effectiveOwnerEquals", value: reference.ownerId },
        { kind: "categoryFeatureEquals", value: "apparel" },
      ],
    };
  const starter = SMART_COLLECTION_STARTERS.find(
    (definition) => definition.key === reference.key,
  );
  if (!starter) throw new Error("Unknown collection reference");
  return starter;
}
