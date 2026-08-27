import type { OperationCacheTag } from "./operation-meta";

/**
 * Tag-space translation of the legacy `invalidationFanout` table.
 *
 * The legacy→tag bridge (`operationTagForQueryRoot`) took `key[0]` and
 * discarded the rest, so `queryKeys.recipe.list` (`["recipe","list"]`) and
 * `queryKeys.recipe.all` (`["recipe"]`) were already the SAME tag. That
 * collapse is why the two-level `queryKeys` tree flattens to a set of entity
 * roots here: every row below is its legacy row with each key mapped to
 * `[key[0]]` and deduped. Refetch-neutral by construction.
 */

/** Dedupe by tag content — tags are fresh arrays rather than the stable
 * references `queryKeys` handed out, so a group spread into a fan-out that
 * already names one of its tags collapses instead of invalidating the same
 * prefix twice. */
const rippleTags = (
  ...groups: readonly (readonly OperationCacheTag[])[]
): readonly OperationCacheTag[] =>
  Object.freeze([
    ...new Map(groups.flat().map((tag) => [tag.join(" "), tag])).values(),
  ]);

/**
 * The surfaces that re-read whenever a product's price, quantity, or shelf
 * moves. Shared by every money- or stock-moving fan-out (expense, purchase,
 * product merge, ingredient merge) rather than re-listed at each.
 */
const costAndStock = rippleTags([
  ["product"],
  ["inventory"],
  ["location"],
  // Cost inputs changed → recipe totals and the meal rollups read off them.
  ["recipe"],
  ["meal"],
  // Rows leave/enter the catalog: stale hits and detector rows both go.
  ["problems"],
  ["search"],
]);

const productBase = rippleTags([
  ["product"],
  ["relatedData"],
  // Task rows embed their subject product's display name. A product rename
  // must not leave the task list/detail cache showing the old name.
  ["task"],
  ["dashboard"],
  ["wish"],
]);

const ingredientAll = rippleTags([["ingredient"], ["dashboard"]]);

/**
 * Per-entity invalidation fan-out. The bare entity name is what an ordinary
 * create/update/delete of that entity invalidates; the compound entries name
 * the writes that move MORE than the entity's own rows and would otherwise
 * leave other views rendering pre-mutation state.
 *
 * Deliberately NOT a blanket invalidation: every tag here costs a refetch
 * against Neon (#887), and `useOptimisticDelete` walks a tag surface to do
 * `setQueriesData` cache surgery — so they must stay real, narrow tag lists
 * rather than a catch-all prefix.
 */
export const ripple = {
  product: productBase,
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
  productMerge: rippleTags(productBase, costAndStock, [
    ["expense"],
    ["project"],
  ]),
  /** A product write that also changed recipe cost inputs → meal rollups
   * (read from `recipe.totals`) go stale with them. */
  productRecipe: rippleTags(productBase, [["recipe"], ["meal"]]),
  /** Price/valuation only — no name change, so no task/wish name echo. */
  productValuation: rippleTags([
    ["product"],
    ["recipe"],
    ["location"],
    ["meal"],
    ["dashboard"],
  ]),
  /** UPC/USDA lookup: identity resolves, detectors and search re-read. */
  productLookup: rippleTags([
    ["product"],
    ["problems"],
    ["search"],
    ["dashboard"],
  ]),
  /** A ProductComponent edge is a Product→Product link, visible from both
   * ends (a kit's own component list, and the transpose kit-membership
   * list). It carries no money of its own — the kit keeps its own Expense —
   * so there's no spend, inventory, or calendar state to invalidate. */
  productComponent: rippleTags([["product"], ["relatedData"]]),

  inventory: rippleTags([
    ["inventory"],
    ["location"],
    ["product"],
    ["problems"],
    ["search"],
    ["dashboard"],
  ]),

  location: rippleTags([["location"], ["dashboard"]]),
  /**
   * Reparenting changes tree SHAPE, so the list prefix is not enough: the
   * detail page's subtree, the arrange forest, and both ends' parent chains
   * all re-read. Nothing here touches stock — no inventory tags.
   *
   * (In tag space this is identical to the `location` row: the legacy rows
   * differed only in `location.list` vs `location.all`, and both collapse to
   * `["location"]`. Kept as its own name so the reparent descriptors stay
   * self-documenting.)
   */
  locationReparent: rippleTags([["location"], ["dashboard"]]),

  // The broad `image` prefix, not an image-list tag: a list-only invalidation
  // doesn't refresh the image DETAIL page after a rename.
  image: rippleTags([["image"], ["dashboard"]]),

  "usda-food": rippleTags([["usda-food"]]),

  /** The broad prefix — list / getByName / getByID all re-read. */
  ingredient: ingredientAll,
  /** List-only, for writes that cannot change an ingredient's identity.
   * (Collapses onto the base row in tag space — see `locationReparent`.) */
  ingredientList: rippleTags([["ingredient"], ["dashboard"]]),
  /** Ingredient↔Product link: visible from both ends. */
  ingredientProduct: rippleTags(ingredientAll, productBase),
  /** Merge re-points recipes, products, and stock at the keeper. */
  ingredientMerge: rippleTags([["ingredient"]], costAndStock, [["dashboard"]]),
  /** Unused-ingredient sweep — resolves the detector card that offered it. */
  ingredientCleanup: rippleTags([["problems"], ["ingredient"], ["dashboard"]]),

  /** Broad prefix + meal rollups, which read recipe totals. */
  recipe: rippleTags([["recipe"], ["meal"], ["dashboard"]]),
  recipeList: rippleTags([["recipe"], ["dashboard"]]),
  /** A recipe moving between cookbooks also moves the browse index. */
  recipeCookbook: rippleTags([["recipe"], ["cookbook"], ["dashboard"]]),

  cookbook: rippleTags([["cookbook"], ["dashboard"]]),
  /** Linking or unlinking a cookbook's physical copy moves data on BOTH
   * detail pages: the cookbook page reads the projected link, and
   * the product page reads the reverse embedded in its own detail payload.
   * Invalidating only the cookbook side leaves a stale "Cookbook" panel on
   * the product. */
  cookbookProductLink: rippleTags([["cookbook"], ["product"]]),

  meal: rippleTags([["meal"], ["calendar"], ["dashboard"]]),

  // Task/expense mutations also invalidate `project`: the dashboard and
  // project rollups (spent/progress) aggregate over them.
  project: rippleTags([
    ["project"],
    ["relatedData"],
    ["calendar"],
    ["dashboard"],
  ]),
  /** A reusable-resource edge is visible from both ends, but it does not
   * change project spend, inventory quantity, or calendar state. */
  projectResource: rippleTags([["project"], ["product"], ["relatedData"]]),

  task: rippleTags([["task"], ["project"], ["calendar"], ["dashboard"]]),

  expense: rippleTags(
    [["expense"], ["relatedData"], ["project"], ["calendar"], ["dashboard"]],
    // An expense can link to a product (cost basis / disposition) — recording
    // one from the product page should refresh that product's hero/stamp too.
    costAndStock,
    // Writing an expense's `vendor`/`orderId` resolves a Vendor and a Purchase
    // into existence, and EVERY expense write moves a charge's `expenseTotal`
    // and its vendor's `spend`/`purchaseCount` — all three are rollups over
    // this table. Without these, a charge's reconciliation cue keeps showing
    // a stale total.
    [["vendor"], ["purchase"]],
  ),

  // A vendor's name is denormalized into `purchaseOut.vendorName`, so a rename
  // has to refresh the charge queries too — otherwise the ledger keeps showing
  // the old name until a hard reload. No expense/project tags: a vendor holds
  // identity only, and every dollar lives on `Expense`.
  vendor: rippleTags([
    ["vendor"],
    ["purchase"],
    ["relatedData"],
    ["dashboard"],
  ]),

  // Purchase mutations move MONEY-bearing rows around (`link` re-parents
  // expenses, `split` replaces one with several, `merge` re-points a charge),
  // so the expense and project rollups go stale alongside the vendor's own
  // `purchaseCount`/`spend`. Splitting a purchase-owned Expense can also
  // change Product quantity/cost basis, hence the ripple.
  purchase: rippleTags(
    [["purchase"], ["relatedData"], ["vendor"], ["expense"], ["project"]],
    costAndStock,
    [["dashboard"]],
  ),
  /** A purchase-product link is visible from both ends, but it carries no
   * money or quantity — no spend, inventory, or calendar state. */
  purchaseProduct: rippleTags([["purchase"], ["product"], ["relatedData"]]),

  /** Finance entries are settlement evidence only, but changing one refreshes
   * the purchase settlement summary and advisory problems. */
  financialAccount: rippleTags([
    ["financialAccount"],
    ["financialTransaction"],
    ["dashboard"],
  ]),
  financialTransaction: rippleTags([
    ["financialTransaction"],
    ["financialAccount"],
    ["purchase"],
    ["problems"],
    ["dashboard"],
  ]),

  wish: rippleTags([["wish"], ["search"], ["dashboard"]]),

  /** Not an entity — the Problems page's own detector cards, resolved by a fix
   * that touched nothing else. */
  problems: rippleTags([["problems"]]),
} as const satisfies Record<string, readonly OperationCacheTag[]>;

/** `entityRipple` hands back the SAME array reference for the same entity, so
 * the result stays safe to pass into a hook dependency array or a memoized
 * config — the contract `invalidatesFor` documented. */
const fallbackRipples = new Map<string, readonly OperationCacheTag[]>();

/**
 * The tags one write on `entity` invalidates. Total by construction: an entity
 * with no row degrades to its own root plus the dashboard counts rather than
 * silently invalidating nothing.
 */
export const entityRipple = (entity: string): readonly OperationCacheTag[] => {
  const declared = ripple[entity as keyof typeof ripple] as
    | readonly OperationCacheTag[]
    | undefined;
  if (declared) return declared;
  const cached = fallbackRipples.get(entity);
  if (cached) return cached;
  const built = rippleTags([[entity], ["dashboard"]]);
  fallbackRipples.set(entity, built);
  return built;
};
