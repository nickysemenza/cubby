import { z } from "zod";
import type { Entity } from "./entity";
import { connectedPathVariants } from "./connected-views";
import { localRelationshipByKey } from "./entity-manifest";
import { money } from "./money";
import { partyFilter, sortDirection } from "./pagination";
import { entitySchema } from "./entity";
import { imageUrlSummary } from "./image-summary";
import {
  expenseShortcode,
  financialTransactionShortcode,
  ingredientShortcode,
  inventoryShortcode,
  ledgerPartyShortcode,
  mealShortcode,
  productShortcode,
  projectShortcode,
  purchaseShortcode,
  recipeShortcode,
  taskShortcode,
  vendorShortcode,
  wishShortcode,
  nonEmptyTuple,
} from "./identifiers";

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

const relatedViewPresentationRegistry = [
  {
    columnGroup: "Purchasing",
    key: "product.vendors",
    source: "product",
    relationship: "vendors",
    defaultVisible: false,
    order: "alphabetical",
    inverseKey: "vendor.products",
  },
  {
    columnGroup: "Work",
    key: "product.projects",
    source: "product",
    relationship: "purchased-projects",
    defaultVisible: false,
    order: "alphabetical",
    inverseKey: "project.purchasedProducts",
  },
  {
    columnGroup: "Work",
    key: "product.usedOnProjects",
    source: "product",
    relationship: "project-uses",
    defaultVisible: false,
    order: "alphabetical",
    filterPrefix: "usedOnProject",
    inverseKey: "project.usedTools",
  },
  {
    columnGroup: "Purchasing",
    key: "product.purchases",
    source: "product",
    relationship: "purchases",
    defaultVisible: false,
    order: "newest",
  },
  {
    columnGroup: "Purchasing",
    key: "product.expenses",
    source: "product",
    relationship: "expenses",
    defaultVisible: false,
    order: "newest",
  },
  {
    columnGroup: "Stock",
    key: "product.inventory",
    source: "product",
    relationship: "inventory",
    defaultVisible: false,
    order: "newest",
    filterPrefix: "relatedInventory",
  },
  {
    columnGroup: "Wish list",
    key: "product.wishes",
    source: "product",
    relationship: "wishes",
    defaultVisible: false,
    order: "alphabetical",
  },
  {
    columnGroup: "Work",
    key: "product.tasks",
    source: "product",
    relationship: "tasks",
    defaultVisible: false,
    order: "task",
  },
  {
    columnGroup: "Food",
    key: "product.meals",
    source: "product",
    relationship: "meals",
    defaultVisible: false,
    order: "newest",
    inverseKey: "meal.foodProducts",
  },
  {
    columnGroup: "Food",
    key: "product.eaters",
    source: "product",
    relationship: "eaters",
    defaultVisible: false,
    order: "alphabetical",
    filterPrefix: "eater",
  },
  {
    columnGroup: "Use",
    key: "ingredient.meals",
    source: "ingredient",
    relationship: "meals",
    defaultVisible: false,
    order: "newest",
    inverseKey: "meal.foodIngredients",
  },
  {
    columnGroup: "Use",
    key: "ingredient.eaters",
    source: "ingredient",
    relationship: "eaters",
    defaultVisible: false,
    order: "alphabetical",
    filterPrefix: "eater",
  },
  {
    columnGroup: "Recipe",
    key: "recipe.ingredients",
    source: "recipe",
    relationship: "ingredients",
    defaultVisible: false,
    order: "alphabetical",
  },
  {
    columnGroup: "Source & use",
    key: "recipe.meals",
    source: "recipe",
    relationship: "meals",
    defaultVisible: false,
    order: "newest",
    inverseKey: "meal.recipes",
  },
  {
    columnGroup: "Food",
    key: "meal.recipes",
    source: "meal",
    relationship: "recipes",
    defaultVisible: false,
    order: "alphabetical",
    inverseKey: "recipe.meals",
  },
  {
    columnGroup: "Food",
    key: "meal.foodProducts",
    source: "meal",
    relationship: "food-products",
    defaultVisible: false,
    order: "alphabetical",
    filterPrefix: "foodProduct",
    inverseKey: "product.meals",
  },
  {
    columnGroup: "Food",
    key: "meal.foodIngredients",
    source: "meal",
    relationship: "food-ingredients",
    defaultVisible: false,
    order: "alphabetical",
    filterPrefix: "foodIngredient",
    inverseKey: "ingredient.meals",
  },
  {
    columnGroup: "People",
    key: "meal.eaters",
    source: "meal",
    relationship: "eaters",
    defaultVisible: false,
    order: "alphabetical",
    filterPrefix: "eater",
    inverseKey: "ledgerParty.meals",
  },
  {
    columnGroup: "Stock",
    key: "location.ingredients",
    source: "location",
    relationship: "ingredients",
    defaultVisible: false,
    order: "alphabetical",
  },
  {
    columnGroup: "Catalog",
    key: "inventory.ingredient",
    source: "inventory",
    relationship: "ingredient",
    defaultVisible: false,
    order: "alphabetical",
  },
  {
    columnGroup: "Dependencies",
    key: "project.blockedBy",
    source: "project",
    relationship: "blocked-by",
    defaultVisible: true,
    order: "alphabetical",
  },
  {
    columnGroup: "Work",
    key: "project.tasks",
    source: "project",
    relationship: "tasks",
    defaultVisible: false,
    order: "task",
  },
  {
    columnGroup: "Purchasing",
    key: "project.expenses",
    source: "project",
    relationship: "expenses",
    defaultVisible: false,
    order: "newest",
  },
  {
    columnGroup: "Work",
    key: "project.taskProducts",
    source: "project",
    relationship: "task-products",
    defaultVisible: false,
    order: "alphabetical",
    filterPrefix: "taskProduct",
  },
  {
    columnGroup: "Purchasing",
    key: "project.purchasedProducts",
    source: "project",
    relationship: "purchased-products",
    defaultVisible: false,
    order: "alphabetical",
    filterPrefix: "purchasedProduct",
    inverseKey: "product.projects",
  },
  {
    columnGroup: "Work",
    key: "project.usedTools",
    source: "project",
    relationship: "resources",
    defaultVisible: true,
    order: "alphabetical",
    filterPrefix: "usedTool",
    inverseKey: "product.usedOnProjects",
  },
  {
    columnGroup: "Purchasing",
    key: "project.vendors",
    source: "project",
    relationship: "vendors",
    defaultVisible: false,
    order: "alphabetical",
    inverseKey: "vendor.projects",
  },
  {
    columnGroup: "Dependencies",
    key: "task.blockedBy",
    source: "task",
    relationship: "blocked-by",
    defaultVisible: true,
    order: "task",
    filterPrefix: "blockedByTask",
  },
  {
    columnGroup: "Dependencies",
    key: "task.parent",
    source: "task",
    relationship: "parent",
    defaultVisible: false,
    order: "task",
    filterPrefix: "parentTask",
  },
  {
    key: "vendor.brandedProducts",
    source: "vendor",
    relationship: "branded-products",
    columnGroup: "Brand / catalog",
    defaultVisible: true,
    order: "alphabetical",
    filterPrefix: "brandedProduct",
  },
  {
    key: "vendor.expenses",
    columnGroup: "Purchasing",
    source: "vendor",
    relationship: "expenses",
    defaultVisible: true,
    order: "newest",
  },
  {
    columnGroup: "Imports",
    key: "vendorAccount.purchases",
    source: "vendorAccount",
    relationship: "purchases",
    defaultVisible: true,
    order: "newest",
  },
  {
    key: "vendor.purchases",
    columnGroup: "Purchasing",
    source: "vendor",
    relationship: "purchases",
    defaultVisible: false,
    order: "newest",
  },
  {
    key: "vendor.products",
    columnGroup: "Purchasing",
    source: "vendor",
    relationship: "products",
    defaultVisible: false,
    order: "alphabetical",
    inverseKey: "product.vendors",
  },
  {
    key: "vendor.projects",
    columnGroup: "Purchasing",
    source: "vendor",
    relationship: "projects",
    defaultVisible: false,
    order: "alphabetical",
    inverseKey: "project.vendors",
  },
  {
    key: "vendor.transactions",
    columnGroup: "Purchasing",
    source: "vendor",
    relationship: "transactions",
    defaultVisible: false,
    order: "newest",
  },
  {
    columnGroup: "Booking",
    key: "purchase.expenses",
    source: "purchase",
    relationship: "expenses",
    defaultVisible: true,
    order: "newest",
  },
  {
    columnGroup: "Settlement",
    key: "purchase.transactions",
    source: "purchase",
    relationship: "financial-transactions",
    defaultVisible: true,
    order: "newest",
  },
  {
    columnGroup: "Booking",
    key: "purchase.products",
    source: "purchase",
    relationship: "products",
    defaultVisible: false,
    order: "alphabetical",
  },
  {
    columnGroup: "Booking",
    key: "purchase.projects",
    source: "purchase",
    relationship: "projects",
    defaultVisible: false,
    order: "alphabetical",
  },
  {
    columnGroup: "Evidence",
    key: "expense.transactions",
    source: "expense",
    relationship: "transactions",
    defaultVisible: false,
    order: "newest",
  },
  {
    columnGroup: "Activity",
    key: "financialAccount.transactions",
    source: "financialAccount",
    relationship: "transactions",
    defaultVisible: true,
    order: "newest",
  },
  {
    columnGroup: "Activity",
    key: "financialAccount.purchases",
    source: "financialAccount",
    relationship: "purchases",
    defaultVisible: false,
    order: "newest",
  },
  {
    columnGroup: "Activity",
    key: "financialAccount.vendors",
    source: "financialAccount",
    relationship: "vendors",
    defaultVisible: false,
    order: "alphabetical",
  },
  {
    columnGroup: "Booking",
    key: "financialTransaction.vendor",
    source: "financialTransaction",
    relationship: "vendor",
    defaultVisible: true,
    order: "alphabetical",
  },
  {
    columnGroup: "Booking",
    key: "financialTransaction.expenses",
    source: "financialTransaction",
    relationship: "expenses",
    defaultVisible: false,
    order: "newest",
  },
  {
    columnGroup: "Booking",
    key: "financialTransaction.products",
    source: "financialTransaction",
    relationship: "products",
    defaultVisible: false,
    order: "alphabetical",
  },
  {
    columnGroup: "Options",
    key: "wish.candidates",
    source: "wish",
    relationship: "candidates",
    defaultVisible: true,
    order: "alphabetical",
  },
  {
    columnGroup: "Meals",
    key: "ledgerParty.meals",
    source: "ledgerParty",
    relationship: "meals",
    defaultVisible: false,
    order: "newest",
    inverseKey: "meal.eaters",
  },
  {
    columnGroup: "Meals",
    key: "ledgerParty.recipesEaten",
    source: "ledgerParty",
    relationship: "recipes-eaten",
    defaultVisible: false,
    order: "alphabetical",
  },
] as const satisfies readonly RelatedViewPresentationDefinition[];

type RelatedViewPresentation = (typeof relatedViewPresentationRegistry)[number];

export const relatedViewRegistry = relatedViewPresentationRegistry.map(
  (view) => {
    const relationship = localRelationshipByKey(view.source, view.relationship);
    return { ...view, target: relationship.target, label: relationship.label };
  },
) satisfies readonly (RelatedViewPresentation & {
  target: Entity;
  label: string;
})[];

/** Every declared evidence source participates in previews and filters. */
export const relatedViewPaths = (
  view: Pick<RelatedViewDefinition, "source" | "key">,
) => {
  const definition = relatedViewRegistry.find(
    (candidate) =>
      candidate.key === view.key && candidate.source === view.source,
  );
  if (!definition) throw new Error(`Unknown related view key: ${view.key}`);
  return connectedPathVariants(view.source, [definition.relationship]).map(
    (variant) => variant.steps,
  );
};

type RelatedViewSource = (typeof relatedViewRegistry)[number]["source"];

/**
 * Entities that deliberately offer no curated related views, each with the
 * reason. `satisfies Record<Exclude<Entity, RelatedViewSource>, string>` makes
 * this the exact complement of the registry's sources, in both directions: a
 * new entity that is neither a source nor listed here fails to compile, and an
 * entity that gains its first registry row must be deleted from here. Before
 * this, an entity with no views and an entity nobody had gotten to were the
 * same empty `.filter()` result.
 */
const ENTITIES_WITHOUT_RELATED_VIEWS = {
  shipment:
    "Purchase and carrier render as declared Shipment references; tracking evidence uses the timeline report.",
  sourceTransactionRecord:
    "Imports and accepted transactions render as detail relation sections.",
  transactionImport:
    "Retained source records render as a detail relation section.",
  email:
    "Email report generic records derive accepted source-family/lifecycle Purchases, their Expenses/Products and same-Purchase owned Emails; mailbox-scoped thread context and dismissed candidates remain separate. Owner/Run use declared related views.",
  spendingCategory:
    "Spending classification links are rendered on each financial record.",
  cookbook: "the cookbook page IS its recipe list",
  ledgerTransfer:
    "ledger transfer relationships are rendered in the household ledger",
  // The one entity with no shortcode, no detail route, and no list table.
  image: "no detail route or list table to hang a preview column on",
  plant: "a plant's plantings and products render as detail relation sections",
  planting:
    "its cross-entity relationships (ingredient, location, source product, task) are already reachable from those entities' own relation sections",
  gardenEntry: "garden timelines render entries directly",
  run: "read-only runs have no detail route to hang a related view on; vendor account/vendor/member links are rendered as list columns",
  productCategory:
    "the category tree is rendered through the product-category records page",
  // Not a local entity — remote USDA search results, no local edges.
  "usda-food": "remote USDA records have no local relationships",
  device:
    "owner and hardware are rendered as detail fields; nothing yet declares a relation onto a device",
  imageJob:
    "an Image job's Image and requesting Run are detail fields; its attempts and events are the attempts slot",
  job: "Execution subjects and Runs are read-only reference fields; Activity embeds the Job roster directly.",
} as const satisfies Record<Exclude<Entity, RelatedViewSource>, string>;

type RegisteredRelatedView = (typeof relatedViewRegistry)[number];

const NO_RELATED_VIEWS: readonly RegisteredRelatedView[] = [];

export const relatedViewsFor = (
  entity: Entity,
): readonly RegisteredRelatedView[] =>
  entity in ENTITIES_WITHOUT_RELATED_VIEWS
    ? NO_RELATED_VIEWS
    : relatedViewRegistry.filter((view) => view.source === entity);

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

const relatedPresence = z.enum(["has", "none"]).optional();
const relatedSearch = z.string().optional();
type RelatedTrio<Prefix extends string, Ids extends z.ZodType> = {
  [K in `${Prefix}Id`]: Ids;
} & {
  [K in `${Prefix}PresenceFilter`]: typeof relatedPresence;
} & {
  [K in `${Prefix}Search`]: typeof relatedSearch;
};
const trio = <Prefix extends string, IdSchema extends z.ZodType>(
  prefix: Prefix,
  idSchema: IdSchema,
) => {
  const ids = z.union([idSchema, z.array(idSchema)]).optional();
  // SAFETY: each computed key is formed from Prefix, and all three values are
  // the schemas represented by RelatedTrio for that same prefix.
  return {
    [`${prefix}Id`]: ids,
    [`${prefix}PresenceFilter`]: relatedPresence,
    [`${prefix}Search`]: relatedSearch,
  } as RelatedTrio<Prefix, typeof ids>;
};

/**
 * These per-source blocks are hand-listed on purpose, not for want of a
 * derivation. `relatedFilterFieldsFor(entity)` — a mapped type over
 * `Extract<RegisteredRelatedView, { source: E }>` — was prototyped and does not
 * typecheck: `relatedViewRegistry` resolves each row's `target` at runtime
 * through `localRelationshipByKey`, whose return type is `LocalPathRelationship`
 * with `target: Entity`, and the registry is `.map()`ed (which erases tuple
 * position) then cast to `readonly (RelatedViewPresentation & { target: Entity
 * })[]`. So only `source`/`filterPrefix` survive as literals; a view with no
 * `filterPrefix` override contributes the whole 18-member `Entity` union as its
 * prefix. Measured: `{ [K in `${PrefixOf<Src<"wish">>}Id`]: … }` produces
 * `cookbookId | expenseId | …` (18 keys) instead of `productId`, i.e. exactly
 * the `Record<string, …>` regression that would un-type `filters.vendorId`
 * across every caller. Recovering the literal would mean an `as const`
 * entityManifest plus a generic `localRelationshipByKey`, or a second
 * hand-maintained key→target table that duplicates the manifest — more drift
 * surface than the 15 blocks below cost.
 */
export const productRelatedFilterFields = {
  ...trio("vendor", vendorShortcode),
  ...trio("project", projectShortcode),
  ...trio("usedOnProject", projectShortcode),
  ...trio("purchase", purchaseShortcode),
  ...trio("expense", expenseShortcode),
  ...trio("relatedInventory", inventoryShortcode),
  ...trio("wish", wishShortcode),
  ...trio("task", taskShortcode),
  ...trio("meal", mealShortcode),
  ...trio("eater", partyFilter(ledgerPartyShortcode)),
};
export const recipeRelatedFilterFields = {
  ...trio("ingredient", ingredientShortcode),
  ...trio("meal", mealShortcode),
};
export const mealRelatedFilterFields = {
  ...trio("recipe", recipeShortcode),
  ...trio("foodProduct", productShortcode),
  ...trio("foodIngredient", ingredientShortcode),
  ...trio("eater", partyFilter(ledgerPartyShortcode)),
};
export const locationRelatedFilterFields = {
  ...trio("ingredient", ingredientShortcode),
};
export const inventoryRelatedFilterFields = trio(
  "ingredient",
  ingredientShortcode,
);
export const ingredientRelatedFilterFields = {
  ...trio("meal", mealShortcode),
  ...trio("eater", partyFilter(ledgerPartyShortcode)),
};
export const ledgerPartyRelatedFilterFields = {
  ...trio("meal", mealShortcode),
  ...trio("recipe", recipeShortcode),
};
export const projectRelatedFilterFields = {
  ...trio("project", projectShortcode),
  ...trio("task", taskShortcode),
  ...trio("expense", expenseShortcode),
  ...trio("taskProduct", productShortcode),
  ...trio("purchasedProduct", productShortcode),
  ...trio("usedTool", productShortcode),
  ...trio("vendor", vendorShortcode),
};
export const taskRelatedFilterFields = {
  ...trio("blockedByTask", taskShortcode),
  ...trio("parentTask", taskShortcode),
};
export const vendorRelatedFilterFields = {
  ...trio("brandedProduct", productShortcode),
  ...trio("expense", expenseShortcode),
  ...trio("purchase", purchaseShortcode),
  ...trio("product", productShortcode),
  ...trio("project", projectShortcode),
  ...trio("financialTransaction", financialTransactionShortcode),
};
export const purchaseRelatedFilterFields = {
  ...trio("expense", expenseShortcode),
  ...trio("financialTransaction", financialTransactionShortcode),
  ...trio("product", productShortcode),
  ...trio("project", projectShortcode),
};
export const expenseRelatedFilterFields = trio(
  "financialTransaction",
  financialTransactionShortcode,
);
export const financialAccountRelatedFilterFields = {
  ...trio("financialTransaction", financialTransactionShortcode),
  ...trio("purchase", purchaseShortcode),
  ...trio("vendor", vendorShortcode),
};
export const financialTransactionRelatedFilterFields = {
  ...trio("vendor", vendorShortcode),
  ...trio("expense", expenseShortcode),
  ...trio("product", productShortcode),
};
export const wishRelatedFilterFields = trio("product", productShortcode);
