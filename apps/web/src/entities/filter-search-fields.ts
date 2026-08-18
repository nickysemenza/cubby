import type { Entity } from "@cubby/schemas/entity";
import {
  unsafeIngredientId,
  unsafeLocationId,
  unsafeTaskId,
  unsafeVendorId,
} from "@cubby/schemas/identifiers";
import { urlStringParam } from "~/lib/search-params";
import type { FilterSpecCore } from "./filters";

/**
 * Dependency-light semantic filter core for URL state.
 *
 * Route modules are part of TanStack Router's eager graph. Importing the full
 * icon/options/brand-bearing filter manifest there made every browser download
 * table UI and date helpers before hydration. The UI test suite asserts this
 * key projection stays identical to `getEntityFilters()`.
 *
 * This is deliberately metadata, rather than a route-shaped object: the
 * route adapter below is generated from it. Server code can also consult the
 * same vocabulary without importing the React/icon/options bearing manifest.
 */
export const entityFilterSemantics = {
  product: [
    "name",
    "manufacturer",
    "manufacturerSearch",
    "upc",
    "model",
    "modelPresence",
    "upcPresence",
    "category",
    "location",
    "servingAsLocations",
    "ingredient",
    "expenses",
    "expenseTotal",
    "expectedQuantity",
    "quantityVariance",
    "notes",
    "notesPresence",
    "dataQuality",
    "dataGaps",
    "externalIds",
    "purchaseDate",
    "price",
    "food",
    "image",
    "inventoryMultiplicity",
    "ownershipReconciliation",
    "conversionCoverage",
    "conversionTopology",
    "unitMappingQuality",
    "stockTracked",
    "components",
    "tags",
    "related-vendor",
    "related-project",
    "related-usedOnProject",
    "usedOnProjectId",
    "usedOnProjectPresenceFilter",
    "related-purchase",
    "related-expense",
    "expenseId",
    "expensePresenceFilter",
    "related-relatedInventory",
    "relatedInventoryId",
    "relatedInventoryPresenceFilter",
    "related:product.tasks",
    "taskId",
    "createdAt",
    "updatedAt",
  ],
  ingredient: [
    "name",
    "product",
    "ownRecipes",
    "appearsInRecipes",
    "createdAt",
    "updatedAt",
  ],
  inventory: [
    "productId",
    "locationId",
    "product",
    "location",
    "manufacturer",
    "category",
    "verifiedAt",
    "placement",
    "locationRole",
    "valuationStatus",
    "related-ingredient",
    "ingredientId",
    "ingredientPresenceFilter",
    "createdAt",
    "updatedAt",
  ],
  location: [
    "image",
    "lastBulkInventory",
    "children",
    "aiDescription",
    "name",
    "type",
    "product",
    "parent",
    "inventoryEntries",
    "valuation",
    "related-ingredient",
    "ingredientId",
    "ingredientPresenceFilter",
    "createdAt",
    "updatedAt",
  ],
  recipe: [
    "name",
    "tags",
    "source",
    "meals",
    "image",
    "instructions",
    "sourceType",
    "costTotal",
    "caloriesTotal",
    "totalMinutes",
    "related-ingredient",
    "related-meal",
    "mealId",
    "mealPresenceFilter",
    "createdAt",
    "updatedAt",
  ],
  meal: [
    "mealType",
    "mealKind",
    "recipeCostCoverage",
    "related-recipe",
    "recipeId",
    "createdAt",
    "updatedAt",
  ],
  project: [
    "image",
    "name",
    "statuses",
    "kinds",
    "attention",
    "locations",
    "date",
    "completed",
    "parent",
    "related-project",
    "projectId",
    "projectPresenceFilter",
    "related-task",
    "taskId",
    "taskPresenceFilter",
    "related-expense",
    "expenseId",
    "expensePresenceFilter",
    "related-taskProduct",
    "taskProductId",
    "taskProductPresenceFilter",
    "related-purchasedProduct",
    "purchasedProductId",
    "purchasedProductPresenceFilter",
    "related-usedTool",
    "usedToolId",
    "usedToolPresenceFilter",
    "related-vendor",
    "vendorId",
    "vendorPresenceFilter",
    "createdAt",
    "updatedAt",
  ],
  task: [
    "name",
    "status",
    "trade",
    "dueDate",
    "dueRelative",
    "completion",
    "project",
    "productId",
    "subjectProduct",
    "parentTask",
    "related-blockedByTask",
    "blockedByTaskId",
    "blockedByTaskPresenceFilter",
    "related-parentTask",
    "parentTaskId",
    "parentTaskPresenceFilter",
    "createdAt",
    "updatedAt",
  ],
  expense: [
    "q",
    "date",
    "dateFrom",
    "dateTo",
    "dateRelative",
    "costType",
    "lineKind",
    "lineBasis",
    "trade",
    "future",
    "cost",
    "costMin",
    "costMax",
    "costSign",
    "disposalPurchasePresenceFilter",
    "productQuantity",
    "productQuantityMin",
    "productQuantityMax",
    "notesSearch",
    "urlSearch",
    "project",
    "subprojects",
    "productId",
    "product",
    "vendor",
    "orderId",
    "order",
    "purchaseId",
    "related-financialTransaction",
    "financialTransactionId",
    "financialTransactionPresenceFilter",
    "createdAt",
    "updatedAt",
  ],
  vendor: [
    "q",
    "purchaseCount",
    "spend",
    "latestPurchaseDate",
    "logo",
    "related-expense",
    "expenseId",
    "expensePresenceFilter",
    "related-purchase",
    "purchaseId",
    "purchasePresenceFilter",
    "related-product",
    "productId",
    "productPresenceFilter",
    "related-project",
    "projectId",
    "projectPresenceFilter",
    "related-financialTransaction",
    "financialTransactionId",
    "financialTransactionPresenceFilter",
    "createdAt",
    "updatedAt",
  ],
  purchase: [
    "financialReconciliation",
    "q",
    "label",
    "vendor",
    "orderId",
    "date",
    "statedTotal",
    "lines",
    "lineTotal",
    "reconciliation",
    "documents",
    "transactions",
    "dataQuality",
    "dataGaps",
    "lineTotalMin",
    "lineTotalMax",
    "related-expense",
    "expenseId",
    "expensePresenceFilter",
    "related-financialTransaction",
    "financialTransactionId",
    "financialTransactionPresenceFilter",
    "related-product",
    "productId",
    "productPresenceFilter",
    "related-project",
    "projectId",
    "projectPresenceFilter",
    "createdAt",
    "updatedAt",
  ],
  financialAccount: [
    "q",
    "identity",
    "provisional",
    "aliases",
    "last4",
    "source",
    "externalAccountId",
    "related-financialTransaction",
    "financialTransactionId",
    "financialTransactionPresenceFilter",
    "related-purchase",
    "purchaseId",
    "purchasePresenceFilter",
    "related-vendor",
    "vendorId",
    "vendorPresenceFilter",
    "createdAt",
    "updatedAt",
  ],
  financialTransaction: [
    "allocationIntegrity",
    "q",
    "kind",
    "status",
    "postedDate",
    "accountId",
    "purchaseId",
    "purchasePresence",
    "source",
    "externalId",
    "merchant",
    "amount",
    "amountMin",
    "amountMax",
    "transactionDateFrom",
    "transactionDateTo",
    "postedDateFrom",
    "postedDateTo",
    "related-vendor",
    "vendorId",
    "vendorPresenceFilter",
    "related-expense",
    "expenseId",
    "expensePresenceFilter",
    "related-product",
    "productId",
    "productPresenceFilter",
    "createdAt",
    "updatedAt",
  ],
  wish: [
    "q",
    "acquired",
    "related-product",
    "productId",
    "productPresenceFilter",
    "createdAt",
    "updatedAt",
  ],
  image: ["filename", "status", "entity", "createdAt", "updatedAt"],
  "usda-food": [],
  cookbook: [],
} as const satisfies Record<Entity, readonly string[]>;

/**
 * Server-safe semantic entries used by Problem Query assemblies.
 *
 * This deliberately lives beside the full URL-key roster above rather than in
 * a second Problem-only projection.  Both route validation and server query
 * compilation now consult this one dependency-light module.  The UI manifest
 * augments these semantics with controls, icons, option loading, and display
 * labels; it must not invent an additional URL vocabulary.
 */
export const problemFilterSemantics = {
  product: [
    {
      columnId: "location",
      field: "locationIdFilter",
      kind: "idMulti",
      brand: unsafeLocationId,
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
      columnId: "category",
      field: "categoryFilter",
      kind: "multiselect",
      nullable: { field: "categoryPresenceFilter", label: "category" },
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
      brand: unsafeIngredientId,
      nullable: { field: "ingredientPresenceFilter", label: "ingredient" },
    },
    { columnId: "inventoryMultiplicity", kind: "select" },
    { columnId: "ownershipReconciliation", kind: "select" },
    { columnId: "conversionCoverage", kind: "select" },
    { columnId: "conversionTopology", kind: "select" },
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
      brand: unsafeVendorId,
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
  ],
  task: [
    { columnId: "dueRelative", kind: "select" },
    { columnId: "completion", kind: "select" },
    {
      columnId: "parentTask",
      field: "parentTaskId",
      kind: "idMulti",
      brand: unsafeTaskId,
      nullable: { field: "parentTaskPresenceFilter", label: "parent task" },
    },
  ],
  project: [{ columnId: "attention", kind: "select" }],
} as const satisfies Partial<Record<Entity, readonly FilterSpecCore[]>>;

/** The URL keys an entity accepts for its canonical filter assembly. */
export const entityFilterUrlKeys = (entity: Entity): readonly string[] =>
  entityFilterSemantics[entity];

export function entityFilterSearchFields(
  entity: Entity,
): Record<string, typeof urlStringParam> {
  const fields: Record<string, typeof urlStringParam> = {};
  for (const key of entityFilterUrlKeys(entity)) fields[key] = urlStringParam;
  return fields;
}

/**
 * Boundary check used by the UI adapter after it adds controls and options.
 * It makes a new UI-only URL filter fail immediately instead of silently
 * creating route state that the dependency-light route adapter cannot parse.
 */
export function assertUiFilterSemantics(
  entity: Entity,
  specs: readonly Pick<FilterSpecCore, "columnId" | "urlKey">[],
): void {
  const declared = specs.map((spec) => spec.urlKey ?? spec.columnId);
  const expected = entityFilterUrlKeys(entity);
  if (
    declared.length !== expected.length ||
    declared.some((key, index) => key !== expected[index])
  ) {
    throw new Error(
      `UI filter adapter drift for ${entity}: expected [${expected.join(", ")}], got [${declared.join(", ")}].`,
    );
  }
}
