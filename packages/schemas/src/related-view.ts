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
  mealShortcode,
  productShortcode,
  projectShortcode,
  purchaseShortcode,
  recipeShortcode,
  taskShortcode,
  vendorShortcode,
  wishShortcode,
} from "./identifiers";

/**
 * Curated relationship columns which supplement (rather than duplicate) the
 * direct relation columns already owned by each entity list.
 *
 * Paths use the same edge/direction vocabulary as entityManifest. Keeping the
 * declaration in schemas makes the API contract and the UI agree on the exact
 * set of paths the server is willing to execute; SQL remains server-owned.
 */
interface RelatedViewPresentationDefinition {
  key: string;
  source: Entity;
  /** `entityManifest[source].relationships[].key` — the canonical graph. */
  relationship?: string;
  defaultVisible: boolean;
  order: "alphabetical" | "newest" | "task";
  /** Override when one source has multiple curated paths to the same target. */
  filterPrefix?: string;
  /**
   * The directional key that realizes this same relationship from the other
   * endpoint.  A relation can still be one-way when its reverse is not a
   * useful list/table concept; callers must not manufacture SQL from paths.
   */
  inverseKey?: string;
}

/** Fully resolved runtime projection; presentation declarations never carry paths. */
export interface RelatedViewDefinition
  extends RelatedViewPresentationDefinition {
  target: Entity;
  label: string;
}

const relatedViewPresentationRegistry = [
  {
    key: "product.vendors",
    source: "product",
    relationship: "vendors",
    // Off by default: each of these relational previews is a wide column that
    // renders the no-value placeholder on most products, and three of them
    // together spent ~768px of a 1280px viewport — the single largest cause of
    // the products list scrolling sideways. Reachable from the View menu for
    // the rows that do have them.
    defaultVisible: false,
    order: "alphabetical",
    inverseKey: "vendor.products",
  },
  {
    key: "product.projects",
    source: "product",
    relationship: "purchased-projects",
    // Off by default: each of these relational previews is a wide column that
    // renders the no-value placeholder on most products, and three of them
    // together spent ~768px of a 1280px viewport — the single largest cause of
    // the products list scrolling sideways. Reachable from the View menu for
    // the rows that do have them.
    defaultVisible: false,
    order: "alphabetical",
    inverseKey: "project.purchasedProducts",
  },
  {
    key: "product.usedOnProjects",
    source: "product",
    relationship: "project-uses",
    // Off by default: each of these relational previews is a wide column that
    // renders the no-value placeholder on most products, and three of them
    // together spent ~768px of a 1280px viewport — the single largest cause of
    // the products list scrolling sideways. Reachable from the View menu for
    // the rows that do have them.
    defaultVisible: false,
    order: "alphabetical",
    filterPrefix: "usedOnProject",
    inverseKey: "project.usedTools",
  },
  {
    key: "product.purchases",
    source: "product",
    relationship: "purchases-via-spend",
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
    relationship: "tools-used",
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
  "product.purchases": "purchases-via-spend",
  "product.expenses": "expenses",
  "product.inventory": "inventory",
  "product.wishes": "wishes",
  "product.tasks": "tasks",
  "recipe.ingredients": "ingredients",
  "recipe.meals": "meals",
  "meal.recipes": "recipes",
  "location.ingredients": "ingredients",
  "inventory.ingredient": "ingredient",
  "project.blockedBy": "blocked-by",
  "project.tasks": "tasks",
  "project.expenses": "expenses",
  "project.taskProducts": "task-products",
  "project.purchasedProducts": "purchased-products",
  "project.usedTools": "tools-used",
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
} as const satisfies Record<
  (typeof relatedViewPresentationRegistry)[number]["key"],
  string
>;

export const relatedViewRegistry = relatedViewPresentationRegistry.map(
  (view) => {
    const relationship = localRelationshipByKey(view.source, view.relationship);
    return { ...view, target: relationship.target, label: relationship.label };
  },
) as readonly (RelatedViewPresentation & {
  target: Entity;
  label: string;
})[];

/** The executable path is resolved from the canonical manifest graph. */
export const relatedViewPath = (
  view: Pick<RelatedViewDefinition, "source" | "key">,
) =>
  localRelationshipByKey(
    view.source,
    relatedViewRelationshipKeys[
      view.key as keyof typeof relatedViewRelationshipKeys
    ],
  ).provenance.steps;

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
  // Reached through its recipes; an ingredient's own relationships are
  // usage rollups the ingredient detail page already renders in full.
  ingredient: "usages are rendered in full on the detail page, not previewed",
  // Browsed as a gallery, and its one relationship (its recipes) is the page.
  cookbook: "the cookbook page IS its recipe list",
  // The one entity with no shortcode, no detail route, and no list table.
  image: "no detail route or list table to hang a preview column on",
  // Not a local entity — remote USDA search results, no local edges.
  "usda-food": "remote USDA records have no local relationships",
} as const satisfies Record<Exclude<Entity, RelatedViewSource>, string>;

/**
 * A registry row with its literal `key` intact — callers derive
 * `RelatedViewKey[]` from these, so widening to `RelatedViewDefinition` here
 * would erase the union the preview endpoints validate against.
 */
type RegisteredRelatedView = (typeof relatedViewRegistry)[number];

/** Stable identity so a `useMemo` over the result doesn't churn. */
const NO_RELATED_VIEWS: readonly RegisteredRelatedView[] = [];

/**
 * The curated related views a source entity offers — the single reader of the
 * registry, so the opt-out above is load-bearing rather than decorative.
 */
export const relatedViewsFor = (
  entity: Entity,
): readonly RegisteredRelatedView[] =>
  entity in ENTITIES_WITHOUT_RELATED_VIEWS
    ? NO_RELATED_VIEWS
    : relatedViewRegistry.filter((view) => view.source === entity);

export const relatedViewKeys = relatedViewRegistry.map((view) => view.key) as [
  (typeof relatedViewRegistry)[number]["key"],
  ...(typeof relatedViewRegistry)[number]["key"][],
];
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

/** A page of full related records for the detail-page outline tree. */
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

/** Expense-backed aggregates for the purchasing provenance mini tables. */
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

/** Searchable relation target options; count is distinct matching source rows. */
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
  return {
    [`${prefix}Id`]: ids,
    [`${prefix}PresenceFilter`]: relatedPresence,
    [`${prefix}Search`]: relatedSearch,
  } as RelatedTrio<Prefix, typeof ids>;
};

export const productRelatedFilterFields = {
  ...trio("vendor", vendorShortcode),
  ...trio("project", projectShortcode),
  ...trio("usedOnProject", projectShortcode),
  ...trio("purchase", purchaseShortcode),
  ...trio("expense", expenseShortcode),
  ...trio("relatedInventory", inventoryShortcode),
  ...trio("wish", wishShortcode),
  ...trio("task", taskShortcode),
};
export const recipeRelatedFilterFields = {
  ...trio("ingredient", ingredientShortcode),
  ...trio("meal", mealShortcode),
};
export const mealRelatedFilterFields = trio("recipe", recipeShortcode);
export const locationRelatedFilterFields = trio(
  "ingredient",
  ingredientShortcode,
);
export const inventoryRelatedFilterFields = trio(
  "ingredient",
  ingredientShortcode,
);
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
