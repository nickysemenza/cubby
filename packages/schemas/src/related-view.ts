import { z } from "zod";
import type { Entity } from "./entity";
import { localRelationshipByKey } from "./entity-manifest";
import { money } from "./money";
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
    key: "product.vendors",
    source: "product",
    relationship: "vendors",
    defaultVisible: false,
    order: "alphabetical",
    inverseKey: "vendor.products",
  },
  {
    key: "product.projects",
    source: "product",
    relationship: "purchased-projects",
    defaultVisible: false,
    order: "alphabetical",
    inverseKey: "project.purchasedProducts",
  },
  {
    key: "product.usedOnProjects",
    source: "product",
    relationship: "project-uses",
    defaultVisible: false,
    order: "alphabetical",
    filterPrefix: "usedOnProject",
    inverseKey: "project.usedTools",
  },
  {
    key: "product.purchases",
    source: "product",
    relationship: "purchases",
    // "via spend", not just "Purchases": the product detail page now also has a
    // Purchases section fed by the direct `PurchaseProduct` provenance link, and
    // the two answer different questions. This path reaches a purchase only
    // through a money row, so it is empty for an installment order whose
    // Expenses are `lineBasis: "allocation"` — exactly the case the direct link
    // was added for. Two sections both labelled "Purchases" is the confusion
    // that feature exists to remove.
    defaultVisible: false,
    order: "newest",
  },
  {
    key: "product.expenses",
    source: "product",
    relationship: "expenses",
    defaultVisible: false,
    order: "newest",
  },
  {
    key: "product.inventory",
    source: "product",
    relationship: "inventory",
    defaultVisible: false,
    order: "newest",
    filterPrefix: "relatedInventory",
  },
  {
    key: "product.wishes",
    source: "product",
    relationship: "wishes",
    defaultVisible: false,
    order: "alphabetical",
  },
  {
    key: "product.tasks",
    source: "product",
    relationship: "tasks",
    defaultVisible: false,
    order: "task",
  },
  {
    key: "product.meals",
    source: "product",
    relationship: "meals",
    defaultVisible: false,
    order: "newest",
    inverseKey: "meal.foodProducts",
  },
  {
    key: "product.eaters",
    source: "product",
    relationship: "eaters",
    defaultVisible: false,
    order: "alphabetical",
    filterPrefix: "eater",
  },
  {
    key: "ingredient.meals",
    source: "ingredient",
    relationship: "meals",
    defaultVisible: false,
    order: "newest",
    inverseKey: "meal.foodIngredients",
  },
  {
    key: "ingredient.eaters",
    source: "ingredient",
    relationship: "eaters",
    defaultVisible: false,
    order: "alphabetical",
    filterPrefix: "eater",
  },
  {
    key: "recipe.ingredients",
    source: "recipe",
    relationship: "ingredients",
    defaultVisible: false,
    order: "alphabetical",
  },
  {
    key: "recipe.meals",
    source: "recipe",
    relationship: "meals",
    defaultVisible: false,
    order: "newest",
    inverseKey: "meal.recipes",
  },
  {
    key: "meal.recipes",
    source: "meal",
    relationship: "recipes",
    defaultVisible: false,
    order: "alphabetical",
    inverseKey: "recipe.meals",
  },
  {
    key: "meal.foodProducts",
    source: "meal",
    relationship: "food-products",
    defaultVisible: false,
    order: "alphabetical",
    filterPrefix: "foodProduct",
    inverseKey: "product.meals",
  },
  {
    key: "meal.foodIngredients",
    source: "meal",
    relationship: "food-ingredients",
    defaultVisible: false,
    order: "alphabetical",
    filterPrefix: "foodIngredient",
    inverseKey: "ingredient.meals",
  },
  {
    // The `eaters` relation's list column reads only the primary (food-entry)
    // source; the `portions` (served-portion) source is graph-only, because
    // `relatedViewPath` below compiles `provenance.steps` and never `sources`.
    key: "meal.eaters",
    source: "meal",
    relationship: "eaters",
    defaultVisible: false,
    order: "alphabetical",
    filterPrefix: "eater",
    inverseKey: "ledgerParty.meals",
  },
  {
    key: "location.ingredients",
    source: "location",
    relationship: "ingredients",
    defaultVisible: false,
    order: "alphabetical",
  },
  {
    key: "inventory.ingredient",
    source: "inventory",
    relationship: "ingredient",
    defaultVisible: false,
    order: "alphabetical",
  },
  {
    key: "project.blockedBy",
    source: "project",
    relationship: "blocked-by",
    defaultVisible: true,
    order: "alphabetical",
  },
  {
    key: "project.tasks",
    source: "project",
    relationship: "tasks",
    defaultVisible: false,
    order: "task",
  },
  {
    key: "project.expenses",
    source: "project",
    relationship: "expenses",
    defaultVisible: false,
    order: "newest",
  },
  {
    key: "project.taskProducts",
    source: "project",
    relationship: "task-products",
    defaultVisible: false,
    order: "alphabetical",
    filterPrefix: "taskProduct",
  },
  {
    key: "project.purchasedProducts",
    source: "project",
    relationship: "purchased-products",
    defaultVisible: false,
    order: "alphabetical",
    filterPrefix: "purchasedProduct",
    inverseKey: "product.projects",
  },
  {
    key: "project.usedTools",
    source: "project",
    relationship: "resources",
    defaultVisible: true,
    order: "alphabetical",
    filterPrefix: "usedTool",
    inverseKey: "product.usedOnProjects",
  },
  {
    key: "project.vendors",
    source: "project",
    relationship: "vendors",
    defaultVisible: false,
    order: "alphabetical",
    inverseKey: "vendor.projects",
  },
  {
    key: "task.blockedBy",
    source: "task",
    relationship: "blocked-by",
    defaultVisible: true,
    order: "task",
    filterPrefix: "blockedByTask",
  },
  {
    key: "task.parent",
    source: "task",
    relationship: "parent",
    defaultVisible: false,
    order: "task",
    filterPrefix: "parentTask",
  },
  {
    key: "vendor.expenses",
    source: "vendor",
    relationship: "expenses",
    defaultVisible: true,
    order: "newest",
  },
  {
    key: "vendor.purchases",
    source: "vendor",
    relationship: "purchases",
    defaultVisible: false,
    order: "newest",
  },
  {
    key: "vendor.products",
    source: "vendor",
    relationship: "products",
    defaultVisible: false,
    order: "alphabetical",
    inverseKey: "product.vendors",
  },
  {
    key: "vendor.projects",
    source: "vendor",
    relationship: "projects",
    defaultVisible: false,
    order: "alphabetical",
    inverseKey: "project.vendors",
  },
  {
    key: "vendor.transactions",
    source: "vendor",
    relationship: "transactions",
    defaultVisible: false,
    order: "newest",
  },
  {
    key: "purchase.expenses",
    source: "purchase",
    relationship: "expenses",
    defaultVisible: true,
    order: "newest",
  },
  {
    key: "purchase.transactions",
    source: "purchase",
    relationship: "financial-transactions",
    defaultVisible: true,
    order: "newest",
  },
  {
    key: "purchase.products",
    source: "purchase",
    relationship: "products",
    defaultVisible: false,
    order: "alphabetical",
  },
  {
    key: "purchase.projects",
    source: "purchase",
    relationship: "projects",
    defaultVisible: false,
    order: "alphabetical",
  },
  {
    key: "expense.transactions",
    source: "expense",
    relationship: "transactions",
    defaultVisible: false,
    order: "newest",
  },
  {
    key: "financialAccount.transactions",
    source: "financialAccount",
    relationship: "transactions",
    defaultVisible: true,
    order: "newest",
  },
  {
    key: "financialAccount.purchases",
    source: "financialAccount",
    relationship: "purchases",
    defaultVisible: false,
    order: "newest",
  },
  {
    key: "financialAccount.vendors",
    source: "financialAccount",
    relationship: "vendors",
    defaultVisible: false,
    order: "alphabetical",
  },
  {
    key: "financialTransaction.vendor",
    source: "financialTransaction",
    relationship: "vendor",
    defaultVisible: true,
    order: "alphabetical",
  },
  {
    key: "financialTransaction.expenses",
    source: "financialTransaction",
    relationship: "expenses",
    defaultVisible: false,
    order: "newest",
  },
  {
    key: "financialTransaction.products",
    source: "financialTransaction",
    relationship: "products",
    defaultVisible: false,
    order: "alphabetical",
  },
  {
    key: "wish.candidates",
    source: "wish",
    relationship: "candidates",
    defaultVisible: true,
    order: "alphabetical",
  },
  {
    // The `meals` relation's list column reads only the primary (food-entry)
    // source; the `portions` (served-portion) source is graph-only, because
    // `relatedViewPath` below compiles `provenance.steps` and never `sources`.
    key: "ledgerParty.meals",
    source: "ledgerParty",
    relationship: "meals",
    defaultVisible: false,
    order: "newest",
    inverseKey: "meal.eaters",
  },
  {
    key: "ledgerParty.recipesEaten",
    source: "ledgerParty",
    relationship: "recipes-eaten",
    defaultVisible: false,
    order: "alphabetical",
  },
] as const satisfies readonly RelatedViewPresentationDefinition[];

/**
 * The registry chooses which declared graph relationships are presented in a
 * table. Traversal reads this map, not the legacy view-local path, so all live
 * SQL now starts from the manifest graph while the presentation migration is
 * completed incrementally.
 */
type RelatedViewPresentation = (typeof relatedViewPresentationRegistry)[number];

const relatedViewRelationshipKeys = {
  "product.vendors": "vendors",
  "product.projects": "purchased-projects",
  "product.usedOnProjects": "project-uses",
  "product.purchases": "purchases",
  "product.expenses": "expenses",
  "product.inventory": "inventory",
  "product.wishes": "wishes",
  "product.tasks": "tasks",
  "product.meals": "meals",
  "product.eaters": "eaters",
  "ingredient.meals": "meals",
  "ingredient.eaters": "eaters",
  "recipe.ingredients": "ingredients",
  "recipe.meals": "meals",
  "meal.recipes": "recipes",
  "meal.foodProducts": "food-products",
  "meal.foodIngredients": "food-ingredients",
  "meal.eaters": "eaters",
  "location.ingredients": "ingredients",
  "inventory.ingredient": "ingredient",
  "project.blockedBy": "blocked-by",
  "project.tasks": "tasks",
  "project.expenses": "expenses",
  "project.taskProducts": "task-products",
  "project.purchasedProducts": "purchased-products",
  "project.usedTools": "resources",
  "project.vendors": "vendors",
  "task.blockedBy": "blocked-by",
  "task.parent": "parent",
  "vendor.expenses": "expenses",
  "vendor.purchases": "purchases",
  "vendor.products": "products",
  "vendor.projects": "projects",
  "vendor.transactions": "transactions",
  "purchase.expenses": "expenses",
  "purchase.transactions": "financial-transactions",
  "purchase.products": "products",
  "purchase.projects": "projects",
  "expense.transactions": "transactions",
  "financialAccount.transactions": "transactions",
  "financialAccount.purchases": "purchases",
  "financialAccount.vendors": "vendors",
  "financialTransaction.vendor": "vendor",
  "financialTransaction.expenses": "expenses",
  "financialTransaction.products": "products",
  "wish.candidates": "candidates",
  "ledgerParty.meals": "meals",
  "ledgerParty.recipesEaten": "recipes-eaten",
} as const satisfies Record<
  (typeof relatedViewPresentationRegistry)[number]["key"],
  string
>;
type RelatedViewRelationshipKey = keyof typeof relatedViewRelationshipKeys;
const isRelatedViewRelationshipKey = (
  key: string,
): key is RelatedViewRelationshipKey =>
  Object.hasOwn(relatedViewRelationshipKeys, key);

export const relatedViewRegistry = relatedViewPresentationRegistry.map(
  (view) => {
    const relationship = localRelationshipByKey(view.source, view.relationship);
    return { ...view, target: relationship.target, label: relationship.label };
  },
) satisfies readonly (RelatedViewPresentation & {
  target: Entity;
  label: string;
})[];

export const relatedViewPath = (
  view: Pick<RelatedViewDefinition, "source" | "key">,
) => {
  if (!isRelatedViewRelationshipKey(view.key)) {
    throw new Error(`Unknown related view key: ${view.key}`);
  }
  const relationshipKey = relatedViewRelationshipKeys[view.key];
  return localRelationshipByKey(view.source, relationshipKey).provenance.steps;
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
  cookbook: "the cookbook page IS its recipe list",
  ledgerTransfer:
    "ledger transfer relationships are rendered in the household ledger",
  // The one entity with no shortcode, no detail route, and no list table.
  image: "no detail route or list table to hang a preview column on",
  planting:
    "its cross-entity relationships (ingredient, location, source product, task) are already reachable from those entities' own declared relation sections",
  gardenEntry: "garden timelines render entries directly",
  vendorAccount:
    "vendor account ownership and vendor links are rendered as detail fields",
  // Not a local entity — remote USDA search results, no local edges.
  "usda-food": "remote USDA records have no local relationships",
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
        direction: z.enum(["asc", "desc"]),
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
    netSpend: money,
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
    netSpend: money,
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
  ...trio("eater", ledgerPartyShortcode),
};
export const recipeRelatedFilterFields = {
  ...trio("ingredient", ingredientShortcode),
  ...trio("meal", mealShortcode),
};
export const mealRelatedFilterFields = {
  ...trio("recipe", recipeShortcode),
  ...trio("foodProduct", productShortcode),
  ...trio("foodIngredient", ingredientShortcode),
  ...trio("eater", ledgerPartyShortcode),
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
  ...trio("eater", ledgerPartyShortcode),
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
