/**
 * Product-centric Problems detectors.
 *
 * Duplicate unique products, orphaned (no-inventory) products, products with no
 * conversion/price coverage, fresh-UPC enrichment candidates, the shared
 * effective-mapping synthesis, plus the coverage data pull, recipe-usage counts,
 * and linked-product-id lookup the service layer composes.
 */

import type {
  IngredientId,
  ProductId,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import {
  unsafeExpenseShortcode,
  unsafeIngredientShortcode,
  unsafeLocationShortcode,
  unsafeProductShortcode,
  unsafeProjectShortcode,
  unsafePurchaseShortcode,
} from "@cubby/schemas/identifiers";
import type {
  DuplicateProductIdentity,
  DuplicateUniqueProduct,
  NegativeExpectedQuantity,
  OrphanedProduct,
  ProductMissingPrice,
  ProductWithBetterUpcData,
  ProductWithoutMappings,
  SoldButStillStocked,
  ToolUsedOutsideOwnership,
  UnlinkedExitExpense,
} from "@cubby/schemas/problems";
import { isMiscProduct, isNonFoodCategory } from "@cubby/shared";
import { format } from "date-fns";
import {
  and,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  notExists,
  type SQL,
  sql,
} from "drizzle-orm";
import { sumBy, uniq } from "es-toolkit";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { toolTimelineConflict, UNKNOWN_OWNERSHIP } from "~/lib/tool-timeline";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import type { Database, DrizzleClient } from "~/server/db";
import {
  expense,
  image,
  ingredient,
  inventoryEntry,
  product,
  productExternalId,
  productImage,
  productUnitMappings,
  project,
  projectToolUsage,
  purchase,
  purchaseProduct,
  recipe,
  recipeSection,
  recipeSectionIngredient,
  task,
  vendor,
  wishCandidate,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { displayableImageWhere } from "~/server/repo/image-displayability";
import { canonicalLabelKey } from "~/server/repo/label-canonical";
import {
  isRetainingEdgeKey,
  PRODUCT_EDGE_ROLES,
  type ProductRetainingEdgeKey,
} from "~/server/repo/product/edge-roles";
import {
  disposalPurchaseIds,
  loadProductOwnershipWindows,
} from "~/server/repo/product/ownership";
import {
  effectiveProductPriceSql,
  loadProductPricing,
} from "~/server/repo/product/pricing";
import { expenseSignedUnitsSql } from "~/server/repo/product/quantity-ledger";
import { loadProjectDateWindows } from "~/server/repo/project/subtree";
import { buildTimelineGates } from "~/server/repo/project/tools";

// ProductWithBetterUpcData is re-exported from the package barrel for the
// Problems-page components that import it from there.
export type { ProductWithBetterUpcData };

type ProductWithUpcGapCandidate = {
  id: ProductId;
  shortcode: ProductShortcode;
  name: string;
  manufacturer: string;
  upc: string;
  price: number | null;
  hasImage: boolean;
};

// Find products with expectedQuantity=1 that appear in multiple locations.
// Named for the `duplicateInventory` Problems key it feeds — not to be
// confused with product/analytics.ts's identically-shaped but independently
// implemented findDuplicateUniqueProducts, which serves the inventory
// router's own (differently-named, self-consistent) duplicate-check surface.
export const findDuplicateInventoryProducts = async (
  db: Database,
): Promise<DuplicateUniqueProduct[]> => {
  const duplicates = await getDb(db).query.product.findMany({
    where: notDeleted(product),
    columns: {
      id: true,
      name: true,
      manufacturer: true,
      shortcode: true,
      expectedQuantity: true,
    },
    with: {
      inventoryEntry: {
        where: notDeleted(inventoryEntry),
        columns: {
          id: true,
          locationId: true,
          placement: true,
        },
        with: {
          location: {
            columns: {
              id: true,
              name: true,
              shortcode: true,
            },
          },
        },
      },
    },
  });

  return duplicates
    .filter((prod) => {
      if (prod.expectedQuantity !== 1) return false;
      // Compare within placement only: a spare on the shelf plus one
      // installed in the wall is the normal correct state for a
      // single-unit product, not a duplicate.
      const stockEntries = prod.inventoryEntry.filter(
        (entry) => entry.placement === "stock",
      );
      const installedEntries = prod.inventoryEntry.filter(
        (entry) => entry.placement === "installed",
      );
      return stockEntries.length > 1 || installedEntries.length > 1;
    })
    .map((prod) => ({
      id: unsafeProductShortcode(prod.shortcode),
      name: prod.name,
      manufacturer: prod.manufacturer,
      expectedQuantity: prod.expectedQuantity,
      locations: prod.inventoryEntry.map((entry) => ({
        id: unsafeLocationShortcode(entry.location.shortcode),
        name: entry.location.name,
      })),
    }));
};

/**
 * Correlated `notExists` builder per retaining edge, keyed off
 * `ProductRetainingEdgeKey` (derived from `PRODUCT_EDGE_ROLES`, see
 * `~/server/repo/product/edge-roles`). `Record` over that type requires an
 * entry for every acquisition/history edge, so adding one to
 * `PRODUCT_EDGE_ROLES` is a compile error here until it's wired up — mirroring
 * `PRODUCT_RETAINING_DEPENDENTS` in `product/crud.ts`'s `deleteProducts`,
 * which reads the same map to build a different shape (`inArray` fetch +
 * `assertNoDependents`) over the same retaining edges. That's the guarantee this
 * file replaces a prose "must agree on both" comment with: the *set* of
 * edges can't drift between the two consumers, even though their SQL does.
 *
 * Each builder stays a literal `.from(<table>)` (not a generic `column.table`
 * walk) on purpose — `scripts/check-soft-delete-filters.mjs` matches incoming
 * edges by literal table identifier, so a fully-generic loop here would be
 * invisible to that guard.
 */
const PRODUCT_RETAINING_NOT_EXISTS: Record<
  ProductRetainingEdgeKey,
  (dbClient: DrizzleClient) => SQL
> = {
  "InventoryEntry.productId": (dbClient) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(inventoryEntry)
        .where(
          and(
            eq(inventoryEntry.productId, product.id),
            notDeleted(inventoryEntry),
          ),
        ),
    ),
  // Unlike the `productIdsWithExpenses` subquery in product/crud.ts, this
  // needs no `isNotNull(expense.productId)`: that one is an uncorrelated
  // NOT IN list, where a single NULL makes the whole predicate UNKNOWN. A
  // correlated `eq` simply never matches NULL.
  "Expense.productId": (dbClient) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(expense)
        .where(and(eq(expense.productId, product.id), notDeleted(expense))),
    ),
  "Task.subjectProductId": (dbClient) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(task)
        .where(and(eq(task.subjectProductId, product.id), notDeleted(task))),
    ),
  "ProjectToolUsage.productId": (dbClient) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(projectToolUsage)
        .where(
          and(
            eq(projectToolUsage.productId, product.id),
            notDeleted(projectToolUsage),
          ),
        ),
    ),
  "PurchaseProduct.productId": (dbClient) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(purchaseProduct)
        .where(
          and(
            eq(purchaseProduct.productId, product.id),
            notDeleted(purchaseProduct),
          ),
        ),
    ),
  "WishCandidate.productId": (dbClient) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(wishCandidate)
        .where(
          and(
            eq(wishCandidate.productId, product.id),
            notDeleted(wishCandidate),
          ),
        ),
    ),
};

// Find products nothing meaningful points at — no live inventory, expense,
// task subject, or ingredient link. This drives a one-click Delete on the
// Problems page, so a false positive here is executable data loss, not noise.
//
// Two distinct traps, both of which this predicate got wrong at some point:
//
//  1. *Liveness* — the `notDeleted(...)` inside each subquery is load-bearing:
//     a soft-deleted row still satisfies EXISTS, so a product whose inventory
//     was deleted (rather than never created) stays invisible — the common
//     case, since emptying a shelf soft-deletes instead of removing. That blind
//     spot hid 18 of the 20 genuinely-uninventoried products.
//
//  2. *Completeness* — Product has several incoming FK edges, and checking only
//     some of them yields a confident wrong answer. Omitting `expense` made 32
//     of 40 flagged "orphans" false positives: a tool that was bought, logged in
//     the ledger, and later sold looks exactly like one that was never real.
//     Note the soft-delete guard script can catch (1) but by construction cannot
//     catch (2) — a missing subquery is invisible to it.
//
// Inventory/expenses prove acquisition; a task subject proves the product is
// still part of a useful work history. Those disqualify it. Metadata edges
// (productExternalId, productUnitMappings, productImage) deliberately don't:
// an ASIN or a conversion says nothing about whether the thing was ever owned.
export const findOrphanedProducts = async (
  db: Database,
): Promise<OrphanedProduct[]> => {
  const dbClient = getDb(db);

  const orphaned = await dbClient
    .select({
      id: product.id,
      name: product.name,
      manufacturer: product.manufacturer,
      shortcode: product.shortcode,
      createdAt: product.createdAt,
    })
    .from(product)
    .where(
      and(
        notDeleted(product),
        isNull(product.ingredientId),
        // Allowlist, not `!== "metadata"`: the roles are shared vocabulary now,
        // so excluding one role would silently promote every *other* new role
        // (e.g. `media`, which `ProductImage.productId` carries) into a
        // retaining edge and stop this detector reporting any product with a
        // photo. See `isRetainingEdgeKey`'s file doc.
        ...(
          Object.keys(PRODUCT_EDGE_ROLES) as Array<
            keyof typeof PRODUCT_EDGE_ROLES
          >
        )
          .filter(isRetainingEdgeKey)
          .map((key) => PRODUCT_RETAINING_NOT_EXISTS[key](dbClient)),
      ),
    );

  return orphaned.map((row) => ({
    ...row,
    id: unsafeProductShortcode(row.shortcode),
  }));
};

// Find stocked products with no `price`.
//
// `inventoryEntry.valuation` is precomputed from Product effective price,
// so a null price yields a null valuation and the location rollup silently
// omits the item. Keyed off effective price (the cause) rather than
// `inventoryEntry.valuation` (the symptom, which can lag a recompute).
//
// Returned partitioned, not as one list: a `misc:` bucket is a heterogeneous
// pile with no meaningful unit price and is *expected* to be unpriced — the
// per-location summary already treats those as `miscNoPrice` rather than
// `missingPricing`. Folding them in would leave the section permanently red.
export const findProductsMissingPrice = async (
  db: Database,
): Promise<{
  real: ProductMissingPrice[];
  buckets: ProductMissingPrice[];
}> => {
  const dbClient = getDb(db);

  // includes-installed: a fixture still needs a price — pricing/enrichment
  // scope, not a browse/count surface.
  const stockedWithoutPrice = await dbClient.query.product.findMany({
    where: and(
      notDeleted(product),
      sql.raw(`${effectiveProductPriceSql()} IS NULL`),
    ),
    columns: { id: true, name: true, manufacturer: true, shortcode: true },
    with: {
      inventoryEntry: {
        where: notDeleted(inventoryEntry),
        columns: { id: true, amount: true },
        with: {
          location: { columns: { id: true, name: true, shortcode: true } },
        },
      },
    },
  });

  const real: ProductMissingPrice[] = [];
  const buckets: ProductMissingPrice[] = [];

  for (const prod of stockedWithoutPrice) {
    // Products with no live inventory contribute nothing to any rollup, so an
    // absent price costs nothing — `findOrphanedProducts` already covers them.
    if (prod.inventoryEntry.length === 0) continue;

    const item: ProductMissingPrice = {
      id: unsafeProductShortcode(prod.shortcode),
      name: prod.name,
      manufacturer: prod.manufacturer,
      inventoryQuantity: sumBy(
        prod.inventoryEntry,
        (entry) => entry.amount.value,
      ),
      locations: prod.inventoryEntry.map((entry) => ({
        id: unsafeLocationShortcode(entry.location.shortcode),
        name: entry.location.name,
      })),
    };

    if (isMiscProduct(prod.name)) {
      buckets.push(item);
    } else {
      real.push(item);
    }
  }

  return { real, buckets };
};

// Find products whose ledger says more units left than ever arrived.
//
// You cannot sell, return, or throw away something you never acquired, so a
// negative expected quantity is a contradiction rather than a shortfall —
// something is missing or mis-entered, and there is a specific row to go fix.
//
// The predicate is deliberately LOOSER than `findSoldButStillStocked` below,
// which keys on disposal Purchases. That is not an inconsistency: the two ask
// different questions. "Was this sold off entirely?" treats a refund as
// innocent noise, which on live data it usually is. "Do the units balance?"
// treats a return of 8 outlet boxes as 8 real units going back to the store —
// and 218 of the 335 negative lines in this ledger are exactly that, sitting
// inside a Purchase that nets positive. Requiring a disposal Purchase here
// would miss 348 of the 492 exited units.
//
// The unknown-quantity counts ride along because they change what the row
// means. A product with unquantified acquisition lines is data-entry debt (the
// missing count almost certainly explains the gap); one with a fully
// quantified ledger is a genuine contradiction. Reporting the bare number would
// flatten those into the same red row.
export const findProductsWithNegativeExpectedQuantity = async (
  db: Database,
): Promise<NegativeExpectedQuantity[]> => {
  const dbClient = getDb(db);
  const signedUnits = sql.raw(expenseSignedUnitsSql('"Expense"'));

  const rows = await dbClient
    .select({
      productId: expense.productId,
      acquiredUnits: sql<number>`COALESCE(sum(GREATEST(${signedUnits}, 0)), 0)::int`,
      exitedUnits: sql<number>`COALESCE(sum(-LEAST(${signedUnits}, 0)), 0)::int`,
      unknownAcquisitionLines: sql<number>`count(*) FILTER (WHERE ${expense.productQuantity} IS NULL AND (${expense.cost} IS NULL OR ${expense.cost} >= 0))::int`,
      unknownExitLines: sql<number>`count(*) FILTER (WHERE ${expense.productQuantity} IS NULL AND ${expense.cost} < 0)::int`,
    })
    .from(expense)
    .where(
      and(
        notDeleted(expense),
        eq(expense.future, false),
        isNotNull(expense.productId),
      ),
    )
    .groupBy(expense.productId)
    .having(sql`COALESCE(sum(${signedUnits}), 0) < 0`);

  if (rows.length === 0) return [];

  const products = await dbClient.query.product.findMany({
    where: and(
      notDeleted(product),
      inArray(
        product.id,
        rows.flatMap((row) => (row.productId ? [row.productId] : [])),
      ),
    ),
    columns: { id: true, name: true, manufacturer: true, shortcode: true },
  });
  const byId = new Map(products.map((prod) => [prod.id, prod]));

  return rows.flatMap((row) => {
    // A soft-deleted product is not a live defect: nothing points at it, and
    // there is no row left worth going to correct.
    const prod = row.productId ? byId.get(row.productId) : undefined;
    if (!prod) return [];
    const acquiredUnits = Number(row.acquiredUnits);
    const exitedUnits = Number(row.exitedUnits);
    return [
      {
        id: unsafeProductShortcode(prod.shortcode),
        name: prod.name,
        manufacturer: prod.manufacturer,
        expectedQuantity: acquiredUnits - exitedUnits,
        acquiredUnits,
        exitedUnits,
        unknownAcquisitionLines: Number(row.unknownAcquisitionLines),
        unknownExitLines: Number(row.unknownExitLines),
      },
    ];
  });
};

// Find disposal lines that name no product — the exact inverse of
// `findSoldButStillStocked` below.
//
// That detector groups by `expense.productId`, so a sale with a null one is
// invisible to it BY CONSTRUCTION rather than by oversight. Those are the norm
// for marketplace sales: the row arrives from a statement or a payout export
// with a description and an amount and nothing tying it to a shelf, so the
// ledger records that money came in and cannot say what left.
//
// The predicate is the same disposal-Purchase test its mirror uses, and the
// reasoning behind that choice is the essay above `findSoldButStillStocked` —
// worth reading rather than restating here. The short version: bare negative
// Expense lines are overwhelmingly refunds, price adjustments, and family
// contributions, and keying on them instead was wrong about half the time on
// production data.
export const findUnlinkedExitExpenses = async (
  db: Database,
): Promise<UnlinkedExitExpense[]> => {
  const dbClient = getDb(db);

  const rows = await dbClient
    .select({
      shortcode: expense.shortcode,
      name: expense.name,
      cost: expense.cost,
      date: expense.date,
      purchaseShortcode: purchase.shortcode,
      vendorName: vendor.name,
    })
    .from(expense)
    .innerJoin(
      purchase,
      and(eq(purchase.id, expense.purchaseId), notDeleted(purchase)),
    )
    .leftJoin(vendor, and(eq(vendor.id, purchase.vendorId), notDeleted(vendor)))
    .where(
      and(
        notDeleted(expense),
        eq(expense.future, false),
        lt(expense.cost, 0),
        isNull(expense.productId),
        inArray(expense.purchaseId, disposalPurchaseIds(dbClient)),
      ),
    )
    .orderBy(sql`${expense.date} DESC NULLS LAST`);

  return rows.map((row) => ({
    id: unsafeExpenseShortcode(row.shortcode),
    name: row.name,
    cost: Number(row.cost),
    date: row.date,
    purchaseId: unsafePurchaseShortcode(row.purchaseShortcode),
    vendorName: row.vendorName,
  }));
};

// Find products that were sold off but are still sitting on a shelf.
//
// The exact mirror of `findProductsMissingPrice`, and it exists for the same
// reason: `inventoryEntry.valuation` is precomputed from the product's
// effective price, so a stale entry keeps contributing its full value to the
// location rollup. An unpriced product makes the rollup silently *omit* value;
// this one makes it silently *invent* value.
//
// Nothing else can catch this. Inventory never auto-decrements (a binding
// tenet), so no write path walks the shelf back when a disposal is recorded —
// the divergence is invisible by construction, and detection is the only
// mechanism left. `findOrphanedProducts` deliberately cannot help: it treats
// `expense` as a *retaining* edge precisely so a bought-then-sold tool is not
// reported as an orphan (see the note above it), which is exactly what blinds
// it here.
//
// Two predicate choices carry the correctness, both learned from live data:
//
//  1. *Disposal Purchases, not negative lines.* A disposal is modelled as a
//     Purchase whose Expenses are negative — the shape documented on
//     `purchaseSettlementKinds`. Negative Expense lines on their own are
//     common and mostly innocent (refunds, price adjustments, family
//     contributions), and the looser predicate was wrong about half the time
//     on production: 43 products matched, only 20 were genuine disposals.
//
//  2. *Fully disposed, not merely touched.* Selling 4 of 14 parts bins leaves
//     10 legitimately stocked, so a row is reported only when the sold
//     quantity accounts for everything still on the shelf. Both quantities
//     ride along on the row so a partial sale reads as deliberate.
//
//  3. *The exit has to be the last word.* `Expense.productId`'s doc note puts
//     it plainly: ownership is an *interval* derived from these rows plus
//     inventory. A tool sold and later re-bought keeps its disposal row
//     forever, so without comparing the last exit against the last
//     acquisition the fresh shelf entry reads as the stale one.
//
// The window's acquisition side is deliberately loose: any positive
// product-linked line reopens it, so a positive price adjustment dated after a
// real disposal would suppress a detection. That is the mirror of the cost-0
// gap below and errs the same safe way (under-report on a list a human
// reviews). Tightening it symmetrically — requiring the acquisition to sit on
// a net-positive Purchase — is *worse*, not better: two live acquisitions
// carry no purchase at all, so they would stop reopening the window and turn a
// rare false negative into a false positive. Excluding only the positive lines
// that sit inside a disposal Purchase is sound but changes nothing: zero of
// them postdate their product's last exit.
//
// Cost-0 exits used to be an outright blind spot here: a broken or gifted item
// is recorded at cost 0, and cost 0 is also how a free promotional
// *acquisition* is recorded (the Harbor Freight bucket, the M12 promo pack), so
// the two were indistinguishable and `cost <= 0` would have flagged every
// freebie as sold. `Expense.productQuantity` is now **signed**, which is the
// real signal on the row that resolves it: a $0 discard carries a negative
// quantity, a $0 freebie a positive one.
//
// This detector still keys on disposal Purchases anyway, and that is not an
// oversight. A discard minted through the Discard action carries no
// `purchaseId` at all and clears its own inventory in the same transaction, so
// it cannot produce a sold-but-still-stocked row in the first place. Widening
// the exit predicate to
// `or(inArray(purchaseId, disposalPurchaseIds), and(eq(cost, 0), lt(productQuantity, 0)))`
// would only catch a hand-entered $0 discard whose shelf was left behind —
// coherent, and a reasonable follow-on, but a different question from the one
// this detector answers today.
export const findSoldButStillStocked = async (
  db: Database,
): Promise<SoldButStillStocked[]> => {
  const dbClient = getDb(db);

  const disposals = await dbClient
    .select({
      productId: expense.productId,
      // A bare sale row carries no `productQuantity`; read it as one unit, the
      // same way the ledger itself reads it.
      //
      // `abs`, because this query is filtered to `cost < 0` where the ledger
      // reads an exit as `−|qty|` and therefore leaves BOTH signs legal — 302
      // live rows store a positive quantity there, a hand-entered one may store
      // a negative. Without it a negative row makes `soldQuantity` negative,
      // which both fails the `soldQuantity < liveQuantity` comparison below
      // (a silent false negative) and renders a negative "sold" count in the
      // UI. `abs(NULL)` is `NULL`, so the coalesce default still applies.
      soldQuantity: sql<number>`sum(coalesce(abs(${expense.productQuantity}), 1))::double precision`,
      proceeds: sql<number>`sum(${expense.cost})::double precision`,
      // Closes the ownership window (see below). `date` is a `mode: "string"`
      // column, so ISO strings order correctly without parsing.
      lastExitAt: sql<string>`max(${expense.date})`,
    })
    .from(expense)
    .where(
      and(
        notDeleted(expense),
        eq(expense.future, false),
        lt(expense.cost, 0),
        isNotNull(expense.productId),
        inArray(expense.purchaseId, disposalPurchaseIds(dbClient)),
      ),
    )
    .groupBy(expense.productId);

  const byProduct = new Map(
    disposals.flatMap((row) =>
      row.productId ? ([[row.productId, row]] as const) : [],
    ),
  );
  if (byProduct.size === 0) return [];

  // Close the ownership window. `Expense.productId`'s own doc note is explicit
  // that "net cost, ownership window and owned/sold status are derived from
  // these rows plus inventory; nothing is stored" — so an exit only means the
  // shelf is stale if nothing was acquired *after* it. Sell a tool and re-buy
  // it later and the disposal row never goes away, so without this the fresh
  // shelf entry reads as the stale one.
  const acquisitions = await dbClient
    .select({
      productId: expense.productId,
      lastAcquiredAt: sql<string>`max(${expense.date})`,
    })
    .from(expense)
    .where(
      and(
        notDeleted(expense),
        eq(expense.future, false),
        gt(expense.cost, 0),
        inArray(expense.productId, [...byProduct.keys()]),
      ),
    )
    .groupBy(expense.productId);

  const lastAcquiredAt = new Map(
    acquisitions.flatMap((row) =>
      row.productId ? ([[row.productId, row.lastAcquiredAt]] as const) : [],
    ),
  );

  // includes-installed: sold-but-still-stocked is an ownership/identity
  // question — a fixture the ledger says was sold is exactly as wrong as a
  // shelf item, and should still surface here.
  const candidates = await dbClient.query.product.findMany({
    where: and(notDeleted(product), inArray(product.id, [...byProduct.keys()])),
    columns: { id: true, name: true, manufacturer: true, shortcode: true },
    with: {
      inventoryEntry: {
        where: notDeleted(inventoryEntry),
        columns: { id: true, amount: true },
        with: {
          location: { columns: { id: true, name: true, shortcode: true } },
        },
      },
    },
  });

  const rows: SoldButStillStocked[] = [];

  for (const prod of candidates) {
    const disposal = byProduct.get(prod.id);
    if (!disposal) continue;

    const liveQuantity = sumBy(
      prod.inventoryEntry,
      (entry) => entry.amount.value,
    );

    // Nothing on a shelf — the ledger and the inventory already agree, which is
    // the normal end state after a sale.
    if (liveQuantity <= 0) continue;
    // A partial sale leaves real stock behind; only a fully-accounted-for
    // disposal means the remaining entry is stale.
    if (disposal.soldQuantity < liveQuantity) continue;
    // Re-acquired after the last exit, so the shelf entry is a fresh purchase
    // rather than a leftover. Ties keep the row: a same-day sell-and-rebuy is
    // not distinguishable at date granularity, and reporting it is the safer
    // side of an ambiguity a human resolves anyway.
    const acquiredAt = lastAcquiredAt.get(prod.id);
    if (acquiredAt && acquiredAt > disposal.lastExitAt) continue;

    rows.push({
      id: unsafeProductShortcode(prod.shortcode),
      name: prod.name,
      manufacturer: prod.manufacturer,
      soldQuantity: disposal.soldQuantity,
      liveQuantity,
      proceeds: disposal.proceeds,
      locations: prod.inventoryEntry.map((entry) => ({
        id: unsafeLocationShortcode(entry.location.shortcode),
        name: entry.location.name,
      })),
    });
  }

  return rows;
};

/**
 * Recorded tool→project uses that the ownership timeline says are impossible.
 *
 * The `trade_match` suggestion lane shipped without consulting ownership dates,
 * so an old project's candidate pool was the present-day tool shelf. Every read
 * and write path now applies `toolTimelineConflict`; this reports the edges
 * that predate that gate (four on production, all on one renovation whose
 * explicit end date is a year before the tools were bought).
 *
 * Uses the exact same inputs as the gate — same fold, same ownership loader,
 * same predicate — so a row here is a row the UI would refuse to create today.
 */
export const findToolsUsedOutsideOwnership = async (
  db: Database,
  options: { today?: string } = {},
): Promise<ToolUsedOutsideOwnership[]> => {
  const dbClient = getDb(db);
  const today = options.today ?? format(new Date(), "yyyy-MM-dd");

  const edges = await dbClient
    .select({
      projectId: projectToolUsage.projectId,
      projectShortcode: project.shortcode,
      projectName: project.name,
      productId: projectToolUsage.productId,
      productShortcode: product.shortcode,
      productName: product.name,
      manufacturer: product.manufacturer,
    })
    .from(projectToolUsage)
    .innerJoin(
      project,
      and(eq(project.id, projectToolUsage.projectId), notDeleted(project)),
    )
    .innerJoin(
      product,
      and(eq(product.id, projectToolUsage.productId), notDeleted(product)),
    )
    .where(notDeleted(projectToolUsage));
  if (edges.length === 0) return [];

  const [loadedWindows, ownership] = await Promise.all([
    loadProjectDateWindows(db),
    loadProductOwnershipWindows(
      dbClient,
      uniq(edges.map((edge) => edge.productId)),
    ),
  ]);
  const gates = buildTimelineGates(
    loadedWindows,
    uniq(edges.map((edge) => edge.projectId)),
  );

  const rows: ToolUsedOutsideOwnership[] = [];
  for (const edge of edges) {
    const gate = gates.get(edge.projectId);
    if (!gate) continue;
    const conflict = toolTimelineConflict(
      ownership.get(edge.productId) ?? UNKNOWN_OWNERSHIP,
      gate.window,
      { isLive: gate.isLive, today },
    );
    if (!conflict) continue;
    rows.push({
      id: unsafeProductShortcode(edge.productShortcode),
      name: edge.productName,
      manufacturer: edge.manufacturer,
      projectId: unsafeProjectShortcode(edge.projectShortcode),
      projectName: edge.projectName,
      conflict: conflict.kind,
      toolDate: conflict.date,
      projectBoundary: conflict.boundary,
    });
  }
  return rows.sort(
    (a, b) =>
      a.projectName.localeCompare(b.projectName) ||
      a.name.localeCompare(b.name),
  );
};

// Two Product rows for one physical SKU — the thing `mergeProducts` exists to
// fix. Nothing on the write path can prevent it: `Product_name_manufacturer_key`
// only stops an EXACT repeat, and two retailer importers naturally spell the
// same item differently ("DeWalt DCD791D2" vs "DEWALT 20V MAX XR Drill Kit").
//
// **The signal is `(manufacturer, model)` with external ids from different
// sources**, and the reason it is worth encoding rather than guessing is that
// it was measured on the live 2,472-product catalog: it found all 5 real
// duplicates with ~6 false positives, and every false positive was a legitimate
// variant that a distinct identifier separates. Two rows carrying the same maker
// part number, entered from two different retailers, are one thing.
//
// **Trigram name similarity was near-useless here and must not be re-tried.**
// The same measurement that validated the model key rejected the fuzzy one:
// product names are dominated by size/colour/pack variants ("... 4.5in", "...
// 2-Pack", "... Blue"), so the score tracks the shared product family rather
// than the part that distinguishes two rows — exactly the failure
// `detectors-label-variants.ts` records for vendor names, one level down. A
// model number is an exact key; use it.
//
// The false-positive class is suppressed with positive evidence of distinctness,
// never with a similarity threshold:
//
//  1. *Distinct UPCs.* Two live rows can't share a UPC (`Product_upc_key`), so
//     two non-null differing UPCs mean two different retail packages.
//  2. *Distinct retailer SKU.* Both rows filling the SAME (source, kind)
//     identifier slot with different values is the retailer itself saying they
//     are two products. (They cannot fill it with the same value — the global
//     `(source, kind, externalId)` unique index forbids it — so a shared slot is
//     always evidence of difference, never of sameness.)
//
// Suppression is per GROUP, not per pair: one distinguishable member is enough
// to make the whole cluster a variant family rather than a duplicate, which is
// the conservative direction for a list a human acts on with a destructive
// merge.
export const findDuplicateProductIdentities = async (
  db: Database,
): Promise<DuplicateProductIdentity[]> => {
  const dbClient = getDb(db);

  const rows = await dbClient
    .select({
      id: product.id,
      shortcode: product.shortcode,
      name: product.name,
      manufacturer: product.manufacturer,
      model: product.model,
      upc: product.upc,
      // The SAME canonical key `findManufacturerSpellingVariants` and
      // `resolveEstablishedManufacturer` use, so `Ryobi`/`RYOBI` can't split a
      // real duplicate apart before this detector can group it.
      manufacturerKey: sql<string>`${canonicalLabelKey(product.manufacturer)}`,
    })
    .from(product)
    .where(and(notDeleted(product), isNotNull(product.model)));

  const candidates = rows.filter(
    (row): row is typeof row & { model: string } =>
      row.model != null &&
      row.model.trim() !== "" &&
      !isUnspecifiedManufacturer(row.manufacturer) &&
      !isMiscProduct(row.name),
  );
  if (candidates.length === 0) return [];

  const identifiers = await dbClient
    .select({
      productId: productExternalId.productId,
      source: productExternalId.source,
      kind: productExternalId.kind,
      externalId: productExternalId.externalId,
    })
    .from(productExternalId)
    .where(
      and(
        inArray(
          productExternalId.productId,
          candidates.map((row) => row.id),
        ),
        notDeleted(productExternalId),
      ),
    );

  const byProduct = new Map<
    string,
    Array<{ source: string; kind: string; externalId: string }>
  >();
  for (const row of identifiers) {
    const list = byProduct.get(row.productId) ?? [];
    list.push(row);
    byProduct.set(row.productId, list);
  }

  // Model is an exact identifier, so only case and surrounding whitespace are
  // normalized away; the manufacturer half of the key was canonicalized in SQL.
  const groups = new Map<string, typeof candidates>();
  for (const row of candidates) {
    const key = `${row.manufacturerKey}\u0000${row.model.trim().toLowerCase()}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const out: DuplicateProductIdentity[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;

    // "External ids from different sources": at least two members carry
    // identifiers at all, and between them they name more than one source.
    const withIds = group.filter(
      (row) => (byProduct.get(row.id) ?? []).length > 0,
    );
    if (withIds.length < 2) continue;
    const sources = uniq(
      withIds.flatMap((row) =>
        (byProduct.get(row.id) ?? []).map((id) => id.source),
      ),
    );
    if (sources.length < 2) continue;

    // Positive evidence of distinctness — see the two rules above.
    const upcs = uniq(group.flatMap((row) => (row.upc ? [row.upc] : [])));
    if (upcs.length > 1) continue;
    const bySlot = new Map<string, Set<string>>();
    for (const row of group) {
      for (const id of byProduct.get(row.id) ?? []) {
        const slot = `${id.source}\u0000${id.kind}`;
        const values = bySlot.get(slot) ?? new Set<string>();
        values.add(id.externalId);
        bySlot.set(slot, values);
      }
    }
    if ([...bySlot.values()].some((values) => values.size > 1)) continue;

    out.push({
      manufacturer: group[0]!.manufacturer,
      model: group[0]!.model,
      products: group.map((row) => ({
        id: unsafeProductShortcode(row.shortcode),
        name: row.name,
        upc: row.upc,
        sources: uniq(
          (byProduct.get(row.id) ?? []).map((id) => id.source),
        ).sort(),
      })),
    });
  }

  return out;
};

// Find products with no conversion/price coverage at all. A product is covered
// if it has a manual unit mapping OR a price (synthesizes a `1 each = $price`
// edge) OR a USDA link (fdc_id/upc synthesizes portion/serving/nutrient
// edges). Mirrors the totals-gap classifier in lib/recipe-totals-gaps.ts.
// Excludes misc products (don't need pricing) and non-food (household/garage)
// products, for which food unit coverage is meaningless.
export const findProductsWithoutMappings = async (
  db: Database,
): Promise<ProductWithoutMappings[]> => {
  const dbClient = getDb(db);

  const productsWithoutMappings = await dbClient
    .select({
      id: product.id,
      name: product.name,
      manufacturer: product.manufacturer,
      shortcode: product.shortcode,
      createdAt: product.createdAt,
      ingredientId: product.ingredientId,
      // Through a LEFT JOIN (not the FK column) — the linked ingredient's own
      // shortcode, so a null just means "no ingredient linked", matching the
      // nullability of `ingredientId` itself.
      ingredientShortcode: ingredient.shortcode,
      usdaUnavailable: product.usdaUnavailable,
      category: product.category,
    })
    .from(product)
    .leftJoin(
      ingredient,
      and(eq(ingredient.id, product.ingredientId), notDeleted(ingredient)),
    )
    .where(
      and(
        notDeleted(product),
        sql.raw(`${effectiveProductPriceSql('"Product"')} IS NULL`),
        isNull(product.fdc_id),
        isNull(product.upc),
        notExists(
          dbClient
            .select({ id: sql`1` })
            .from(productUnitMappings)
            .where(
              and(
                eq(productUnitMappings.productId, product.id),
                notDeleted(productUnitMappings),
              ),
            ),
        ),
      ),
    );

  return productsWithoutMappings
    .filter((p) => !isMiscProduct(p.name) && !isNonFoodCategory(p.category))
    .map(
      ({
        ingredientId,
        ingredientShortcode,
        usdaUnavailable,
        category: _category,
        shortcode,
        ...rest
      }) => ({
        ...rest,
        id: unsafeProductShortcode(shortcode),
        isIngredient: ingredientId != null,
        usdaUnavailable: usdaUnavailable ?? false,
        ingredientId:
          ingredientShortcode != null
            ? unsafeIngredientShortcode(ingredientShortcode)
            : null,
      }),
    );
};

// Synthesize a product's *effective* conversion edges (stored mappings + price
// edge + USDA portion/serving/nutrient edges) — the same set the conversion
// graph and costing engine use. Returns null (after logging) when the WASM
// synthesis throws, so callers can skip the product instead of failing the scan.
export const synthesizeEffectiveMappings = (
  p: { name: string } & Parameters<typeof getAllUnitMappingsFromProduct>[0],
): ReturnType<typeof getAllUnitMappingsFromProduct> | null => {
  try {
    return getAllUnitMappingsFromProduct(p);
  } catch (error) {
    console.error(
      `Failed to synthesize mappings for product ${p.id} (${p.name}):`,
      error,
    );
    return null;
  }
};

// ProductWithBetterUpcData (productWithBetterUpcDataSchema): a product whose
// stored UPC-sourced fields have a gap (no manufacturer, price, or image) that a
// *fresh* UPC lookup could fill. `proposed` carries the value the live lookup
// would write per field (null ⇒ no change), so the panel can show the actual
// before→after, not just which fields are missing.

// DB-only prefilter for ProductWithBetterUpcData. The service layer owns the UPC
// client call and proposed-value construction; the repo layer only identifies
// products with stored UPC-sourced gaps that are worth looking up.
export const findProductsWithUpcGaps = async (
  db: Database,
): Promise<ProductWithUpcGapCandidate[]> => {
  const dbClient = getDb(db);

  const rows = await dbClient
    .select({
      id: product.id,
      shortcode: product.shortcode,
      name: product.name,
      manufacturer: product.manufacturer,
      upc: product.upc,
      price: product.price,
      // Must agree with `productIdsWithImages` in product/crud.ts, and with
      // findProductsWithNoImages in product/analytics.ts: Image is separately
      // soft-deletable from ProductImage, and a PDF is a manual, not a photo.
      // Checking ProductImage alone reads `true` for a product whose only
      // attachment is a PDF, which then gets filtered out of the candidate list
      // below and never gets the UPC lookup that would fetch it a real photo —
      // hitting tools and hardware hardest.
      hasImage: exists(
        dbClient
          .select({ id: sql`1` })
          .from(productImage)
          .innerJoin(
            image,
            and(eq(image.id, productImage.imageId), notDeleted(image)),
          )
          .where(
            and(
              eq(productImage.productId, product.id),
              notDeleted(productImage),
              displayableImageWhere,
            ),
          ),
      ),
    })
    .from(product)
    .where(and(notDeleted(product), isNotNull(product.upc)));

  // No-network candidate filter: only gappy, non-misc products need a lookup.
  const candidates = rows.filter(
    (r): r is typeof r & { upc: string } =>
      r.upc != null &&
      !isMiscProduct(r.name) &&
      (isUnspecifiedManufacturer(r.manufacturer) ||
        r.price == null ||
        !r.hasImage),
  );

  return candidates.map((candidate) => ({
    ...candidate,
    shortcode: unsafeProductShortcode(candidate.shortcode),
    hasImage: Boolean(candidate.hasImage),
  }));
};

// Distinct non-deleted recipes each product feeds into, via its linked
// ingredient (product → ingredient → recipeSectionIngredient → recipe). A
// prioritization signal for the Problems page: a data gap on a product used in
// 12 recipes matters more than one used in none. Only products that HAVE an
// ingredient are returned (with a count that may be 0); non-food products are
// omitted, so the card can tell "0 recipes" apart from "no ingredient link".
export const recipeUsageCountsByProduct = async (
  db: Database,
  productShortcodes: string[],
): Promise<Record<string, number>> => {
  if (productShortcodes.length === 0) return {};

  const rows = await getDb(db)
    .select({
      shortcode: product.shortcode,
      count: sql<number>`count(distinct ${recipe.id})`,
    })
    .from(product)
    .leftJoin(
      recipeSectionIngredient,
      and(
        eq(recipeSectionIngredient.ingredientId, product.ingredientId),
        notDeleted(recipeSectionIngredient),
      ),
    )
    .leftJoin(
      recipeSection,
      and(
        eq(recipeSection.id, recipeSectionIngredient.recipeSectionId),
        notDeleted(recipeSection),
      ),
    )
    .leftJoin(
      recipe,
      and(eq(recipe.id, recipeSection.recipeId), notDeleted(recipe)),
    )
    .where(
      and(
        notDeleted(product),
        isNotNull(product.ingredientId),
        inArray(product.shortcode, productShortcodes),
      ),
    )
    .groupBy(product.shortcode);

  return Object.fromEntries(rows.map((r) => [r.shortcode, Number(r.count)]));
};

// DB pull shared by BOTH coverage detectors (partial-coverage + islanding):
// every non-deleted product with its stored mappings, the fields needed to
// synthesize derived edges (USDA link + price), and the linked ingredient's
// naKinds. A superset of both detectors' needs, so the service can run one scan,
// one USDA enrichment, and one effective-mapping synthesis per product instead
// of doing all of it twice (the perf win behind the always-on navbar badge).
// The coverage grading (USDA enrichment, synthesis, conversionCoverage,
// islanding) all lives in the service.
// Carries `shortcode` (product) and `ingredient.shortcode` — needed by the
// service layer to populate `IngredientWithPartialCoverage.shortcode`/
// `ingredientShortcode` and `ProductWithIslandedMappings.shortcode` (see
// problems.service.ts's `findProductCoverageProblems`, which owns assembling
// those rows and currently omits both fields from its push()es).
export const loadProductsForCoverage = async (db: Database) => {
  const rows = await getDb(db).query.product.findMany({
    where: notDeleted(product),
    columns: {
      id: true,
      name: true,
      manufacturer: true,
      shortcode: true,
      upc: true,
      fdc_id: true,
      price: true,
      usdaUnavailable: true,
      ingredientId: true,
      category: true,
    },
    with: {
      unitMappings: {
        where: notDeleted(productUnitMappings),
        columns: { a: true, b: true, source: true },
      },
      // The linked ingredient's N/A opt-outs, so partial coverage grades only the
      // kinds that apply (a count-only item isn't flagged for a volume it never uses).
      ingredient: { columns: { naKinds: true, shortcode: true } },
    },
  });
  const pricing = await loadProductPricing(db, rows);
  return rows.map((row) => ({
    ...row,
    price: pricing.get(row.id)?.effectivePrice ?? null,
  }));
};

// Ids of an ingredient's non-deleted, linked products. Used by the
// deleteUnusedIngredients orchestrator to delete those products first so the
// ingredient delete's linked-product guard passes.
export const findLinkedProductIds = async (
  db: Database,
  ingredientId: IngredientId,
): Promise<ProductId[]> => {
  const linked = await getDb(db).query.product.findMany({
    where: and(eq(product.ingredientId, ingredientId), notDeleted(product)),
    columns: { id: true },
  });
  return linked.map((p) => p.id);
};
