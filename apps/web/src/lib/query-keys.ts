import type { QueryClient, QueryKey } from "@tanstack/react-query";

const entityKey = <TEntity extends string>(entity: TEntity) =>
  [entity] as const;
const procedureKey = <TEntity extends string, TProcedure extends string>(
  entity: TEntity,
  procedure: TProcedure,
) => [entity, procedure] as const;

/**
 * Centralized query key definitions for React Query.
 * Use these constants to ensure consistency across query invalidations.
 */
export const queryKeys = {
  inventory: {
    all: entityKey("inventory"),
    list: procedureKey("inventory", "list"),
  },
  image: {
    all: entityKey("image"),
    list: procedureKey("image", "list"),
    getByID: procedureKey("image", "getByID"),
  },
  usda: {
    all: entityKey("usda"),
    list: procedureKey("usda", "list"),
  },
  product: {
    // Broad prefix — invalidate every product query (list / search / getByID …)
    // so the deferred product picker (product.search) AND the products table
    // (product.list) both refresh after any product create/update/delete. The
    // picker reads a different key than the table, so a list-only invalidation
    // would leave its options stale.
    list: procedureKey("product", "list"),
    getByID: procedureKey("product", "getByID"),
    getByShortcode: procedureKey("product", "getByShortcode"),
    all: entityKey("product"),
  },
  location: {
    list: procedureKey("location", "list"),
    makeTree: procedureKey("location", "makeTree"),
    subtree: procedureKey("location", "subtree"),
    inventoryBreakdown: procedureKey("location", "inventoryBreakdown"),
    getByID: procedureKey("location", "getByID"),
    getByShortcode: procedureKey("location", "getByShortcode"),
    // The bounded parent-filter roster (`useLocationParentOptions`) — only
    // locations with a live child, so it needs its own key rather than
    // reusing `list`'s (different filter shape, would collide in the cache).
    parentOptions: procedureKey("location", "parentOptions"),
    // Broad prefix — invalidate every location query (list / makeTree / getByID)
    // so persisted valuation rollups are re-read after an inventory/price change.
    all: entityKey("location"),
  },
  ingredient: {
    list: procedureKey("ingredient", "list"),
    getByID: procedureKey("ingredient", "getByID"),
    getByShortcode: procedureKey("ingredient", "getByShortcode"),
    getByName: procedureKey("ingredient", "getByName"),
    // Broad prefix — invalidate every ingredient query (list / getByName /
    // getByID …) after an enrich/merge/update so all consumers re-read.
    all: entityKey("ingredient"),
  },
  problems: {
    // Broad prefix — invalidate every problems query so a fix re-reads whichever
    // cost-grouped detector query (getFast / getCoverage / getUpc / getTracker)
    // owns the resolved card.
    all: entityKey("problems"),
  },
  search: {
    all: entityKey("search"),
  },
  dashboard: {
    counts: procedureKey("dashboard", "counts"),
  },
  calendar: {
    all: entityKey("calendar"),
  },
  oauth: {
    connectedApps: procedureKey("oauth", "listConnectedApps"),
    orphaned: procedureKey("oauth", "countOrphanedClients"),
  },
  debug: {
    timing: procedureKey("debug", "timing"),
  },
  recipe: {
    list: procedureKey("recipe", "list"),
    getByID: procedureKey("recipe", "getByID"),
    getByShortcode: procedureKey("recipe", "getByShortcode"),
    flow: procedureKey("recipe", "getFlow"),
    // The cookbook browse index lives on the recipe router (`recipe.listCookbooks`),
    // so its key mirrors that tRPC path.
    listCookbooks: procedureKey("recipe", "listCookbooks"),
    all: entityKey("recipe"),
  },
  cookbook: {
    all: procedureKey("recipe", "listCookbooks"),
  },
  meal: {
    list: procedureKey("meal", "list"),
    getByID: procedureKey("meal", "getByID"),
    byDateRange: procedureKey("meal", "byDateRange"),
    shoppingList: procedureKey("meal", "shoppingList"),
    all: entityKey("meal"),
  },
  project: {
    list: procedureKey("project", "list"),
    getByID: procedureKey("project", "getByID"),
    dashboard: procedureKey("project", "dashboard"),
    all: entityKey("project"),
  },
  task: {
    list: procedureKey("task", "list"),
    all: entityKey("task"),
  },
  expense: {
    list: procedureKey("expense", "list"),
    all: entityKey("expense"),
  },
  vendor: {
    list: procedureKey("vendor", "list"),
    // Broad prefix — a rename or a new charge changes `list`, `getByID` AND the
    // `options` picklist (which carries each vendor's charge count), so every
    // vendor query has to re-read.
    all: entityKey("vendor"),
  },
  purchase: {
    list: procedureKey("purchase", "list"),
    all: entityKey("purchase"),
  },
  financialAccount: {
    all: entityKey("financialAccount"),
    list: procedureKey("financialAccount", "list"),
  },
  financialTransaction: {
    all: entityKey("financialTransaction"),
    list: procedureKey("financialTransaction", "list"),
  },
  wish: {
    list: procedureKey("wish", "list"),
    all: entityKey("wish"),
  },
  relatedData: {
    // Relationship previews and aggregate summaries are derived from several
    // entity families. Mutations invalidate this shared root rather than
    // trying to enumerate relation-key-specific cache entries.
    all: entityKey("relatedData"),
  },
} as const;

/**
 * The surfaces that re-read whenever a product's price, quantity, or shelf
 * moves. Shared by every money- or stock-moving fan-out (expense, purchase,
 * product merge, ingredient merge) rather than re-listed at each.
 */
const costAndStockRipple = [
  queryKeys.product.all,
  queryKeys.inventory.all,
  queryKeys.location.all,
  // Cost inputs changed → recipe totals and the meal rollups read off them.
  queryKeys.recipe.all,
  queryKeys.meal.all,
  // Rows leave/enter the catalog: stale hits and detector rows both go.
  queryKeys.problems.all,
  queryKeys.search.all,
] as const;

/** Dedupe by key identity — the `queryKeys` entries are stable references, so
 * a group spread into a fan-out that already names one of its keys collapses
 * instead of invalidating the same prefix twice. */
const fanout = (...keys: readonly QueryKey[]): readonly QueryKey[] =>
  Object.freeze([...new Set(keys)]);

const productBase = fanout(
  queryKeys.product.all,
  queryKeys.relatedData.all,
  // Task rows embed their subject product's display name. A product rename
  // must not leave the task list/detail cache showing the old name.
  queryKeys.task.all,
  queryKeys.dashboard.counts,
  queryKeys.wish.all,
);

const ingredientAll = fanout(
  queryKeys.ingredient.all,
  queryKeys.dashboard.counts,
);

/**
 * Per-entity invalidation fan-out. `base` is what an ordinary create/update/
 * delete of that entity invalidates; the sibling ops name the writes that move
 * MORE than the entity's own rows and would otherwise leave other views
 * rendering pre-mutation state.
 *
 * Deliberately NOT a blanket invalidation: every key here costs a refetch
 * against Neon (#887), and `useOptimisticDelete` walks these same arrays to do
 * per-key `setQueriesData` cache surgery — so they must stay real, narrow key
 * lists rather than a catch-all prefix.
 */
const invalidationFanout = {
  product: {
    base: productBase,
    /**
     * Product MERGE moves far more than a product write does. A rename touches
     * the product row and the surfaces that embed its name; a merge re-parents
     * rows across five other entities: inventory entries move and re-value at
     * the keeper's price (`planInventoryFold` →
     * `syncInventoryValuationsForProduct`), expenses and projectUses are
     * re-pointed, and dependent recipe costs are recomputed (#603). Left on the
     * narrow set, every one of those views kept rendering the pre-merge state —
     * including rows pointing at a now soft-deleted loser.
     */
    merge: fanout(
      ...productBase,
      ...costAndStockRipple,
      queryKeys.expense.all,
      queryKeys.project.all,
    ),
    /** A product write that also changed recipe cost inputs → meal rollups
     * (read from `recipe.totals`) go stale with them. */
    recipe: fanout(...productBase, queryKeys.recipe.list, queryKeys.meal.all),
    /** Price/valuation only — no name change, so no task/wish name echo. */
    valuation: fanout(
      queryKeys.product.all,
      queryKeys.recipe.list,
      queryKeys.location.all,
      queryKeys.meal.all,
      queryKeys.dashboard.counts,
    ),
    /** UPC/USDA lookup: identity resolves, detectors and search re-read. */
    lookup: fanout(
      queryKeys.product.all,
      queryKeys.problems.all,
      queryKeys.search.all,
      queryKeys.dashboard.counts,
    ),
    /** A ProductComponent edge is a Product→Product link, visible from both
     * ends (a kit's own component list, and the transpose kit-membership
     * list). It carries no money of its own — the kit keeps its own Expense —
     * so there's no spend, inventory, or calendar state to invalidate. */
    component: fanout(queryKeys.product.all, queryKeys.relatedData.all),
  },
  inventory: {
    base: fanout(
      queryKeys.inventory.all,
      queryKeys.location.all,
      queryKeys.product.all,
      queryKeys.problems.all,
      queryKeys.search.all,
      queryKeys.dashboard.counts,
    ),
  },
  location: {
    base: fanout(queryKeys.location.list, queryKeys.dashboard.counts),
    /**
     * Reparenting changes tree SHAPE, so the list prefix is not enough: the
     * detail page's subtree, the arrange forest, and both ends' parent chains
     * all re-read. Nothing here touches stock — no inventory keys.
     */
    reparent: fanout(queryKeys.location.all, queryKeys.dashboard.counts),
  },
  // The broad `image.all` prefix, not `image.list`: a list-only invalidation
  // doesn't refresh the image DETAIL page after a rename.
  image: {
    base: fanout(queryKeys.image.all, queryKeys.dashboard.counts),
  },
  "usda-food": {
    base: fanout(queryKeys.usda.all),
  },
  ingredient: {
    /** The broad prefix — list / getByName / getByID all re-read. */
    base: ingredientAll,
    /** List-only, for writes that cannot change an ingredient's identity. */
    list: fanout(queryKeys.ingredient.list, queryKeys.dashboard.counts),
    /** Ingredient↔Product link: visible from both ends. */
    product: fanout(...ingredientAll, ...productBase),
    /** Merge re-points recipes, products, and stock at the keeper. */
    merge: fanout(
      queryKeys.ingredient.all,
      ...costAndStockRipple,
      queryKeys.dashboard.counts,
    ),
    /** Unused-ingredient sweep — resolves the detector card that offered it. */
    cleanup: fanout(
      queryKeys.problems.all,
      queryKeys.ingredient.list,
      queryKeys.dashboard.counts,
    ),
  },
  recipe: {
    /** Broad prefix + meal rollups, which read recipe totals. */
    base: fanout(
      queryKeys.recipe.all,
      queryKeys.meal.all,
      queryKeys.dashboard.counts,
    ),
    list: fanout(queryKeys.recipe.list, queryKeys.dashboard.counts),
    /** A recipe moving between cookbooks also moves the browse index. */
    cookbook: fanout(
      queryKeys.recipe.list,
      queryKeys.recipe.listCookbooks,
      queryKeys.dashboard.counts,
    ),
  },
  cookbook: {
    base: fanout(queryKeys.cookbook.all, queryKeys.dashboard.counts),
    /** Linking or unlinking a cookbook's physical copy moves data on BOTH
     * detail pages: the cookbook page reads the link off `listCookbooks`, and
     * the product page reads the reverse embedded in its own detail payload.
     * Invalidating only the cookbook side leaves a stale "Cookbook" panel on
     * the product. */
    productLink: fanout(queryKeys.recipe.listCookbooks, queryKeys.product.all),
  },
  meal: {
    base: fanout(
      queryKeys.meal.all,
      queryKeys.calendar.all,
      queryKeys.dashboard.counts,
    ),
  },
  // Task/expense mutations also invalidate `project.all`: the dashboard and
  // project rollups (spent/progress) aggregate over them.
  project: {
    base: fanout(
      queryKeys.project.all,
      queryKeys.relatedData.all,
      queryKeys.calendar.all,
      queryKeys.dashboard.counts,
    ),
    /** A reusable-resource edge is visible from both ends, but it does not
     * change project spend, inventory quantity, or calendar state. */
    resource: fanout(
      queryKeys.project.all,
      queryKeys.product.all,
      queryKeys.relatedData.all,
    ),
  },
  task: {
    base: fanout(
      queryKeys.task.all,
      queryKeys.project.all,
      queryKeys.calendar.all,
      queryKeys.dashboard.counts,
    ),
  },
  expense: {
    base: fanout(
      queryKeys.expense.all,
      queryKeys.relatedData.all,
      queryKeys.project.all,
      queryKeys.calendar.all,
      queryKeys.dashboard.counts,
      // An expense can link to a product (cost basis / disposition) — recording
      // one from the product page should refresh that product's hero/stamp too.
      ...costAndStockRipple,
      // Writing an expense's `vendor`/`orderId` resolves a Vendor and a Purchase
      // into existence, and EVERY expense write moves a charge's `expenseTotal`
      // and its vendor's `spend`/`purchaseCount` — all three are rollups over
      // this table. Without these, a charge's reconciliation cue keeps showing
      // a stale total.
      queryKeys.vendor.all,
      queryKeys.purchase.all,
    ),
  },
  // A vendor's name is denormalized into `purchaseOut.vendorName`, so a rename
  // has to refresh the charge queries too — otherwise the ledger keeps showing
  // the old name until a hard reload. No expense/project keys: a vendor holds
  // identity only, and every dollar lives on `Expense`.
  vendor: {
    base: fanout(
      queryKeys.vendor.all,
      queryKeys.purchase.all,
      queryKeys.relatedData.all,
      queryKeys.dashboard.counts,
    ),
  },
  purchase: {
    // Purchase mutations move MONEY-bearing rows around (`link` re-parents
    // expenses, `split` replaces one with several, `merge` re-points a charge),
    // so the expense and project rollups go stale alongside the vendor's own
    // `purchaseCount`/`spend`. Splitting a purchase-owned Expense can also
    // change Product quantity/cost basis, hence the ripple.
    base: fanout(
      queryKeys.purchase.all,
      queryKeys.relatedData.all,
      queryKeys.vendor.all,
      queryKeys.expense.all,
      queryKeys.project.all,
      ...costAndStockRipple,
      queryKeys.dashboard.counts,
    ),
    /** A purchase-product link is visible from both ends, but it carries no
     * money or quantity — no spend, inventory, or calendar state. */
    product: fanout(
      queryKeys.purchase.all,
      queryKeys.product.all,
      queryKeys.relatedData.all,
    ),
  },
  /** Finance entries are settlement evidence only, but changing one refreshes
   * the purchase settlement summary and advisory problems. */
  financialAccount: {
    base: fanout(
      queryKeys.financialAccount.all,
      queryKeys.financialTransaction.all,
      queryKeys.dashboard.counts,
    ),
  },
  financialTransaction: {
    base: fanout(
      queryKeys.financialTransaction.all,
      queryKeys.financialAccount.all,
      queryKeys.purchase.all,
      queryKeys.problems.all,
      queryKeys.dashboard.counts,
    ),
  },
  wish: {
    base: fanout(
      queryKeys.wish.all,
      queryKeys.search.all,
      queryKeys.dashboard.counts,
    ),
  },
  /** Not an entity — the Problems page's own detector cards, resolved by a fix
   * that touched nothing else. */
  problems: {
    base: fanout(queryKeys.problems.all),
  },
} as const;

/**
 * Exhaustiveness is enforced at the consumer, not by a `satisfies` clause
 * here: `invalidatesFor` only accepts keys of the table, and every routed
 * entity's contract calls `invalidatesFor(entity)` in `entity-contracts.ts` —
 * so an entity missing a fan-out row is a compile error at its contract, the
 * moment it gets one.
 */
export type InvalidationEntity = keyof typeof invalidationFanout;
/** The wider-than-base operations declared for one entity, if any. */
export type InvalidationOp<E extends InvalidationEntity> = Exclude<
  keyof (typeof invalidationFanout)[E],
  "base"
>;

/**
 * The query keys one write invalidates. `op` selects a declared wider fan-out
 * (`invalidatesFor("product", "merge")`); omitted, you get the entity's `base`.
 *
 * Returns the SAME array reference for the same arguments, so the result is
 * safe to pass straight into a hook dependency array or a memoized config.
 */
export function invalidatesFor<E extends InvalidationEntity>(
  entity: E,
  op?: InvalidationOp<E>,
): readonly QueryKey[] {
  const entry = invalidationFanout[entity] as { base: readonly QueryKey[] } & {
    [key: string]: readonly QueryKey[] | undefined;
  };
  return (op === undefined ? undefined : entry[op as string]) ?? entry.base;
}

export function normalizeTRPCQueryKey(key: QueryKey): QueryKey {
  if (key.length === 0) return key;
  return Array.isArray(key[0]) ? key : [key];
}

export function invalidateTRPCQueries(
  queryClient: QueryClient,
  keys: readonly QueryKey[],
) {
  for (const key of keys) {
    void queryClient.invalidateQueries({
      queryKey: normalizeTRPCQueryKey(key),
    });
  }
}

export async function cancelTRPCQueries(
  queryClient: QueryClient,
  keys: readonly QueryKey[],
) {
  await Promise.all(
    keys.map((key) =>
      queryClient.cancelQueries({ queryKey: normalizeTRPCQueryKey(key) }),
    ),
  );
}
