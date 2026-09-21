import type {
  ProductCategoryFeature,
  ProductCategorySummary,
} from "@cubby/schemas/product-category-fields";
import {
  type ProductCategoryId,
  type ProductCategoryShortcode,
} from "@cubby/schemas/identifiers";
import { testEntityId, testShortcode } from "@cubby/schemas/testing";

const taxonomyFeatures = [
  "food",
  "books",
  "tools",
  "tool-consumables",
  "tool-accessories",
  "storage",
  "hardware",
  "electronics",
  "software",
  "household",
  "supplies",
  "apparel",
] as const satisfies readonly ProductCategoryFeature[];

const categoryNames = {
  food: "Food",
  books: "Books",
  tools: "Tools",
  "tool-consumables": "Tool consumables",
  "tool-accessories": "Tool accessories",
  storage: "Storage",
  hardware: "Hardware",
  electronics: "Electronics",
  software: "Software",
  household: "Household",
  supplies: "Supplies",
  apparel: "Apparel",
} as const satisfies Record<ProductCategoryFeature, string>;

const categoryCodes = {
  food: "CAT-2222",
  books: "CAT-2223",
  tools: "CAT-2224",
  "tool-consumables": "CAT-2225",
  "tool-accessories": "CAT-2226",
  storage: "CAT-2227",
  hardware: "CAT-2228",
  electronics: "CAT-2229",
  software: "CAT-2232",
  household: "CAT-2233",
  supplies: "CAT-2234",
  apparel: "CAT-2235",
} as const satisfies Record<ProductCategoryFeature, string>;

export const taxonomyId = (
  feature: ProductCategoryFeature,
): ProductCategoryId =>
  testEntityId(
    "productCategory",
    `00000000-0000-4000-8000-0000000001${String(taxonomyFeatures.indexOf(feature) + 1).padStart(2, "0")}`,
  );

export const taxonomyShortcode = (
  feature: ProductCategoryFeature,
): ProductCategoryShortcode =>
  testShortcode("productCategory", categoryCodes[feature]);

export const categorySummaryFixture = (
  feature: ProductCategoryFeature,
): ProductCategorySummary => ({
  id: taxonomyShortcode(feature),
  name: categoryNames[feature],
  path: [{ id: taxonomyShortcode(feature), name: categoryNames[feature] }],
  feature,
});

export const taxonomyRootFixtures = taxonomyFeatures.map(
  (feature, sortOrder) => ({
    id: taxonomyId(feature),
    shortcode: taxonomyShortcode(feature),
    name: categoryNames[feature],
    aliases: [],
    description: null,
    parentId: null,
    sortOrder,
    feature,
  }),
);
