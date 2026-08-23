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
  person: {
    list: procedureKey("person", "list"),
    all: entityKey("person"),
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

export const inventoryMutationInvalidateKeys = [
  queryKeys.inventory.all,
  queryKeys.location.all,
  queryKeys.product.all,
  queryKeys.problems.all,
  queryKeys.search.all,
  queryKeys.dashboard.counts,
] as const satisfies readonly QueryKey[];

export const productMutationInvalidateKeys = [
  queryKeys.product.all,
  queryKeys.relatedData.all,
  // Task rows embed their subject product's display name. A product rename
  // must not leave the task list/detail cache showing the old name.
  queryKeys.task.all,
  queryKeys.dashboard.counts,
  queryKeys.wish.all,
] as const satisfies readonly QueryKey[];

/**
 * Product MERGE, which moves far more than a product write does — the same
 * reason `ingredientMergeMutationInvalidateKeys` exists separately from
 * `ingredientMutationInvalidateKeys`.
 *
 * A rename touches the product row and the surfaces that embed its name. A
 * merge re-parents rows across five other entities: inventory entries move and
 * re-value at the keeper's price (`planInventoryFold` →
 * `syncInventoryValuationsForProduct`), expenses and projectUses are
 * re-pointed, and dependent recipe costs are recomputed (#603). Left on the
 * narrow set, every one of those views kept rendering the pre-merge state —
 * including rows pointing at a now soft-deleted loser — until something else
 * happened to invalidate them.
 */
export const productMergeMutationInvalidateKeys = [
  ...productMutationInvalidateKeys,
  queryKeys.inventory.all,
  queryKeys.location.all,
  queryKeys.expense.all,
  queryKeys.project.all,
  // Cost inputs changed → recipe totals and the meal rollups read off them.
  queryKeys.recipe.all,
  queryKeys.meal.all,
  // A loser leaves the catalog: stale hits and duplicate-detector rows both go.
  queryKeys.search.all,
  queryKeys.problems.all,
] as const satisfies readonly QueryKey[];

export const wishMutationInvalidateKeys = [
  queryKeys.wish.all,
  queryKeys.search.all,
  queryKeys.dashboard.counts,
] as const satisfies readonly QueryKey[];

export const productRecipeMutationInvalidateKeys = [
  ...productMutationInvalidateKeys,
  queryKeys.recipe.list,
  // Recipe cost inputs changed → meal cost/calorie rollups (read from
  // recipe.totals) go stale; meal queries are cheap to blanket-invalidate.
  queryKeys.meal.all,
] as const satisfies readonly QueryKey[];

export const productValuationMutationInvalidateKeys = [
  queryKeys.product.all,
  queryKeys.recipe.list,
  queryKeys.location.all,
  // Recipe cost inputs changed → refresh meal cost/calorie rollups.
  queryKeys.meal.all,
  queryKeys.dashboard.counts,
] as const satisfies readonly QueryKey[];

export const productLookupMutationInvalidateKeys = [
  queryKeys.product.all,
  queryKeys.problems.all,
  queryKeys.search.all,
  queryKeys.dashboard.counts,
] as const satisfies readonly QueryKey[];

export const locationMutationInvalidateKeys = [
  queryKeys.location.list,
  queryKeys.dashboard.counts,
] as const satisfies readonly QueryKey[];

// Covers the detail query too — the list-only key (imagelist.tsx's
// IMAGE_INVALIDATE_KEYS) doesn't refresh the image detail page after a rename.
export const imageMutationInvalidateKeys = [
  queryKeys.image.list,
  queryKeys.image.getByID,
  queryKeys.dashboard.counts,
] as const satisfies readonly QueryKey[];

export const ingredientMutationInvalidateKeys = [
  queryKeys.ingredient.list,
  queryKeys.dashboard.counts,
] as const satisfies readonly QueryKey[];

export const personMutationInvalidateKeys = [
  queryKeys.person.all,
  queryKeys.search.all,
  queryKeys.dashboard.counts,
] as const satisfies readonly QueryKey[];

export const ingredientAllMutationInvalidateKeys = [
  queryKeys.ingredient.all,
  queryKeys.dashboard.counts,
] as const satisfies readonly QueryKey[];

export const ingredientProductMutationInvalidateKeys = [
  ...ingredientAllMutationInvalidateKeys,
  ...productMutationInvalidateKeys,
] as const satisfies readonly QueryKey[];

export const ingredientMergeMutationInvalidateKeys = [
  queryKeys.ingredient.all,
  queryKeys.product.all,
  queryKeys.recipe.all,
  queryKeys.meal.all,
  queryKeys.inventory.all,
  queryKeys.location.all,
  queryKeys.problems.all,
  queryKeys.search.all,
  queryKeys.dashboard.counts,
] as const satisfies readonly QueryKey[];

export const unusedIngredientCleanupInvalidateKeys = [
  queryKeys.problems.all,
  ...ingredientMutationInvalidateKeys,
] as const satisfies readonly QueryKey[];

export const recipeMutationInvalidateKeys = [
  queryKeys.recipe.list,
  queryKeys.dashboard.counts,
] as const satisfies readonly QueryKey[];

export const recipeCookbookMutationInvalidateKeys = [
  queryKeys.recipe.list,
  queryKeys.recipe.listCookbooks,
  queryKeys.dashboard.counts,
] as const satisfies readonly QueryKey[];

// Linking or unlinking a cookbook's physical copy moves data on BOTH detail
// pages: the cookbook page reads the link off `listCookbooks`, and the product
// page reads the reverse embedded in its own detail payload. Invalidating only
// the cookbook side leaves a stale "Cookbook" panel on the product.
export const cookbookProductLinkInvalidateKeys = [
  queryKeys.recipe.listCookbooks,
  queryKeys.product.all,
] as const satisfies readonly QueryKey[];

export const recipeAllMutationInvalidateKeys = [
  queryKeys.recipe.all,
  // Recipe totals changed → refresh meal cost/calorie rollups.
  queryKeys.meal.all,
  queryKeys.dashboard.counts,
] as const satisfies readonly QueryKey[];

export const problemsMutationInvalidateKeys = [
  queryKeys.problems.all,
] as const satisfies readonly QueryKey[];

export const mealMutationInvalidateKeys = [
  queryKeys.meal.all,
  queryKeys.calendar.all,
  queryKeys.dashboard.counts,
] as const satisfies readonly QueryKey[];

// Task/expense mutations also invalidate `project.all`: the dashboard and
// project rollups (spent/progress) aggregate over them.
export const projectMutationInvalidateKeys = [
  queryKeys.project.all,
  queryKeys.relatedData.all,
  queryKeys.calendar.all,
  queryKeys.dashboard.counts,
] as const satisfies readonly QueryKey[];

/** A reusable-resource edge is visible from both ends, but it does not change project
 * spend, inventory quantity, or calendar state. */
export const projectResourceMutationInvalidateKeys = [
  queryKeys.project.all,
  queryKeys.product.all,
  queryKeys.relatedData.all,
] as const satisfies readonly QueryKey[];

/** A purchase-product link is visible from both ends, but it carries no money
 * or quantity — no spend, inventory, or calendar state to invalidate. */
export const purchaseProductMutationInvalidateKeys = [
  queryKeys.purchase.all,
  queryKeys.product.all,
  queryKeys.relatedData.all,
] as const satisfies readonly QueryKey[];

/** A ProductComponent edge is a Product→Product link, visible from both ends
 * (a kit's own component list, and the transpose kit-membership list). It
 * carries no money of its own — the kit keeps its own Expense — so there's no
 * spend, inventory, or calendar state to invalidate, only both product reads. */
export const productComponentMutationInvalidateKeys = [
  queryKeys.product.all,
  queryKeys.relatedData.all,
] as const satisfies readonly QueryKey[];

export const taskMutationInvalidateKeys = [
  queryKeys.task.all,
  queryKeys.project.all,
  queryKeys.calendar.all,
  queryKeys.dashboard.counts,
] as const satisfies readonly QueryKey[];

export const expenseMutationInvalidateKeys = [
  queryKeys.expense.all,
  queryKeys.relatedData.all,
  queryKeys.project.all,
  queryKeys.calendar.all,
  queryKeys.dashboard.counts,
  // An expense can link to a product (cost basis / disposition) — recording
  // one from the product page should refresh that product's hero/stamp too.
  queryKeys.product.all,
  queryKeys.inventory.all,
  queryKeys.location.all,
  queryKeys.recipe.all,
  queryKeys.meal.all,
  queryKeys.problems.all,
  queryKeys.search.all,
  // Writing an expense's `vendor`/`orderId` resolves a Vendor and a Purchase into
  // existence, and EVERY expense write moves a charge's `expenseTotal` and its
  // vendor's `spend`/`purchaseCount` — all three are rollups over this table.
  // Without these, a charge's reconciliation cue keeps showing a stale total.
  queryKeys.vendor.all,
  queryKeys.purchase.all,
] as const satisfies readonly QueryKey[];

// A vendor's name is denormalized into `purchaseOut.vendorName`, so a rename has
// to refresh the charge queries too — otherwise the ledger keeps showing the old
// name until a hard reload. No expense/project keys: a vendor holds identity
// only, and every dollar lives on `Expense`.
export const vendorMutationInvalidateKeys = [
  queryKeys.vendor.all,
  queryKeys.purchase.all,
  queryKeys.relatedData.all,
  queryKeys.dashboard.counts,
] as const satisfies readonly QueryKey[];

// Purchase mutations move MONEY-bearing rows around (`link` re-parents expenses,
// `split` replaces one with several, `merge` re-points a charge), so the expense
// and project rollups go stale alongside the vendor's own `purchaseCount`/`spend`.
export const purchaseMutationInvalidateKeys = [
  queryKeys.purchase.all,
  queryKeys.relatedData.all,
  queryKeys.vendor.all,
  queryKeys.expense.all,
  queryKeys.project.all,
  // Splitting a purchase-owned Expense can change Product quantity/cost basis,
  // which changes effective price and every cached valuation/cost consumer.
  queryKeys.product.all,
  queryKeys.inventory.all,
  queryKeys.location.all,
  queryKeys.recipe.all,
  queryKeys.meal.all,
  queryKeys.problems.all,
  queryKeys.search.all,
  queryKeys.dashboard.counts,
] as const satisfies readonly QueryKey[];

/** Finance entries are settlement evidence only, but changing one refreshes the
 * purchase settlement summary and advisory problems. */
export const financialAccountMutationInvalidateKeys = [
  queryKeys.financialAccount.all,
  queryKeys.financialTransaction.all,
  queryKeys.dashboard.counts,
] as const satisfies readonly QueryKey[];

export const financialTransactionMutationInvalidateKeys = [
  queryKeys.financialTransaction.all,
  queryKeys.financialAccount.all,
  queryKeys.purchase.all,
  queryKeys.problems.all,
  queryKeys.dashboard.counts,
] as const satisfies readonly QueryKey[];

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
