import type { Entity } from "@cubby/schemas/entity";
import { parseEntityId } from "@cubby/schemas/identifiers";

import type { FilterSpecCore } from "./filters";

/**
 * Server-safe semantic entries used by Problem Query assemblies.
 *
 * This is handwritten judgment, not a projection of table controls: its
 * entries select the subset of filters that defines a problem query.
 */
export const problemFilterSemantics = {
  product: [
    {
      columnId: "location",
      field: "locationIdFilter",
      kind: "idMulti",
      brand: (value) => parseEntityId("location", value),
      nullable: { field: "inventoryPresenceFilter", label: "inventory" },
    },
    {
      columnId: "price",
      kind: "range",
      expand: (value) =>
        value === "none-real"
          ? { pricePresenceFilter: "none", miscBucketFilter: "none" }
          : value === "none-bucket"
            ? { pricePresenceFilter: "none", miscBucketFilter: "has" }
            : {},
    },
    { columnId: "food", field: "usdaPresenceFilter", kind: "presence" },
    {
      columnId: "unitMappingQuality",
      field: "unitMappingPresenceFilter",
      kind: "presence",
    },
    {
      columnId: "categoryFeature",
      field: "categoryFeatureFilter",
      kind: "multiselect",
      nullable: { field: "categoryPresenceFilter", label: "classification" },
    },
    {
      columnId: "category",
      field: "categoryFilter",
      kind: "idMulti",
      brand: (value) => parseEntityId("productCategory", value),
      nullable: { field: "categoryPresenceFilter", label: "classification" },
    },
    {
      columnId: "expectedQuantity",
      kind: "range",
      expand: (value) =>
        value === "negative" ? { expectedQuantityMax: -1 } : {},
    },
    { columnId: "image", field: "imagePresenceFilter", kind: "presence" },
    {
      columnId: "ingredient",
      field: "ingredientIdFilter",
      kind: "idMulti",
      brand: (value) => parseEntityId("ingredient", value),
      nullable: { field: "ingredientPresenceFilter", label: "ingredient" },
    },
    { columnId: "inventoryMultiplicity", kind: "select" },
    { columnId: "kitAccounting", kind: "select" },
    { columnId: "ownershipReconciliation", kind: "select" },
    { columnId: "conversionCoverage", kind: "select" },
    { columnId: "conversionTopology", kind: "select" },
    { columnId: "dataGaps", field: "dataGap", kind: "multiselect" },
  ],
  ingredient: [
    {
      columnId: "ownRecipes",
      field: "ownRecipePresenceFilter",
      kind: "presence",
    },
    {
      columnId: "appearsInRecipes",
      field: "recipePresenceFilter",
      kind: "presence",
    },
    { columnId: "product", field: "productPresenceFilter", kind: "presence" },
    { columnId: "dataGaps", field: "dataGap", kind: "multiselect" },
  ],
  location: [
    { columnId: "image", field: "imagePresenceFilter", kind: "presence" },
    {
      columnId: "aiDescription",
      field: "aiDescriptionPresenceFilter",
      kind: "presence",
    },
    {
      columnId: "lastBulkInventory",
      kind: "range",
      expand: (value) =>
        value === "60" ? { lastBulkInventoryOlderThanDays: 60 } : {},
    },
    {
      columnId: "inventoryEntries",
      kind: "range",
      expand: (value) =>
        value === "none"
          ? { directItemCountMax: 0 }
          : value === "has"
            ? { directItemCountMin: 1 }
            : {},
    },
    { columnId: "children", field: "childPresenceFilter", kind: "presence" },
    { columnId: "dataGaps", field: "dataGap", kind: "multiselect" },
  ],
  recipe: [
    {
      columnId: "instructions",
      field: "instructionsPresenceFilter",
      kind: "presence",
    },
    {
      columnId: "sourceType",
      field: "sourceTypeFilter",
      kind: "multiselect",
      nullable: { field: "sourceTypePresenceFilter", label: "source" },
    },
  ],
  meal: [
    { columnId: "mealKind", kind: "multiselect" },
    {
      columnId: "related:meal.recipes",
      urlKey: "related-recipe",
      field: "recipePresenceFilter",
      kind: "presence",
    },
    { columnId: "recipeCostCoverage", kind: "select" },
  ],
  inventory: [
    {
      columnId: "verifiedAt",
      kind: "range",
      expand: (value) =>
        value === "has" || value === "none"
          ? { verifiedPresenceFilter: value }
          : {},
    },
    { columnId: "locationRole", kind: "select" },
    { columnId: "placement", field: "placementFilter", kind: "select" },
    { columnId: "valuationStatus", kind: "select" },
    { columnId: "dataGaps", field: "dataGap", kind: "multiselect" },
  ],
  expense: [
    { columnId: "future", kind: "boolean" },
    { columnId: "costSign", kind: "select" },
    { columnId: "dateRelative", kind: "select" },
    { columnId: "product", field: "productPresenceFilter", kind: "presence" },
    {
      columnId: "vendor",
      field: "vendorId",
      kind: "idMulti",
      brand: (value) => parseEntityId("vendor", value),
      nullable: { field: "vendorPresenceFilter", label: "purchase" },
    },
    { columnId: "lineKind", kind: "multiselect" },
    { columnId: "lineBasis", kind: "multiselect" },
    { columnId: "trade", kind: "multiselect" },
    {
      columnId: "cost",
      kind: "range",
      expand: (value) =>
        value === "has" || value === "none"
          ? { costPresenceFilter: value }
          : {},
    },
    { columnId: "disposalPurchasePresenceFilter", kind: "presence" },
  ],
  purchase: [
    { columnId: "reconciliation", kind: "multiselect" },
    { columnId: "financialReconciliation", kind: "select" },
  ],
  financialTransaction: [{ columnId: "allocationIntegrity", kind: "select" }],
  image: [
    { columnId: "status", kind: "multiselect" },
    { columnId: "processingIssue", kind: "multiselect" },
    { columnId: "entity", field: "referencePresenceFilter", kind: "presence" },
    {
      columnId: "createdAt",
      kind: "range",
      expand: (value) =>
        value === "olderThan1h" ? { uploadedAgeHoursMin: 1 } : {},
    },
  ],
  vendor: [
    {
      columnId: "purchaseCount",
      kind: "range",
      expand: (value) => ({ purchaseCountMin: Number(value) }),
    },
    { columnId: "logo", field: "logoPresenceFilter", kind: "presence" },
    { columnId: "dataGaps", field: "dataGap", kind: "multiselect" },
  ],
  task: [
    { columnId: "dueRelative", kind: "select" },
    { columnId: "completion", kind: "select" },
    {
      columnId: "parentTask",
      field: "parentTaskId",
      kind: "idMulti",
      brand: (value) => parseEntityId("task", value),
      nullable: { field: "parentTaskPresenceFilter", label: "parent task" },
    },
  ],
  project: [{ columnId: "attention", kind: "select" }],
} as const satisfies Partial<Record<Entity, readonly FilterSpecCore[]>>;
