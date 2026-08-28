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
import { z } from "zod";

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
 * Every declared sort must order by the value its list cell displays. Each
 * field gets two distinct values and is checked in both directions. This
 * guards the installed-inventory mismatch and correlated self-join regressions.
 * It cannot catch a shared semantic error such as the old Product purchase-date
 * bug, where the cell, sort, and filters all used the same wrong fragment.
 */

const PAGE: PaginationParams = { pageIndex: 0, pageSize: 100 };

/** A single sort, ascending. */
const asc = (orderBy: string): SortParams[] => [{ orderBy, direction: "asc" }];
/** A single sort, descending. */
const desc = (orderBy: string): SortParams[] => [
  { orderBy, direction: "desc" },
];

type SortObject = { readonly [key: string]: SortCell };
type SortCell =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | SortCell[]
  | SortObject;
type SortRow = SortObject;

const sortCellSchema: z.ZodType<SortCell> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.date(),
    z.null(),
    z.undefined(),
    z.array(sortCellSchema),
    z.record(z.string(), sortCellSchema),
  ]),
);
const sortRowSchema = z.record(z.string(), sortCellSchema);
const inventoryEntryCellSchema = z.object({
  location: z.object({ name: z.string().nullish() }).nullish(),
});
const recipeTagsSchema = z.array(z.string()).nullish();

// ---------------------------------------------------------------------------
// Cell extraction
// ---------------------------------------------------------------------------

/** Dotted-path read, or `undefined` the moment any hop is missing/null. */
const getByPath = (row: SortRow, path: string): SortCell | undefined => {
  let current: SortCell | undefined = row;
  for (const key of path.split(".")) {
    const parsed = sortRowSchema.safeParse(current);
    if (!parsed.success) return undefined;
    current = parsed.data[key];
  }
  return current;
};

/** Map sortable-field ids to genuinely different list-row shapes. */
type CellAccessor = string | ((row: SortRow) => SortCell | undefined);

const isCellAccessorFunction = (
  accessor: CellAccessor,
): accessor is (row: SortRow) => SortCell | undefined =>
  typeof accessor === "function";

const aliasFor = (key: string): CellAccessor | undefined =>
  Object.entries(FIELD_ALIASES).find(([candidate]) => candidate === key)?.[1];

const FIELD_ALIASES = {
  // `expenses` is persisted as a column id; the row value is `expenseCount`.
  "product.expenses": "expenseCount",
  // Match the cell's locations to the sort's `MIN(location.name)`.
  "product.location": (row) => {
    const parsedEntries = z
      .array(inventoryEntryCellSchema)
      .nullish()
      .safeParse(row.inventoryEntry);
    const entries = parsedEntries.success ? parsedEntries.data : [];
    const names = (entries ?? [])
      .map((entry) => entry.location?.name)
      .filter((name): name is string => typeof name === "string");
    if (names.length === 0) return undefined;
    return names.reduce((min, name) => (name < min ? name : min));
  },
  // The list displays the direct value from the persisted rollup.
  "location.valuation": "valuation.directValuation",
  // Inventory's display name belongs to its joined Product.
  "inventory.name": "product.name",
  // The guard seeds one unit so structural JSON order reaches numeric value.
  "inventory.amount": "amount.value",
  // Recipe totals are persisted JSON rollups.
  "recipe.costTotal": "totals.costTotal",
  "recipe.caloriesTotal": "totals.caloriesTotal",
  // The mapper nests the real column under `meta.times`.
  "recipe.totalMinutes": "meta.times.totalMinutes",
  // SQL sorts by the first tag; the cell renders the full chip list.
  "recipe.tags": (row) => {
    const parsedTags = recipeTagsSchema.safeParse(row.tags);
    const tags = parsedTags.success ? parsedTags.data : undefined;
    return tags && tags.length > 0 ? tags[0] : undefined;
  },
  // Joined-name sorts surface the label under `*Name`.
  "task.project": "projectName",
  "task.subjectProduct": "subjectProductName",
  "expense.project": "projectName",
  "expense.product": "productName",
  // `vendor` is the raw FK; `vendorName` is the displayed value.
  "purchase.vendor": "vendorName",
  // The mapper nests expected quantity under its ledger.
  "product.expectedQuantity": "quantityLedger.expectedQuantity",
} satisfies Record<string, CellAccessor>;

/** Fields with no scalar list-cell value comparable to their sort projection. */
const SORT_ONLY_FIELDS = {
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
} satisfies Record<string, string>;

/**
 * Sortable fields where the sort DELIBERATELY differs from the cell — a
 * declared, cited approximation, not a bug. Skipped rather than asserted;
 * the staleness test still keeps this free of fields that no longer exist.
 */
const KNOWN_APPROXIMATIONS = {
  "project.startDate":
    'project/lookup.ts\'s 20-line APPROXIMATION comment: the cell is `dates.effectiveStart`, "a fully recursive fold over descendants" (subtree.ts); the sort is deliberately non-recursive — "matching the true recursive fold would need a recursive CTE, and at this scale... it moves nothing. Everything *displayed* comes from `dates.effectiveStart`... this only orders rows."',
  "meal.mealType":
    "closed low-cardinality enum ordered by a deliberate domain rank (breakfast < lunch < dinner < snack, via `array_position` in resolveMealSort, meal/crud.ts), not alphabetically — same displayed string, different collation by design.",
} satisfies Record<string, string>;

/** Normalize a raw cell value to a comparable primitive, or `undefined` if it
 * isn't one. Nulls/undefined are "not comparable for this row" — callers skip
 * them rather than treat them as an ordering fact (NULLS FIRST/LAST varies by
 * site; encoding it would produce false positives). */
const normalizeCellValue = (
  raw: SortCell | undefined,
): string | number | undefined => {
  if (raw === null || raw === undefined) return undefined;
  const date = z.date().safeParse(raw);
  if (date.success) return date.data.getTime();
  const boolean = z.boolean().safeParse(raw);
  if (boolean.success) return boolean.data ? 1 : 0;
  const string = z.string().safeParse(raw);
  if (string.success) return string.data;
  const number = z.number().safeParse(raw);
  if (number.success) return number.data;
  const array = z.array(sortCellSchema).safeParse(raw);
  if (array.success) return array.data.length;
  const object = sortRowSchema.safeParse(raw);
  if (object.success) {
    const name = z.string().safeParse(object.data.name);
    if (name.success) return name.data;
  }
  return undefined;
};

const extractCell = (
  entity: string,
  field: string,
  row: SortRow,
): string | number | undefined => {
  const accessor = aliasFor(`${entity}.${field}`) ?? field;
  const raw = isCellAccessorFunction(accessor)
    ? accessor(row)
    : getByPath(row, accessor);
  return normalizeCellValue(raw);
};

const compareValues = (a: string | number, b: string | number): number =>
  z.string().safeParse(a).success && z.string().safeParse(b).success
    ? String(a).localeCompare(String(b))
    : Number(a) - Number(b);

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
 * Seed two distinct non-null cell values per sortable field. Computed rollups
 * are written directly because this guard checks their sort/cell contract,
 * not the separate recomputation pipeline.
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
  // are identical and the assertion is vacuous.
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
) => Promise<{ rows: SortRow[]; count: number }>;

const sortListFor =
  <F, TRow>(
    fn: (
      db: Database,
      filters: F,
      sorts: SortParams[],
      pagination: PaginationParams,
    ) => Promise<{ data: TRow[]; count: number }>,
    emptyFilters: F,
  ): SortListProbe =>
  async (db, sorts) => {
    const { data, count } = await fn(db, emptyFilters, sorts, PAGE);
    return { rows: data.map((row) => sortRowSchema.parse(row)), count };
  };

const SORT_GUARDS = {
  expense: {
    fields: expenseSortableFields,
    list: sortListFor(expenseList, {}),
  },
  financialAccount: {
    fields: financialAccountSortableFields,
    list: sortListFor(listFinancialAccounts, {}),
  },
  financialTransaction: {
    fields: financialTransactionSortableFields,
    list: sortListFor(listFinancialTransactions, {}),
  },
  image: { fields: imageSortableFields, list: sortListFor(imageList, {}) },
  ingredient: {
    fields: ingredientSortableFields,
    list: sortListFor(ingredientList, {}),
  },
  inventory: {
    fields: inventorySortableFields,
    list: sortListFor(inventoryentryList, {}),
  },
  location: {
    fields: locationSortableFields,
    list: sortListFor(locationList, {}),
  },
  ledgerParty: {
    fields: ledgerPartySortableFields,
    list: sortListFor(listLedgerParties, {}),
  },
  ledgerTransfer: {
    fields: ledgerTransferSortableFields,
    list: sortListFor(listLedgerTransfers, {}),
  },
  meal: { fields: mealSortableFields, list: sortListFor(mealList, {}) },
  product: {
    fields: productSortableFields,
    list: sortListFor(productList, {}),
  },
  project: {
    fields: projectSortableFields,
    list: sortListFor(projectList, {}),
  },
  purchase: {
    fields: purchaseSortableFields,
    list: sortListFor(purchaseList, {}),
  },
  recipe: { fields: recipeSortableFields, list: sortListFor(recipeList, {}) },
  task: { fields: taskSortableFields, list: sortListFor(taskList, {}) },
  vendor: { fields: vendorSortableFields, list: sortListFor(vendorList, {}) },
  wish: { fields: wishSortableFields, list: sortListFor(wishList, {}) },
} satisfies Partial<
  Record<Entity, { fields: readonly string[]; list: SortListProbe }>
>;

type SortGuardedEntity = keyof typeof SORT_GUARDS;
const isSortGuardedEntity = (value: string): value is SortGuardedEntity =>
  value in SORT_GUARDS;
const SORT_GUARDED_ENTITIES =
  Object.keys(SORT_GUARDS).filter(isSortGuardedEntity);

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
   * Scan conventional entity exports so newly declared sorts require a guard.
   * `usdaFood`, `statementRow`, and the narrower `locationPicker` intentionally
   * fail entity parsing and remain outside this repository-list contract.
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
    if (entity === undefined || !isSortGuardedEntity(entity)) return false;
    const guard = SORT_GUARDS[entity];
    return guard?.fields.some((candidate) => candidate === field) ?? false;
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
