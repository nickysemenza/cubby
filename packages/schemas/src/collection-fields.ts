import { collectionSlugPattern } from "@cubby/shared/collection-tag";
import { z } from "zod";
import {
  ledgerPartyShortcode,
  productCategoryShortcode,
} from "./identifier-fields";
import { productCategoryFeature } from "./product-category-fields";
import { tradeSchema } from "./task-fields";

// Collection vocabulary a route's eager search validation and `head` read;
// `./collection` holds the read schemas, which import generated entity field
// schemas.

export const collectionSlug = z
  .string()
  .min(1)
  .max(64)
  .regex(collectionSlugPattern, "Use a lowercase kebab-case Collection name");
export type CollectionSlug = z.infer<typeof collectionSlug>;

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
export const smartCollectionDefinitionKey = z.enum([
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
