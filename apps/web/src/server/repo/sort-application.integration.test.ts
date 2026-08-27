import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Entity } from "@cubby/schemas/entity";
import { entitySchema } from "@cubby/schemas/entity";
import {
  financialAccountCreateInput,
  financialAccountSortableFields,
} from "@cubby/schemas/financial-account";
import {
  financialTransactionCreateInput,
  financialTransactionSortableFields,
} from "@cubby/schemas/financial-transaction";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { imageSortableFields } from "@cubby/schemas/image";
import { ingredientSortableFields } from "@cubby/schemas/ingredient";
import { inventorySortableFields } from "@cubby/schemas/inventory";
import {
  ledgerPartyCreateInput,
  ledgerPartySortableFields,
} from "@cubby/schemas/ledger-party";
import {
  ledgerTransferCreateInput,
  ledgerTransferSortableFields,
} from "@cubby/schemas/ledger-transfer";
import { locationSortableFields } from "@cubby/schemas/location";
import { mealCreateInput, mealSortableFields } from "@cubby/schemas/meal";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { productSortableFields } from "@cubby/schemas/product";
import {
  expenseCreateInput,
  expenseSortableFields,
  projectCreateInput,
  projectSortableFields,
  taskCreateInput,
  taskSortableFields,
} from "@cubby/schemas/project";
import {
  purchaseCreateInput,
  purchaseSortableFields,
} from "@cubby/schemas/purchase";
import { recipeSortableFields } from "@cubby/schemas/recipe";
import { vendorCreateInput, vendorSortableFields } from "@cubby/schemas/vendor";
import { wishSortableFields } from "@cubby/schemas/wish";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import type { Database } from "~/server/db";
import {
  inventoryEntry,
  location,
  purchaseImage,
  recipe,
  wish,
} from "~/server/db/schema";
import { getDb, insertAndReturn } from "./database-helpers";
import { createExpense, expenseList } from "./expense";
import {
  createFinancialAccount,
  listFinancialAccounts,
} from "./financial-account";
import {
  createFinancialTransaction,
  listFinancialTransactions,
} from "./financial-transaction";
import { imageList } from "./image";
import { createIngredient, ingredientList } from "./ingredient";
import { inventoryentryList } from "./inventory";
import { createLedgerParty, listLedgerParties } from "./ledger-party";
import { createLedgerTransfer, listLedgerTransfers } from "./ledger-transfer";
import { locationList } from "./location";
import { createMeal, mealList } from "./meal";
import { productList } from "./product";
import { createProject, projectList } from "./project";
import { createPurchase, purchaseList } from "./purchase";
import { recipeList } from "./recipe";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  createRecipeFixture,
  ingredientRef,
  makeLocationInput,
  makeProductInput,
  makeRecipeInput,
} from "./repo.fixtures";
import { resolveLiveShortcode } from "./shortcode-resolver";
import { insertWithShortcode } from "./shortcode-utils";
import { createTask, taskList } from "./task";
import { createVendor, getVendorByID, vendorList } from "./vendor";
import { createWish, wishList } from "./wish";

/**
 * Declaration-driven twin of `filter-application.integration.test.ts`, for
 * SORTS instead of filters.
 *
 * The invariant: **a column must sort by the same value it displays.** For
 * every entity exporting `<entity>SortableFields`, and for every field it
 * declares, this seeds a world where the field's rendered cell takes at least
 * two distinct values, sorts the list by that field in both directions, and
 * asserts the RENDERED CELL VALUES on the returned rows are monotone in the
 * sort direction. It is driven entirely by the declarations — a new entity or
 * a newly-spread sortable field is covered with no edit here.
 *
 * What this catches, precisely:
 *
 *  - WOULD have caught the `location.inventoryEntries` bug: the cell listed
 *    every installed fixture (49 chips) while the sort's correlated subquery
 *    counted only `placement = 'stock'` rows (25), so a location with fixtures
 *    but no loose stock rendered a populated chip list yet sorted as if it were
 *    empty. Fixed in `location/crud.ts`'s `resolveLocationSort`; this guard is
 *    what stops it returning.
 *  - WOULD have caught any of the four historical `buildSelection`
 *    self-join bugs (see the doc comment on `correlated()` in
 *    `database-helpers/query.ts` — "It has produced four bugs in this repo"):
 *    an interpolated Drizzle column in a correlated ORDER BY binds to the
 *    subquery's OWN column and silently returns 0/null for every row, while
 *    the SELECT list (built the same way, or via a different, correct path)
 *    still renders the real value. Sort and cell would visibly disagree.
 *  - Would NOT have caught the product `purchaseDate` bug that motivated this
 *    work: the cell, the sort, and both filter bounds all read the SAME
 *    fragment (`productAcquisitionDateSql`) and were wrong TOGETHER. This
 *    guard only proves sort and cell AGREE — it has no opinion on whether the
 *    thing they agree on is the fact the user wanted. Say this plainly: it is
 *    not a substitute for a test that knows the correct domain answer.
 */

const PAGE: PaginationParams = { pageIndex: 0, pageSize: 100 };

/** A single sort, ascending. */
const asc = (orderBy: string): SortParams[] => [{ orderBy, direction: "asc" }];
/** A single sort, descending. */
const desc = (orderBy: string): SortParams[] => [
  { orderBy, direction: "desc" },
];

// ---------------------------------------------------------------------------
// Cell extraction
// ---------------------------------------------------------------------------

/** Dotted-path read, or `undefined` the moment any hop is missing/null. */
const getByPath = (row: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, row);

/**
 * How a declared field's id is translated into a lookup on the rendered row.
 * A `string` is a dotted path (identity — the field id itself — when the
 * field has no entry here); a `function` is a computed accessor for a cell
 * shape too irregular for a path (an array-of-refs reduced to its minimum
 * name, mirroring a `MIN(...)` sort).
 *
 * Every entry earns its place by a real naming/shape mismatch between the
 * sortable-field id and the row's own key — never a blanket rename. Kept
 * free of fields that no longer exist by the staleness test below.
 */
type CellAccessor = string | ((row: Record<string, unknown>) => unknown);

const FIELD_ALIASES: Record<string, CellAccessor> = {
  // The column id is `expenses` (persisted per-user in a localStorage key, so
  // it can't be renamed to match), but the accessor productlist.tsx binds to
  // — and the value `resolveProductSort`'s "expenses" branch recomputes — is
  // `expenseCount`. See product/crud.ts:867's comment on the id/key split.
  "product.expenses": "expenseCount",
  // `location` has no matching top-level key on `ProductListItem` at all —
  // the cell is composed client-side from `inventoryEntry[].location.name`
  // (createInventoryEntriesColumn in productlist.tsx), and the sort is
  // `MIN(l.name)` over the same join (resolveProductSort's "location"
  // branch). Reduce to the alphabetically-first live location name so the two
  // stay comparable.
  "product.location": (row) => {
    const entries = row.inventoryEntry as
      | Array<{ location?: { name?: unknown } }>
      | undefined;
    const names = (entries ?? [])
      .map((entry) => entry.location?.name)
      .filter((name): name is string => typeof name === "string");
    if (names.length === 0) return undefined;
    return names.reduce((min, name) => (name < min ? name : min));
  },
  // `valuation` is a persisted jsonb rollup ({directValuation, ...}); the
  // sort resolver explicitly extracts `->>'directValuation'` because "that is
  // what the list cell renders in compact mode" (location/crud.ts).
  "location.valuation": "valuation.directValuation",
  // "InventoryEntry does not have a name, just ID" (inventory.ts) — the sort
  // (and the "product" sort, the same resolver branch) both order by the
  // joined Product's name.
  "inventory.name": "product.name",
  // `amount` is a jsonb `{value, unit}` object with no `.name`/`.count` for
  // the generic sniffers to find; the generic column path sorts the raw
  // jsonb (structural, not numeric) with no special-case resolver, so this
  // guard only seeds same-unit entries — see seedWorld's comment on why that
  // keeps the comparison meaningful.
  "inventory.amount": "amount.value",
  // Persisted jsonb rollup; the sort extracts these two keys with a jsonb
  // `->>` cast (recipe/crud.ts), same pattern as location.valuation.
  "recipe.costTotal": "totals.costTotal",
  "recipe.caloriesTotal": "totals.caloriesTotal",
  // The real `Recipe.totalMinutes` column, surfaced nested under
  // `meta.times.totalMinutes` by `recipeMetaFromColumns`.
  "recipe.totalMinutes": "meta.times.totalMinutes",
  // The sort orders by `tags[1]` (SQL's 1-indexed first element) only; the
  // cell is the full chip list. Compare the same first element.
  "recipe.tags": (row) => {
    const tags = row.tags as string[] | null | undefined;
    return tags && tags.length > 0 ? tags[0] : undefined;
  },
  // joinedNameSort resolves these through a live join and the mapper exposes
  // the joined name under `*Name`, never under the bare relation id.
  "task.project": "projectName",
  "task.subjectProduct": "subjectProductName",
  "expense.project": "projectName",
  "expense.product": "productName",
  // `dbPurchaseToAPI` resolves the vendor's display name onto `vendorName`;
  // `vendor` itself is only the raw FK.
  "purchase.vendor": "vendorName",
  // `expectedQuantity` is nested under `quantityLedger` on `ProductListItem`
  // (`deriveProductQuantityShape`, product/mappers.ts) — no top-level key.
  "product.expectedQuantity": "quantityLedger.expectedQuantity",
};

/**
 * Sortable fields with no comparable rendered cell on the LIST row at all —
 * either no cell exists, or the sort's projection is a different value from
 * the one the cell shows (so comparing them would test the wrong thing, not
 * a real disagreement). Each entry names why; the staleness test below fails
 * the moment one of these fields would actually be comparable, so an entry
 * that stops being true is caught rather than silently kept.
 */
const SORT_ONLY_FIELDS: Record<string, string> = {
  "product.identity_strength":
    "no rendered cell — a ranking heuristic (barcode > other external id > manufacturer+model > model > none) used only to order the enrichment worklist, never displayed as a value.",
  "product.primaryGtin":
    "the sort is a live ProductExternalId lookup (isPrimary DESC, createdAt, id LIMIT 1, resolveProductSort in product/crud.ts); the rendered `primaryGtin` cell is a separately-resolved projection that can legitimately pick a different id on a tie — not the same projection to compare.",
  "product.related:product.projects":
    "the cell is a RelatedPreviewGroup fetched via a separate per-row related-view query (RelatedPreviewCell / relatedData.preview), never present on productList()'s row.",
  "product.related:product.vendors":
    "same as related:product.projects — a separate per-row related-view query, not on the list row.",
  "product.related:product.purchases":
    "same as related:product.projects — a separate per-row related-view query, not on the list row.",
  "purchase.reconciliationGap":
    "PurchaseOut exposes only the categorical `reconciliation` enum; the numeric gap the sort orders by (abs(expenseTotal - statedTotal), purchase.ts resolveByOrder) has no rendered counterpart.",
  "recipe.cookbook":
    "no `cookbook` key on RecipeListItem; the closest visible text is `source.book`, a separate denormalized column that can legitimately drift from the live Cookbook name the sort reads.",
  "recipe.source":
    "the cell is a discriminated union ({type, book|url|pageId}); the rendered label (sourceLabel(), recipe-source.tsx) is computed client-side per source type, while the sort compares a two-column DB tuple (SourceType, SourceData) with no single scalar counterpart on the row.",
  "recipe.yield":
    "the sort key is the separate `servings` column; the rendered cell is `formatYield(recipe.yield)` prose whenever the structured `yield` amount is present, falling back to a plain 'N servings' string only when it's null — no single field holds what's displayed in both cases.",
  "wish.priceRange":
    "no `priceRange` field on WishOut; the rendered cell is computed client-side by `wishPriceRange(candidates)` off the `candidates[]` array, not a row field.",
};

/**
 * Sortable fields where the sort DELIBERATELY differs from the cell — a
 * declared, cited approximation, not a bug. Skipped rather than asserted;
 * the staleness test still keeps this free of fields that no longer exist.
 */
const KNOWN_APPROXIMATIONS: Record<string, string> = {
  "project.startDate":
    'project/lookup.ts\'s 20-line APPROXIMATION comment: the cell is `dates.effectiveStart`, "a fully recursive fold over descendants" (subtree.ts); the sort is deliberately non-recursive — "matching the true recursive fold would need a recursive CTE, and at this scale... it moves nothing. Everything *displayed* comes from `dates.effectiveStart`... this only orders rows."',
  "meal.mealType":
    "closed low-cardinality enum ordered by a deliberate domain rank (breakfast < lunch < dinner < snack, via `array_position` in resolveMealSort, meal/crud.ts), not alphabetically — same displayed string, different collation by design.",
};

/** Normalize a raw cell value to a comparable primitive, or `undefined` if it
 * isn't one. Nulls/undefined are "not comparable for this row" — callers skip
 * them rather than treat them as an ordering fact (NULLS FIRST/LAST varies by
 * site; encoding it would produce false positives). */
const normalizeCellValue = (raw: unknown): string | number | undefined => {
  if (raw === null || raw === undefined) return undefined;
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw === "string" || typeof raw === "number") return raw;
  if (Array.isArray(raw)) return raw.length;
  if (typeof raw === "object") {
    const name = (raw as Record<string, unknown>).name;
    if (typeof name === "string") return name;
  }
  return undefined;
};

const extractCell = (
  entity: string,
  field: string,
  row: Record<string, unknown>,
): string | number | undefined => {
  const accessor = FIELD_ALIASES[`${entity}.${field}`] ?? field;
  const raw =
    typeof accessor === "function" ? accessor(row) : getByPath(row, accessor);
  return normalizeCellValue(raw);
};

const compareValues = (a: string | number, b: string | number): number =>
  typeof a === "string" && typeof b === "string"
    ? a.localeCompare(b)
    : (a as number) - (b as number);

/** Are the non-null cell values, in returned order, monotone for `direction`? */
const isMonotone = (
  values: (string | number)[],
  direction: SortParams["direction"],
): boolean => {
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    const cur = values[i];
    if (prev === undefined || cur === undefined) continue;
    const cmp = compareValues(prev, cur);
    if (direction === "asc" && cmp > 0) return false;
    if (direction === "desc" && cmp < 0) return false;
  }
  return true;
};

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

type SeedActor = Parameters<typeof createVendor>[2];

/**
 * Two rows per entity, deliberately seeded so every generically-testable
 * sortable field has at least two DISTINCT non-null cell values — otherwise
 * both an ascending and a descending sort trivially "pass" without exercising
 * anything (see the `distinct` check in the loop below).
 *
 * A few persisted rollups (recipe totals/minutes, location valuation/last-
 * bulk-inventory, inventory verifiedAt, wish acquiredAt) are seeded with a
 * direct table write rather than a repo call: those values are computed by
 * a recompute pipeline or a dedicated session-completion action this test has
 * no cheap way to drive, and a raw write still exercises the SAME sort/cell
 * code this guard checks — it only skips recomputing the number honestly.
 */
const seedWorld = async (ctx: { db: Database; actor: SeedActor }) => {
  const { db, actor } = ctx;

  // --- vendors ------------------------------------------------------------
  const { entityId: vendorAlphaId } = await createVendor(
    db,
    vendorCreateInput.parse({ name: "Guard Sort Vendor Alpha" }),
    actor,
  );
  const vendorAlpha = await getVendorByID(db, vendorAlphaId);
  const { entityId: vendorBetaId } = await createVendor(
    db,
    vendorCreateInput.parse({ name: "Guard Sort Vendor Beta" }),
    actor,
  );
  const vendorBeta = await getVendorByID(db, vendorBetaId);

  // --- purchases: 2 on Alpha (for vendor.purchaseCount/spend/latest
  // distinctness), 1 on Beta ------------------------------------------------
  const { output: purchase1 } = await createPurchase(
    db,
    purchaseCreateInput.parse({
      vendorId: vendorAlpha.id,
      orderId: "GRD-SORT-0001",
      displayLabel: "Guard Sort Purchase One",
      date: "2024-03-01",
      statedTotal: 50,
    }),
    actor,
  );
  const { output: purchase2 } = await createPurchase(
    db,
    purchaseCreateInput.parse({
      vendorId: vendorAlpha.id,
      orderId: "GRD-SORT-0002",
      displayLabel: "Guard Sort Purchase Two",
      date: "2024-03-10",
      statedTotal: 20,
    }),
    actor,
  );
  const { output: purchase3 } = await createPurchase(
    db,
    purchaseCreateInput.parse({
      vendorId: vendorBeta.id,
      orderId: "GRD-SORT-0003",
      displayLabel: "Guard Sort Purchase Three",
      date: "2024-01-01",
      statedTotal: 5,
    }),
    actor,
  );

  // A document on purchase1 only, for purchase.documentCount distinctness —
  // same insert shape as purchase.integration.test.ts's mergePurchases suite.
  const purchase1Uuid = parseEntityId(
    "purchase",
    (await resolveLiveShortcode(db, purchase1.id, "purchase"))!,
  );
  const guardDoc = await insertWithShortcode(db, "image", {
    key: `test-documents/guard-sort-${crypto.randomUUID()}.pdf`,
    filename: "guard-sort-receipt.pdf",
    contentType: "application/pdf",
    size: 100,
    status: "UPLOADED",
  });
  await insertAndReturn(db, purchaseImage, {
    purchaseId: purchase1Uuid,
    imageId: guardDoc.id,
  });

  // --- ingredients ----------------------------------------------------------
  const ingredientAlpha = await createIngredient(
    db,
    { name: "guard sort ingredient alpha", aliases: [] },
    actor,
  );
  const ingredientBeta = await createIngredient(
    db,
    { name: "guard sort ingredient beta", aliases: [] },
    actor,
  );

  // --- products ---------------------------------------------------------
  // Alpha: "tools" (a legal wish candidate + task subject), unlinked from any
  // ingredient AND carrying no `fdc_id` — `hasFoodIndicators` force-overrides
  // category to "food" the instant EITHER is set (packages/schemas/src/
  // product.ts), which would break Alpha's tools-only uses below.
  const productAlpha = await createProductFixture(
    db,
    makeProductInput({
      name: "Guard Sort Product Alpha",
      category: "tools",
      manufacturer: "Guard Manufacturer Alpha",
      model: "MODEL-A",
      notes: "Guard sort notes alpha",
      price: 25,
      tags: ["guard-sort-tag-a"],
      unitMappings: [
        {
          a: { value: 1, unit: "box" },
          b: { value: 4, unit: "each" },
          source: null,
        },
      ],
    }),
    actor,
  );
  const productBeta = await createProductFixture(
    db,
    makeProductInput({
      name: "Guard Sort Product Beta",
      category: "food",
      manufacturer: "Guard Manufacturer Beta",
      model: "MODEL-B",
      notes: "Guard sort notes beta",
      price: 60,
      fdc_id: 2222222,
      ingredientId: ingredientAlpha.id,
    }),
    actor,
  );
  // A second product on ingredientAlpha and one on ingredientBeta, so
  // ingredient.product's array length differs (2 vs 1) — Beta alone would tie
  // both ingredients at 1. Also carries the second distinct `fdc_id`.
  const productGamma = await createProductFixture(
    db,
    makeProductInput({
      name: "Guard Sort Product Gamma",
      category: "food",
      fdc_id: 3333333,
      ingredientId: ingredientAlpha.id,
    }),
    actor,
  );
  const productDelta = await createProductFixture(
    db,
    makeProductInput({
      name: "Guard Sort Product Delta",
      category: "food",
      ingredientId: ingredientBeta.id,
    }),
    actor,
  );

  // --- locations ----------------------------------------------------------
  const locationAlpha = await createLocationFixture(
    db,
    makeLocationInput({ name: "Guard Sort Location Alpha", type: "room" }),
    actor,
  );
  const locationBeta = await createLocationFixture(
    db,
    makeLocationInput({
      name: "Guard Sort Location Beta",
      type: "shelf",
      parentId: locationAlpha.id,
    }),
    actor,
  );
  // A third rung so `parent`'s non-null distinctness isn't just "Alpha's name
  // vs null" — Gamma's parent is Beta, giving two distinct non-null parent
  // names (Alpha, Beta) instead of one.
  const locationGamma = await createLocationFixture(
    db,
    makeLocationInput({
      name: "Guard Sort Location Gamma",
      type: "box",
      parentId: locationBeta.id,
    }),
    actor,
  );

  // --- inventory: same unit ("each") on both entries deliberately — the
  // DB column is jsonb, so a cross-unit sort compares Postgres's structural
  // jsonb key order, not numeric magnitude (`{unit, value}`, keys compared in
  // that order); same-unit entries make the tie on `unit` fall through to a
  // genuine numeric compare on `value`, which is what the guard means to
  // check. inv3 (Gamma at Alpha) gives `location.inventoryEntries` a second,
  // distinct count (2 at Alpha vs 1 at Beta) without touching productAlpha or
  // productBeta's own `product.location` value. --------------------------
  const invAlpha = await createInventoryFixture(
    db,
    {
      productId: productAlpha.id,
      locationId: locationAlpha.id,
      amount: { value: 2, unit: "each" },
    },
    actor,
  );
  const invBeta = await createInventoryFixture(
    db,
    {
      productId: productBeta.id,
      locationId: locationBeta.id,
      amount: { value: 7, unit: "each" },
    },
    actor,
  );
  await createInventoryFixture(
    db,
    {
      productId: productGamma.id,
      locationId: locationAlpha.id,
      amount: { value: 3, unit: "each" },
    },
    actor,
  );
  // Two INSTALLED fixtures at Beta, and they are what give
  // `location.inventoryEntries` its teeth. `stockOnly()` governs the cell, the
  // sort, and the count filters alike (inventory/placement.ts: "Counting,
  // auditing, browsing → EXCLUDE"), so with stock-only rows the two populations
  // are identical and the assertion is vacuous — it passed against the real
  // pre-fix code until these existed.
  //
  // The counts are chosen so a regression INVERTS the order rather than merely
  // tying it: stock-only is Alpha 2 / Beta 1, but counting fixtures makes it
  // Alpha 2 / Beta 3. A cell that includes installed rows therefore reads
  // 2, 3 under a descending sort — not monotone, and the guard fails.
  //
  // Neither entry perturbs a product's own `location` cell: Gamma gains Beta
  // but still MINs to Alpha, and Beta already stocks here.
  for (const productId of [productBeta.id, productGamma.id]) {
    await createInventoryFixture(
      db,
      {
        productId,
        locationId: locationBeta.id,
        amount: { value: 1, unit: "each" },
        placement: "installed",
      },
      actor,
    );
  }

  // --- recipes --------------------------------------------------------
  const recipeAlpha = await createRecipeFixture(
    db,
    makeRecipeInput({
      name: "Guard Sort Recipe Alpha",
      tags: ["guard-sort-tag-a", "zzz-guard-second-tag"],
      sections: [{ ingredients: [ingredientRef(ingredientAlpha.id)] }],
    }),
    actor,
  );
  const recipeBeta = await createRecipeFixture(
    db,
    makeRecipeInput({
      name: "Guard Sort Recipe Beta",
      tags: ["aaa-guard-beta-tag"],
    }),
    actor,
  );
  // costTotal/caloriesTotal/totalMinutes are recompute-pipeline output, not
  // create-time inputs — write the persisted shape directly (still the exact
  // jsonb the sort's `->>'costTotal'`/`->>'caloriesTotal'` extraction reads).
  // `updatedAt` is pinned explicitly rather than left to `$onUpdate(() => new
  // Date())` (schema.ts's `baseTimestamps`) — two sequential writes can land
  // in the same millisecond, which would tie `recipe.updatedAt`'s two seeded
  // values and make its distinctness check vacuous.
  await getDb(db)
    .update(recipe)
    .set({
      totalMinutes: 15,
      updatedAt: new Date("2024-08-01T00:00:00Z"),
      totals: {
        costTotal: 12.5,
        caloriesTotal: 300,
        ingredientCount: 1,
        costCovered: 1,
        caloriesCovered: 1,
      },
    })
    .where(eq(recipe.id, recipeAlpha.entityId));
  await getDb(db)
    .update(recipe)
    .set({
      totalMinutes: 45,
      updatedAt: new Date("2024-08-02T00:00:00Z"),
      totals: {
        costTotal: 40,
        caloriesTotal: 900,
        ingredientCount: 0,
        costCovered: 0,
        caloriesCovered: 0,
      },
    })
    .where(eq(recipe.id, recipeBeta.entityId));

  // --- meals ----------------------------------------------------------
  await createMeal(
    db,
    mealCreateInput.parse({
      date: "2024-05-01",
      name: "Guard Sort Meal Alpha",
      mealType: "breakfast",
    }),
    actor,
  );
  await createMeal(
    db,
    mealCreateInput.parse({
      date: "2024-05-10",
      name: "Guard Sort Meal Beta",
      mealType: "dinner",
    }),
    actor,
  );

  // --- projects ---------------------------------------------------------
  const { output: projectAlpha } = await createProject(
    db,
    projectCreateInput.parse({
      name: "Guard Sort Project Alpha",
      status: "planning",
      kind: "renovation",
      costEstimate: 500,
    }),
    actor,
  );
  const { output: projectBeta } = await createProject(
    db,
    projectCreateInput.parse({
      name: "Guard Sort Project Beta",
      status: "in_progress",
      kind: "furniture",
      costEstimate: 1500,
      parentProjectId: projectAlpha.id,
    }),
    actor,
  );

  // --- tasks --------------------------------------------------------------
  const { output: taskAlpha } = await createTask(
    db,
    taskCreateInput.parse({
      name: "Guard Sort Task Alpha",
      trade: "other",
      status: "not_started",
      dueDate: "2024-04-01",
      projectId: projectAlpha.id,
      subjectProductId: productAlpha.id,
    }),
    actor,
  );
  await createTask(
    db,
    taskCreateInput.parse({
      name: "Guard Sort Task Beta",
      trade: "electrical",
      status: "in_progress",
      dueDate: "2024-04-10",
      projectId: projectBeta.id,
      subjectProductId: productBeta.id,
      parentTaskId: taskAlpha.id,
    }),
    actor,
  );

  // --- expenses -------------------------------------------------------
  // expense1/6 -> productAlpha (expenseCount=2, expenseTotal=35,
  // expectedQuantity=5); expense5 -> productBeta (expenseCount=1,
  // expenseTotal=10, expectedQuantity=1) — every product-rollup pair below
  // ends up distinct off this one set of lines.
  await createExpense(
    db,
    expenseCreateInput.parse({
      name: "Guard Sort Expense One",
      trade: "other",
      costType: "materials",
      lineKind: "principal",
      cost: 30,
      date: "2024-02-01",
      productId: productAlpha.id,
      productQuantity: 3,
      projectId: projectAlpha.id,
      purchaseId: purchase1.id,
    }),
    actor,
  );
  await createExpense(
    db,
    expenseCreateInput.parse({
      name: "Guard Sort Expense Two — shipping",
      trade: "electrical",
      costType: "tools",
      lineKind: "shipping",
      cost: 20,
      date: "2024-02-05",
      purchaseId: purchase1.id,
    }),
    actor,
  );
  await createExpense(
    db,
    expenseCreateInput.parse({
      name: "Guard Sort Expense Three",
      trade: "other",
      costType: "materials",
      lineKind: "principal",
      cost: 20,
      date: "2024-02-10",
      purchaseId: purchase2.id,
    }),
    actor,
  );
  await createExpense(
    db,
    expenseCreateInput.parse({
      name: "Guard Sort Expense Four",
      trade: "other",
      costType: "services",
      cost: 5,
      date: "2024-01-05",
      purchaseId: purchase3.id,
    }),
    actor,
  );
  await createExpense(
    db,
    expenseCreateInput.parse({
      name: "Guard Sort Expense Five",
      trade: "other",
      costType: "materials",
      cost: 10,
      date: "2024-02-15",
      productId: productBeta.id,
      productQuantity: 1,
      projectId: projectBeta.id,
    }),
    actor,
  );
  await createExpense(
    db,
    expenseCreateInput.parse({
      name: "Guard Sort Expense Six",
      trade: "other",
      costType: "materials",
      cost: 5,
      date: "2024-02-20",
      productId: productAlpha.id,
      productQuantity: 2,
    }),
    actor,
  );

  // --- financial accounts + transactions -----------------------------
  const { output: accountAlpha } = await createFinancialAccount(
    db,
    financialAccountCreateInput.parse({
      name: "Guard Sort Card Alpha",
      provisional: false,
      identity: {
        kind: "credit_card",
        issuer: null,
        network: "visa",
        last4: "1001",
      },
    }),
    actor,
  );
  const { output: accountBeta } = await createFinancialAccount(
    db,
    financialAccountCreateInput.parse({
      name: "Guard Sort Card Beta",
      provisional: true,
      identity: {
        kind: "credit_card",
        issuer: null,
        network: "visa",
        last4: "1002",
      },
    }),
    actor,
  );
  // Never linked to a transaction — its whole role is the "0" half of
  // transactionCount's distinctness.
  void accountBeta;
  // Both transactions on Alpha, none on Beta — transactionCount distinctness.
  await createFinancialTransaction(
    db,
    financialTransactionCreateInput.parse({
      accountId: accountAlpha.id,
      purchaseId: purchase1.id,
      kind: "purchase",
      status: "posted",
      transactionDate: "2024-04-01",
      postedDate: "2024-04-01",
      amount: 25,
      merchant: "Guard Merchant Alpha",
      rawDescription: "GUARD SORT TXN ONE",
    }),
    actor,
  );
  await createFinancialTransaction(
    db,
    financialTransactionCreateInput.parse({
      accountId: accountAlpha.id,
      kind: "fee",
      status: "pending",
      transactionDate: "2024-04-10",
      postedDate: "2024-04-11",
      amount: 9,
      merchant: "Guard Merchant Beta",
      rawDescription: "GUARD SORT TXN TWO",
    }),
    actor,
  );

  // --- ledger parties + transfers -------------------------------------
  const { output: ledgerPartyAlpha } = await createLedgerParty(
    db,
    ledgerPartyCreateInput.parse({
      name: "Guard Sort Ledger Alpha",
      kind: "member",
    }),
    actor,
  );
  const { output: ledgerPartyBeta } = await createLedgerParty(
    db,
    ledgerPartyCreateInput.parse({
      name: "Guard Sort Ledger Beta",
      kind: "guest",
    }),
    actor,
  );
  await createLedgerTransfer(
    db,
    ledgerTransferCreateInput.parse({
      fromPartyId: ledgerPartyAlpha.id,
      toPartyId: ledgerPartyBeta.id,
      amount: 15,
      date: "2024-06-01",
    }),
    actor,
  );
  await createLedgerTransfer(
    db,
    ledgerTransferCreateInput.parse({
      fromPartyId: ledgerPartyBeta.id,
      toPartyId: ledgerPartyAlpha.id,
      amount: 40,
      date: "2024-06-10",
    }),
    actor,
  );

  // --- wishes -----------------------------------------------------------
  const { output: wishAlpha } = await createWish(
    db,
    {
      name: "Guard Sort Wish Alpha",
      notes: null,
      candidateProductIds: [productAlpha.id],
    },
    actor,
  );
  const { output: wishBeta } = await createWish(
    db,
    { name: "Guard Sort Wish Beta", notes: null, candidateProductIds: [] },
    actor,
  );
  // acquiredAt is normally set by `updateWish({acquired: true})` to
  // `new Date()` — a direct write keeps the two rows deterministically
  // distinct instead of racing the clock.
  const wishAlphaUuid = parseEntityId(
    "wish",
    (await resolveLiveShortcode(db, wishAlpha.id, "wish"))!,
  );
  const wishBetaUuid = parseEntityId(
    "wish",
    (await resolveLiveShortcode(db, wishBeta.id, "wish"))!,
  );
  // `updatedAt` is pinned explicitly everywhere below — see the recipe
  // update above for why `$onUpdate(() => new Date())` alone isn't safe to
  // rely on for two sequential writes.
  await getDb(db)
    .update(wish)
    .set({
      acquiredAt: new Date("2024-07-01T00:00:00Z"),
      updatedAt: new Date("2024-08-01T00:00:00Z"),
    })
    .where(eq(wish.id, wishAlphaUuid));
  await getDb(db)
    .update(wish)
    .set({
      acquiredAt: new Date("2024-07-15T00:00:00Z"),
      updatedAt: new Date("2024-08-02T00:00:00Z"),
    })
    .where(eq(wish.id, wishBetaUuid));

  // --- location rollups (valuation, lastBulkInventory) -------------------
  // Both are persisted/session-driven, not create-time inputs — see the
  // seedWorld doc comment above for why a direct write is the pragmatic seed.
  const zeroCounts = { priced: 0, missingPricing: 0, miscNoPrice: 0 };
  await getDb(db)
    .update(location)
    .set({
      lastBulkInventory: new Date("2024-01-01T00:00:00Z"),
      updatedAt: new Date("2024-08-01T00:00:00Z"),
      valuation: {
        directValuation: 50,
        totalValuation: 50,
        directItemCount: 1,
        totalItemCount: 1,
        direct: zeroCounts,
        total: zeroCounts,
      },
    })
    .where(eq(location.id, locationAlpha.entityId));
  await getDb(db)
    .update(location)
    .set({
      lastBulkInventory: new Date("2024-06-01T00:00:00Z"),
      updatedAt: new Date("2024-08-02T00:00:00Z"),
      valuation: {
        directValuation: 420,
        totalValuation: 420,
        directItemCount: 1,
        totalItemCount: 1,
        direct: zeroCounts,
        total: zeroCounts,
      },
    })
    .where(eq(location.id, locationBeta.entityId));
  void locationGamma;

  // --- inventory.verifiedAt (session-completion action, not create-time) -
  await getDb(db)
    .update(inventoryEntry)
    .set({
      verifiedAt: new Date("2024-01-01T00:00:00Z"),
      updatedAt: new Date("2024-08-01T00:00:00Z"),
    })
    .where(eq(inventoryEntry.id, invAlpha.entityId));
  await getDb(db)
    .update(inventoryEntry)
    .set({
      verifiedAt: new Date("2024-06-01T00:00:00Z"),
      updatedAt: new Date("2024-08-02T00:00:00Z"),
    })
    .where(eq(inventoryEntry.id, invBeta.entityId));

  // --- images -------------------------------------------------------------
  await insertWithShortcode(db, "image", {
    key: `test/guard-sort-${crypto.randomUUID()}.jpg`,
    filename: "guard-sort-alpha.jpg",
    contentType: "image/jpeg",
    size: 1000,
    status: "PENDING",
  });
  await insertWithShortcode(db, "image", {
    key: `test/guard-sort-${crypto.randomUUID()}.jpg`,
    filename: "guard-sort-beta.jpg",
    contentType: "image/jpeg",
    size: 5000,
    status: "UPLOADED",
  });

  void productDelta;
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

type SortListProbe = (
  db: Database,
  sorts: SortParams[],
) => Promise<{ rows: Record<string, unknown>[]; count: number }>;

const sortListFor =
  <F>(
    fn: (
      db: Database,
      filters: F,
      sorts: SortParams[],
      pagination: PaginationParams,
    ) => Promise<{ data: unknown[]; count: number }>,
  ): SortListProbe =>
  async (db, sorts) => {
    const { data, count } = await fn(db, {} as F, sorts, PAGE);
    return { rows: data as Record<string, unknown>[], count };
  };

const SORT_GUARDS = {
  expense: { fields: expenseSortableFields, list: sortListFor(expenseList) },
  financialAccount: {
    fields: financialAccountSortableFields,
    list: sortListFor(listFinancialAccounts),
  },
  financialTransaction: {
    fields: financialTransactionSortableFields,
    list: sortListFor(listFinancialTransactions),
  },
  image: { fields: imageSortableFields, list: sortListFor(imageList) },
  ingredient: {
    fields: ingredientSortableFields,
    list: sortListFor(ingredientList),
  },
  inventory: {
    fields: inventorySortableFields,
    list: sortListFor(inventoryentryList),
  },
  location: { fields: locationSortableFields, list: sortListFor(locationList) },
  ledgerParty: {
    fields: ledgerPartySortableFields,
    list: sortListFor(listLedgerParties),
  },
  ledgerTransfer: {
    fields: ledgerTransferSortableFields,
    list: sortListFor(listLedgerTransfers),
  },
  meal: { fields: mealSortableFields, list: sortListFor(mealList) },
  product: { fields: productSortableFields, list: sortListFor(productList) },
  project: { fields: projectSortableFields, list: sortListFor(projectList) },
  purchase: { fields: purchaseSortableFields, list: sortListFor(purchaseList) },
  recipe: { fields: recipeSortableFields, list: sortListFor(recipeList) },
  task: { fields: taskSortableFields, list: sortListFor(taskList) },
  vendor: { fields: vendorSortableFields, list: sortListFor(vendorList) },
  wish: { fields: wishSortableFields, list: sortListFor(wishList) },
} satisfies Partial<
  Record<Entity, { fields: readonly string[]; list: SortListProbe }>
>;

type SortGuardedEntity = keyof typeof SORT_GUARDS;
const SORT_GUARDED_ENTITIES = Object.keys(SORT_GUARDS) as SortGuardedEntity[];

describe("every declared sortable field sorts by the value it displays", () => {
  const ctx = withTestDb();

  it.each(SORT_GUARDED_ENTITIES)("%s", async (entity) => {
    await seedWorld(ctx);
    const { fields, list } = SORT_GUARDS[entity];
    const baseline = await list(ctx.db, []);
    expect(baseline.count).toBeGreaterThanOrEqual(2);

    const violations: string[] = [];
    const passingSortOnly: string[] = [];

    for (const field of fields) {
      const key = `${entity}.${field}`;
      if (key in KNOWN_APPROXIMATIONS) continue;

      if (key in SORT_ONLY_FIELDS) {
        const anyComparable = baseline.rows.some(
          (row) => extractCell(entity, field, row) !== undefined,
        );
        if (anyComparable) passingSortOnly.push(key);
        continue;
      }

      const ascending = await list(ctx.db, asc(field));
      const descending = await list(ctx.db, desc(field));
      const ascValues = ascending.rows
        .map((row) => extractCell(entity, field, row))
        .filter((v): v is string | number => v !== undefined);
      const descValues = descending.rows
        .map((row) => extractCell(entity, field, row))
        .filter((v): v is string | number => v !== undefined);

      const distinct = new Set(ascValues.map(String));
      if (distinct.size < 2) {
        violations.push(
          `${key}: only ${distinct.size} distinct non-null cell value(s) among ${ascValues.length} rows — seeding produced no variance to sort, so this field is untested. Seed more variance in seedWorld, or roster it.`,
        );
        continue;
      }

      if (!isMonotone(ascValues, "asc")) {
        violations.push(
          `${key}: ascending sort produced non-monotone cell values ${JSON.stringify(ascValues)}`,
        );
      }
      if (!isMonotone(descValues, "desc")) {
        violations.push(
          `${key}: descending sort produced non-monotone cell values ${JSON.stringify(descValues)}`,
        );
      }
    }

    expect(violations).toEqual([]);
    expect(passingSortOnly).toEqual([]);
  });
});

describe("sort guard coverage", () => {
  /**
   * The registry above must cover every `<entity>SortableFields` the schemas
   * package exports. Scanned from source rather than listed, so a new
   * entity's sortable fields are covered the moment they're declared.
   * `usda-food`'s export is spelled `usdaFoodSortableFields` (not
   * `usda-foodSortableFields`) and `statementRow` isn't an `Entity` at all —
   * both fail `entitySchema.safeParse` and are correctly excluded, same as
   * `locationPickerSortableFields` (a narrower variant of `location`, not a
   * distinct entity).
   */
  it("registers every entity that declares sortable fields", () => {
    const schemaSrc = fileURLToPath(
      new URL("../../../../../packages/schemas/src/", import.meta.url),
    );
    const declared = new Set<Entity>();
    for (const file of readdirSync(schemaSrc)) {
      if (!file.endsWith(".ts") || file.includes(".test.")) continue;
      const source = readFileSync(`${schemaSrc}${file}`, "utf8");
      for (const match of source.matchAll(
        /export const (\w+)SortableFields\b/g,
      )) {
        const name = match[1];
        const parsed = entitySchema.safeParse(name);
        if (parsed.success) declared.add(parsed.data);
      }
    }
    expect(declared.size).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual([...SORT_GUARDED_ENTITIES].sort());
  });

  const fieldExists = (key: string): boolean => {
    const [entity, ...rest] = key.split(".");
    const field = rest.join(".");
    const guard = SORT_GUARDS[entity as SortGuardedEntity] as
      | { fields: readonly string[] }
      | undefined;
    return guard?.fields.includes(field) ?? false;
  };

  it("keeps the field-alias map free of fields that no longer exist", () => {
    const stale = Object.keys(FIELD_ALIASES).filter((key) => !fieldExists(key));
    expect(stale).toEqual([]);
  });

  it("keeps the sort-only roster free of fields that no longer exist", () => {
    const stale = Object.keys(SORT_ONLY_FIELDS).filter(
      (key) => !fieldExists(key),
    );
    expect(stale).toEqual([]);
  });

  it("keeps the known-approximations roster free of fields that no longer exist", () => {
    const stale = Object.keys(KNOWN_APPROXIMATIONS).filter(
      (key) => !fieldExists(key),
    );
    expect(stale).toEqual([]);
  });
});
