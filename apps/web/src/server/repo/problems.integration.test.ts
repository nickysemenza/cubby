import type {
  FinancialAccountId,
  LocationId,
  ProductId,
  ProjectShortcode,
  PurchaseShortcode,
} from "@cubby/schemas/identifiers";
import { unsafePurchaseId } from "@cubby/schemas/identifiers";
import { PDF_CONTENT_TYPE } from "@cubby/schemas/image";
import { mealCreateInput } from "@cubby/schemas/meal";
import {
  countProblems,
  PROBLEM_CLASS,
  sumProblemSections,
} from "@cubby/schemas/problems";
import {
  type ExpenseCreateInput,
  expenseCreateInput,
  projectCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import { purchaseUpdateInput } from "@cubby/schemas/purchase";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import type { UPCLookupResponse } from "@cubby/upc-contract";
import type { FoodSummary } from "@cubby/usda-schemas";
import { eq } from "drizzle-orm";
import { insertSettlementTransaction } from "tooling/settlement-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { viewProblemDeclarations } from "~/entities/view-manifest";
import { householdDaysAgo, householdDaysFromNow } from "~/lib/household-date";
import { VENDOR_LOGO_BY_SHORTCODE } from "~/lib/vendor-logos.generated";
import type { UPCLookupClient } from "~/server/clients/upc-lookup";
import type { USDAClient } from "~/server/clients/usda";
import {
  financialTransaction,
  image,
  inventoryEntry,
  location as locationTable,
  product,
  productImage,
  projectToolUsage,
  vendor as vendorTable,
} from "~/server/db/schema";
import { findViewProblems } from "../services/problem-views.service";
import {
  findAllProblems,
  findFastProblems,
  findTrackerProblems,
  reparseStaleIngredientParses,
} from "../services/problems.service";
import { getDb } from "./database-helpers";
import { createExpense, deleteExpenses } from "./expense";
import { createIngredient, getIngredientByName } from "./ingredient";
import { deleteInventoryEntries, inventoryentryList } from "./inventory";
import { ensureGlobalUnknownLocation } from "./location";
import { addRecipeToMeal, updateMeal } from "./meal";
import { findCoverageTotals, findStaleIngredientParses } from "./problems";
import { deleteProducts, updateProduct } from "./product";
import { createProject, deleteProjects } from "./project";
import { detachProjectResources } from "./project/tools";
import { updatePurchase } from "./purchase";
import { deleteRecipes } from "./recipe";
import {
  createInventoryFixture as createInventoryEntry,
  createLocationFixture as createLocation,
  createMealFixture,
  createProductFixture as createProduct,
  createRecipeFixture as createRecipe,
  ingredientRef,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
  makeRecipeInput,
} from "./repo.fixtures";
import { resolveLiveShortcode } from "./shortcode-resolver";
import { insertWithShortcode } from "./shortcode-utils";
import { createTask, deleteTasks } from "./task";
import { findOrCreateVendor, getVendorByID, mergeVendors } from "./vendor";

/**
 * The ledger repos hand back `{ output, entityId }` — the uuid is for audit and
 * side-effect bookkeeping. These tests assert on the public shape.
 */
const unwrap = async <T>(p: Promise<{ output: T }>): Promise<T> =>
  (await p).output;

// Repo-layer tests for the WASM-driven, highest-logic problem scans. The
// coverage/UPC find* helpers are exercised through the public findAllProblems
// aggregator; the stale-parse detector (now a Settings → Maintenance action, off
// the aggregator) and reparseStaleIngredientParses are called directly.

// reparseStaleIngredientParses streams `{done,total}` progress and returns its
// summary; drain to the return value for assertions.
const drainGen = async <R>(gen: AsyncGenerator<unknown, R>): Promise<R> => {
  let next = await gen.next();
  while (!next.done) next = await gen.next();
  return next.value;
};

// Build a full UPCLookupResponse from a partial — only the fields a scan reads
// (manufacturer/brand/priceDollars/imageUrl) usually matter per test.
const upcResponse = (
  upc: string,
  overrides: Partial<UPCLookupResponse> = {},
): UPCLookupResponse => ({
  upc,
  name: "Looked Up Product",
  manufacturer: null,
  brand: null,
  category: null,
  description: null,
  priceDollars: null,
  imageUrl: null,
  source: "upcitemdb" as UPCLookupResponse["source"],
  cached: false,
  ...overrides,
});

// A fake UPC lookup client: canned responses keyed by UPC, plus a record of which
// UPCs were actually looked up (so tests can assert the no-network pre-filter).
// The scan calls `lookupBatch` (one bulk request), so `calls` records every UPC
// passed to it — fully-populated/misc products are pre-filtered out beforehand.
const fakeUpcClient = (
  byUpc: Record<string, UPCLookupResponse | null> = {},
) => {
  const calls: string[] = [];
  const client = {
    lookupBatch: async (upcs: string[]) => {
      calls.push(...upcs);
      const result = new Map<string, UPCLookupResponse>();
      for (const upc of upcs) {
        const hit = byUpc[upc];
        if (hit) result.set(upc, hit);
      }
      return result;
    },
  } as unknown as UPCLookupClient;
  return { client, calls };
};

// USDA client stub. `findFoodsBatch` is the only method batchEnrichWithFood
// touches; it returns the supplied foods positionally (one per valid lookup;
// null = no link / no match). The default empty list means "no USDA data".
const fakeUsdaClient = (foods: (FoodSummary | null)[] = []) =>
  ({
    findFoodsBatch: async (lookups: unknown[]) =>
      lookups.map((_, i) => foods[i] ?? null),
  }) as unknown as USDAClient;

describe("problems repo", () => {
  const ctx = withTestDb();

  // A recipe whose single ingredient row stores `amounts`/`rawLine`; a mismatch
  // between rawLine's fresh parse and the stored amounts is parse drift.
  const recipeWithRow = (
    name: string,
    ingredientId: string,
    opts: { amounts: { value: number; unit: string }[]; rawLine: string },
  ) =>
    createRecipe(
      ctx.db,
      makeRecipeInput({
        name,
        sections: [
          {
            instructions: [{ instruction: "Mix" }],
            ingredients: [ingredientRef(ingredientId, opts)],
          },
        ],
      }),
      ctx.actor,
    );

  describe("findStaleIngredientParses", () => {
    it("flags a row whose stored parse drifted and leaves a matching row alone", async () => {
      const flour = await createIngredient(
        ctx.db,
        { name: "flour", aliases: [] },
        ctx.actor,
      );

      // Drift: rawLine parses to 2 cup, but 99 cup is stored.
      const drifted = await recipeWithRow("Drifted", flour.id, {
        amounts: [{ value: 99, unit: "cup" }],
        rawLine: "2 cups flour",
      });
      // No drift: stored amounts match the fresh parse.
      const clean = await recipeWithRow("Clean", flour.id, {
        amounts: [{ value: 2, unit: "cup" }],
        rawLine: "2 cups flour",
      });

      const staleIngredientParses = await findStaleIngredientParses(ctx.db);
      const driftedEntry = staleIngredientParses.find(
        (s) => s.recipeId === drifted.id,
      );
      expect(driftedEntry).toBeDefined();
      expect(driftedEntry?.amountDrift).toBe(true);
      expect(driftedEntry?.nameDrift).toBe(false);
      expect(staleIngredientParses.some((s) => s.recipeId === clean.id)).toBe(
        false,
      );
    });
  });

  describe("reparseStaleIngredientParses", () => {
    it("re-parses drifted amounts, marks the recipe affected, and is idempotent", async () => {
      const flour = await createIngredient(
        ctx.db,
        { name: "flour", aliases: [] },
        ctx.actor,
      );
      const recipe = await recipeWithRow("Reparse", flour.id, {
        amounts: [{ value: 99, unit: "cup" }],
        rawLine: "2 cups flour",
      });

      const result = await drainGen(reparseStaleIngredientParses(ctx.db));
      expect(result.updated).toBeGreaterThanOrEqual(1);
      expect(result.recipesAffected).toContain(recipe.entityId);

      // The drift is gone, and a second run finds nothing.
      const staleIngredientParses = await findStaleIngredientParses(ctx.db);
      expect(staleIngredientParses.some((s) => s.recipeId === recipe.id)).toBe(
        false,
      );
      expect(
        (await drainGen(reparseStaleIngredientParses(ctx.db))).updated,
      ).toBe(0);
    });

    it("find-or-creates the ingredient when the parsed name drifted", async () => {
      // Stored name "flour" but the raw line parses to "sugar" → name drift.
      const flour = await createIngredient(
        ctx.db,
        { name: "flour", aliases: [] },
        ctx.actor,
      );
      await recipeWithRow("NameDrift", flour.id, {
        amounts: [{ value: 2, unit: "cup" }],
        rawLine: "2 cups sugar",
      });

      await drainGen(reparseStaleIngredientParses(ctx.db));
      // The re-parse find-or-created the drifted-to ingredient.
      expect(await getIngredientByName(ctx.db, "sugar")).not.toBeNull();
    });
  });

  describe("findOrphanedProducts", () => {
    it("flags a product whose only inventory entry was soft-deleted", async () => {
      // The regression this guards: the EXISTS subquery used to omit
      // notDeleted(inventoryEntry), so a soft-deleted row still counted as
      // "has inventory" and the product stayed invisible. Emptying a shelf
      // soft-deletes rather than hard-deletes, so that was the common case —
      // it hid 18 of 20 genuinely-uninventoried products in production.
      const loc = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Orphan shelf" }),
        ctx.actor,
      );
      const emptied = await createProduct(
        ctx.db,
        makeProductInput({ name: "Emptied Product" }),
        ctx.actor,
      );
      const stocked = await createProduct(
        ctx.db,
        makeProductInput({ name: "Stocked Product" }),
        ctx.actor,
      );
      const entry = await createInventoryEntry(
        ctx.db,
        {
          productId: emptied.id,
          locationId: loc.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
      await createInventoryEntry(
        ctx.db,
        {
          productId: stocked.id,
          locationId: loc.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );

      // Live inventory on both — neither is orphaned yet.
      const before = await findAllProblems(
        ctx.db,
        fakeUpcClient().client,
        fakeUsdaClient(),
      );
      expect(before.orphanedProducts.some((p) => p.id === emptied.id)).toBe(
        false,
      );

      await deleteInventoryEntries(ctx.db, [entry.entityId], ctx.actor);

      const after = await findAllProblems(
        ctx.db,
        fakeUpcClient().client,
        fakeUsdaClient(),
      );
      expect(after.orphanedProducts.some((p) => p.id === emptied.id)).toBe(
        true,
      );
      // The still-stocked product must not be swept up.
      expect(after.orphanedProducts.some((p) => p.id === stocked.id)).toBe(
        false,
      );
    });

    it("does not flag a product with no inventory but a live expense, and flags it once the expense is soft-deleted", async () => {
      // The regression this guards: omitting the `expense` subquery made 32 of
      // 40 flagged "orphans" false positives — a tool bought and logged in the
      // ledger, then never inventoried, looks exactly like one that was never
      // real. Inventory and expense are Product's two acquisition edges, so
      // both must be checked before calling something orphaned.
      const bought = await createProduct(
        ctx.db,
        makeProductInput({ name: "Bought Not Yet Stocked" }),
        ctx.actor,
      );
      const { output: expense } = await createExpense(
        ctx.db,
        expenseCreateInput.parse({
          date: "2024-01-15",
          trade: "other",
          costType: "tools",
          name: "orphan-guard expense",
          productId: bought.id,
        }),
        ctx.actor,
      );

      // A live expense disqualifies it — not orphaned yet.
      const before = await findAllProblems(
        ctx.db,
        fakeUpcClient().client,
        fakeUsdaClient(),
      );
      expect(before.orphanedProducts.some((p) => p.id === bought.id)).toBe(
        false,
      );

      await deleteExpenses(ctx.db, [expense.id], ctx.actor);

      // With the expense gone (and still no inventory), it's orphaned.
      const after = await findAllProblems(
        ctx.db,
        fakeUpcClient().client,
        fakeUsdaClient(),
      );
      expect(after.orphanedProducts.some((p) => p.id === bought.id)).toBe(true);
    });

    it("does not flag a product used as a live task subject, and flags it once the task is deleted", async () => {
      const maintained = await createProduct(
        ctx.db,
        makeProductInput({ name: "Maintained Furnace" }),
        ctx.actor,
      );
      const { output: task } = await createTask(
        ctx.db,
        taskCreateInput.parse({
          name: "Replace furnace filter",
          trade: "mechanical",
          subjectProductId: maintained.id,
        }),
        ctx.actor,
      );

      const before = await findAllProblems(
        ctx.db,
        fakeUpcClient().client,
        fakeUsdaClient(),
      );
      expect(before.orphanedProducts.some((p) => p.id === maintained.id)).toBe(
        false,
      );

      await deleteTasks(ctx.db, [task.id], ctx.actor);

      const after = await findAllProblems(
        ctx.db,
        fakeUpcClient().client,
        fakeUsdaClient(),
      );
      expect(after.orphanedProducts.some((p) => p.id === maintained.id)).toBe(
        true,
      );
    });
  });

  describe("stocked products with no price (saved-view backed)", () => {
    it("flags stocked unpriced products, partitions misc buckets, and ignores priced or unstocked ones", async () => {
      const loc = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Valuation shelf" }),
        ctx.actor,
      );
      const unpriced = await createProduct(
        ctx.db,
        makeProductInput({ name: "Unpriced Stocked Tool", price: null }),
        ctx.actor,
      );
      const priced = await createProduct(
        ctx.db,
        makeProductInput({ name: "Priced Stocked Tool", price: 42 }),
        ctx.actor,
      );
      // A `misc:` pile is a heterogeneous bucket with no meaningful unit price,
      // so it belongs in the informational section, not the actionable one.
      const bucket = await createProduct(
        ctx.db,
        makeProductInput({ name: "misc: assorted clamps", price: null }),
        ctx.actor,
      );
      // Unpriced but not stocked — contributes to no rollup, so not a problem
      // here (findOrphanedProducts already covers it).
      const unstocked = await createProduct(
        ctx.db,
        makeProductInput({ name: "Unpriced Unstocked Tool", price: null }),
        ctx.actor,
      );

      const unpricedEntry = await createInventoryEntry(
        ctx.db,
        {
          productId: unpriced.id,
          locationId: loc.id,
          amount: { value: 3, unit: "each" },
        },
        ctx.actor,
      );
      for (const productId of [priced.id, bucket.id]) {
        await createInventoryEntry(
          ctx.db,
          { productId, locationId: loc.id, amount: { value: 1, unit: "each" } },
          ctx.actor,
        );
      }

      const found = await findViewProblems(ctx.db);

      const flagged = found.productsMissingPrice.find(
        (p) => p.id === unpriced.id,
      );
      expect(flagged).toBeDefined();
      // Quantity is summed across live entries so the card can say how much
      // value is going unrecorded.
      expect(flagged?.inventoryQuantity).toBe(3);
      expect(flagged?.locations.map((l) => l.id)).toEqual([loc.id]);

      // A price, no inventory, or misc-bucket status each keep it out.
      for (const id of [priced.id, bucket.id, unstocked.id]) {
        expect(found.productsMissingPrice.some((p) => p.id === id)).toBe(false);
      }
      expect(found.unvaluedBucketProducts.some((p) => p.id === bucket.id)).toBe(
        true,
      );
      expect(
        found.unvaluedBucketProducts.some((p) => p.id === unstocked.id),
      ).toBe(false);

      // Soft-deleting the only entry un-stocks it, so it drops out of both.
      await deleteInventoryEntries(ctx.db, [unpricedEntry.entityId], ctx.actor);
      const after = await findViewProblems(ctx.db);
      expect(after.productsMissingPrice.some((p) => p.id === unpriced.id)).toBe(
        false,
      );
      expect(
        after.unvaluedBucketProducts.some((p) => p.id === unpriced.id),
      ).toBe(false);
    });
  });

  describe("findSoldButStillStocked", () => {
    // Seed through the real door: `createExpense` resolves vendor + orderId into
    // a Purchase, and it is that Purchase's net sign — not the sign of any one
    // line — that makes a disposal.
    const seedLine = (overrides: Partial<ExpenseCreateInput>) =>
      unwrap(
        createExpense(
          ctx.db,
          expenseCreateInput.parse(makeExpenseInput(overrides)),
          ctx.actor,
        ),
      );

    it("flags a fully-disposed stocked product, sparing partial sales and refunds on ordinary purchases", async () => {
      const loc = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Disposal shelf" }),
        ctx.actor,
      );
      const sold = await createProduct(
        ctx.db,
        makeProductInput({ name: "Sold Off Track Saw", price: 400 }),
        ctx.actor,
      );
      // Sold 4 of 14 — the remaining 10 are legitimately stocked.
      const partial = await createProduct(
        ctx.db,
        makeProductInput({ name: "Parts Bin Case", price: 10 }),
        ctx.actor,
      );
      // A negative line on a net-POSITIVE purchase: a partial refund, not a
      // disposal. This is the case the naive "any negative line" predicate got
      // wrong about half the time on production data.
      const refunded = await createProduct(
        ctx.db,
        makeProductInput({ name: "Partly Refunded Sander", price: 100 }),
        ctx.actor,
      );

      const soldEntry = await createInventoryEntry(
        ctx.db,
        {
          productId: sold.id,
          locationId: loc.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
      await createInventoryEntry(
        ctx.db,
        {
          productId: partial.id,
          locationId: loc.id,
          amount: { value: 10, unit: "each" },
        },
        ctx.actor,
      );
      await createInventoryEntry(
        ctx.db,
        {
          productId: refunded.id,
          locationId: loc.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );

      await seedLine({
        name: "track saw sold",
        cost: -320,
        vendor: "eBay",
        orderId: "SALE-1",
        productId: sold.id,
        productQuantity: -1,
      });
      await seedLine({
        name: "four bins sold",
        cost: -8.93,
        vendor: "eBay",
        orderId: "SALE-2",
        productId: partial.id,
        productQuantity: -4,
      });
      await seedLine({
        name: "sander",
        cost: 260,
        vendor: "Festool",
        orderId: "BUY-1",
        productId: refunded.id,
        productQuantity: 1,
      });
      await seedLine({
        name: "sander partial refund",
        cost: -60,
        vendor: "Festool",
        orderId: "BUY-1",
        productId: refunded.id,
      });

      const found = await findFastProblems(ctx.db);

      const flagged = found.soldButStillStocked.find((p) => p.id === sold.id);
      expect(flagged).toBeDefined();
      expect(flagged?.soldQuantity).toBe(1);
      expect(flagged?.liveQuantity).toBe(1);
      // Stored as the ledger stores it — negative, because it is a disposal.
      expect(flagged?.proceeds).toBe(-320);
      expect(flagged?.locations.map((l) => l.id)).toEqual([loc.id]);

      // Rule 2: a partial sale leaves real stock behind.
      expect(found.soldButStillStocked.some((p) => p.id === partial.id)).toBe(
        false,
      );
      // Rule 1: the refund sits on a purchase that nets +$200, so it is not a
      // disposal at all.
      expect(found.soldButStillStocked.some((p) => p.id === refunded.id)).toBe(
        false,
      );

      // Clearing the stale shelf is the fix, and it resolves the row.
      await deleteInventoryEntries(ctx.db, [soldEntry.entityId], ctx.actor);
      const after = await findFastProblems(ctx.db);
      expect(after.soldButStillStocked.some((p) => p.id === sold.id)).toBe(
        false,
      );
    });

    it("reports a positive sold quantity even when the disposal stores a negative one", async () => {
      const loc = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Signed disposal shelf" }),
        ctx.actor,
      );
      const prod = await createProduct(
        ctx.db,
        makeProductInput({ name: "Signed Disposal Router", price: 200 }),
        ctx.actor,
      );
      await createInventoryEntry(
        ctx.db,
        {
          productId: prod.entityId,
          locationId: loc.entityId,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
      // `productQuantity` is signed, and a negative-cost line is read as
      // `−|qty|` — so BOTH stored signs are legal on a disposal. Without the
      // `abs()` in the detector this row makes `soldQuantity` negative, which
      // silently fails the `soldQuantity >= liveQuantity` comparison (the
      // product drops off the list entirely) and would render "sold -1".
      await seedLine({
        name: "router sold",
        cost: -150,
        vendor: "eBay",
        orderId: "SIGNED-SALE",
        productId: prod.id,
        productQuantity: -1,
      });

      const found = await findFastProblems(ctx.db);
      const flagged = found.soldButStillStocked.find((p) => p.id === prod.id);
      expect(flagged?.soldQuantity).toBe(1);
    });
  });

  describe("findUnlinkedExitExpenses", () => {
    const seedLine = (overrides: Partial<ExpenseCreateInput>) =>
      unwrap(
        createExpense(
          ctx.db,
          expenseCreateInput.parse(makeExpenseInput(overrides)),
          ctx.actor,
        ),
      );

    it("flags a productless disposal line and spares a refund on an ordinary purchase", async () => {
      const linked = await createProduct(
        ctx.db,
        makeProductInput({ name: "Linked Sold Drill", price: 90 }),
        ctx.actor,
      );

      // The defect: a sale with nothing naming what left. Invisible to
      // findSoldButStillStocked, which groups by productId.
      const unlinked = await seedLine({
        name: "ebay payout - unknown item",
        cost: -140,
        vendor: "eBay",
        orderId: "UNLINKED-SALE",
        productId: null,
      });
      // Same purchase shape, but linked — the mirror detector's territory, not
      // this one's.
      await seedLine({
        name: "drill sold",
        cost: -90,
        vendor: "eBay",
        orderId: "LINKED-SALE",
        productId: linked.id,
        productQuantity: -1,
      });
      // THE false positive this predicate exists to avoid. A negative line with
      // no product, sitting on a purchase that nets POSITIVE: a refund, a price
      // adjustment, a family contribution. On production these outnumber real
      // disposals, and keying on bare negative lines was wrong about half the
      // time.
      await seedLine({
        name: "lumber",
        cost: 300,
        vendor: "Golden State Lumber",
        orderId: "REFUND-CASE",
        productId: null,
      });
      await seedLine({
        name: "lumber overcharge refunded",
        cost: -45,
        vendor: "Golden State Lumber",
        orderId: "REFUND-CASE",
        productId: null,
      });

      const found = await findFastProblems(ctx.db);
      const ids = found.unlinkedExitExpenses.map((row) => row.id);

      expect(ids).toContain(unlinked.id);
      expect(found.unlinkedExitExpenses).toContainEqual(
        expect.objectContaining({
          id: unlinked.id,
          cost: -140,
          vendorName: "eBay",
        }),
      );
      // Not a disposal — the purchase nets +$255.
      expect(
        found.unlinkedExitExpenses.some(
          (row) => row.name === "lumber overcharge refunded",
        ),
      ).toBe(false);
      // Linked sales belong to the mirror detector.
      expect(
        found.unlinkedExitExpenses.some((row) => row.name === "drill sold"),
      ).toBe(false);
    });
  });

  describe("findPurchaselessExitExpenses", () => {
    const seedLine = (overrides: Partial<ExpenseCreateInput>) =>
      unwrap(
        createExpense(
          ctx.db,
          expenseCreateInput.parse(makeExpenseInput(overrides)),
          ctx.actor,
        ),
      );

    it("flags a credit with no order and leaves the mirror detector's rows alone", async () => {
      // The defect: an item handed over for cash. No vendor, no order, so no
      // Purchase — which is why findUnlinkedExitExpenses' innerJoin cannot see
      // it however the disposal predicate is tuned.
      const cashSale = await seedLine({
        name: "old walking pad",
        cost: -100,
        vendor: null,
        orderId: null,
        productId: null,
      });
      // The tolerated false positive, seeded on purpose: money that never
      // bought anything looks identical on the row. It is reported too, and the
      // coverage class is what makes that honest rather than wrong.
      const contribution = await seedLine({
        name: "neighbour's share of the tree removal",
        cost: -2000,
        costType: "services",
        vendor: null,
        orderId: null,
        productId: null,
      });
      // Has a Purchase, so it belongs to findUnlinkedExitExpenses, not here.
      await seedLine({
        name: "ebay payout - unknown item",
        cost: -140,
        vendor: "eBay",
        orderId: "PURCHASELESS-MIRROR",
        productId: null,
      });
      // An adjustment is productless by definition, not by omission. Without
      // the lineKind filter this row would be reported as a missing link.
      await seedLine({
        name: "ProXtra savings",
        cost: -20,
        lineKind: "discount",
        vendor: null,
        orderId: null,
        productId: null,
      });
      // Purchase-less but POSITIVE — an ordinary hand-entered spend line.
      await seedLine({
        name: "cash for gravel",
        cost: 60,
        vendor: null,
        orderId: null,
        productId: null,
      });
      // Planned, not banked. This one matters on live data: the largest
      // purchase-less credits in the ledger are future-dated, so without the
      // `future = false` filter they would dominate the list with money that
      // has not moved.
      await seedLine({
        name: "expected contribution",
        cost: -5000,
        future: true,
        vendor: null,
        orderId: null,
        productId: null,
      });

      const found = await findFastProblems(ctx.db);
      const ids = found.purchaselessExitExpenses.map((row) => row.id);

      expect(ids).toContain(cashSale.id);
      expect(ids).toContain(contribution.id);
      expect(found.purchaselessExitExpenses).toContainEqual(
        expect.objectContaining({ id: cashSale.id, cost: -100 }),
      );
      // Belongs to the mirror detector — it has a Purchase.
      expect(
        found.purchaselessExitExpenses.some(
          (row) => row.name === "ebay payout - unknown item",
        ),
      ).toBe(false);
      expect(
        found.purchaselessExitExpenses.some(
          (row) => row.name === "ProXtra savings",
        ),
      ).toBe(false);
      expect(
        found.purchaselessExitExpenses.some(
          (row) => row.name === "cash for gravel",
        ),
      ).toBe(false);
      expect(
        found.purchaselessExitExpenses.some(
          (row) => row.name === "expected contribution",
        ),
      ).toBe(false);
    });
  });

  describe("negative expected quantity (saved-view backed)", () => {
    const seedLine = (overrides: Partial<ExpenseCreateInput>) =>
      unwrap(
        createExpense(
          ctx.db,
          expenseCreateInput.parse(makeExpenseInput(overrides)),
          ctx.actor,
        ),
      );

    it("flags a product with more units gone than acquired, and spares a balanced one", async () => {
      const unbalanced = await createProduct(
        ctx.db,
        makeProductInput({ name: "Ghost Circular Saw", price: 60 }),
        ctx.actor,
      );
      const balanced = await createProduct(
        ctx.db,
        makeProductInput({ name: "Balanced Outlet Box", price: 4 }),
        ctx.actor,
      );

      // The acquisition was never recorded, so the sale has nothing to net
      // against — the exact defect this detector exists to surface.
      await seedLine({
        name: "saw sold",
        cost: -60,
        productId: unbalanced.id,
        productQuantity: -1,
      });
      // Bought 8, returned 8. A return is a real exit, so this nets to zero —
      // and it sits on a Purchase that nets POSITIVE, which is why
      // `findSoldButStillStocked`'s stricter predicate would miss it entirely.
      await seedLine({
        name: "boxes bought",
        cost: 33.44,
        vendor: "Home Depot",
        orderId: "BOX-1",
        productId: balanced.id,
        productQuantity: 8,
      });
      await seedLine({
        name: "boxes returned",
        cost: -30,
        vendor: "Home Depot",
        orderId: "BOX-1",
        productId: balanced.id,
        productQuantity: -8,
      });

      const found = await findViewProblems(ctx.db);
      const flagged = found.negativeExpectedQuantity.find(
        (p) => p.id === unbalanced.id,
      );
      expect(flagged).toMatchObject({
        expectedQuantity: -1,
        acquiredUnits: 0,
        exitedUnits: 1,
        unknownAcquisitionLines: 0,
        unknownExitLines: 0,
      });
      expect(
        found.negativeExpectedQuantity.some((p) => p.id === balanced.id),
      ).toBe(false);

      // Recording the missing acquisition is the fix, and it clears the row.
      await seedLine({
        name: "saw bought",
        cost: 200,
        productId: unbalanced.id,
        productQuantity: 1,
      });
      const after = await findViewProblems(ctx.db);
      expect(
        after.negativeExpectedQuantity.some((p) => p.id === unbalanced.id),
      ).toBe(false);
    });

    it("counts a disposal line with no quantity as one unit", async () => {
      const loc = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Bare-sale shelf" }),
        ctx.actor,
      );
      const bare = await createProduct(
        ctx.db,
        makeProductInput({ name: "Bare Sale Pallet Jack", price: 200 }),
        ctx.actor,
      );
      await createInventoryEntry(
        ctx.db,
        {
          productId: bare.id,
          locationId: loc.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
      // No productQuantity — the common shape for a hand-entered sale row.
      await seedLine({
        name: "pallet jack sold",
        cost: -120,
        vendor: "Craigslist",
        orderId: "SALE-BARE",
        productId: bare.id,
      });

      const { soldButStillStocked } = await findFastProblems(ctx.db);
      const flagged = soldButStillStocked.find((p) => p.id === bare.id);
      expect(flagged).toBeDefined();
      expect(flagged?.soldQuantity).toBe(1);
    });

    it("spares a product re-acquired after its last exit", async () => {
      const loc = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Rebought shelf" }),
        ctx.actor,
      );
      const rebought = await createProduct(
        ctx.db,
        makeProductInput({ name: "Sold Then Rebought Grinder", price: 90 }),
        ctx.actor,
      );
      await createInventoryEntry(
        ctx.db,
        {
          productId: rebought.id,
          locationId: loc.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );

      await seedLine({
        name: "grinder bought",
        cost: 90,
        date: "2024-01-10",
        vendor: "eBay",
        orderId: "REBUY-BUY-1",
        productId: rebought.id,
        productQuantity: 1,
      });
      await seedLine({
        name: "grinder sold",
        cost: -50,
        date: "2024-06-01",
        vendor: "eBay",
        orderId: "REBUY-SALE",
        productId: rebought.id,
        productQuantity: -1,
      });

      // Sold and nothing since — the shelf entry is stale, so it reports.
      const during = await findFastProblems(ctx.db);
      expect(during.soldButStillStocked.some((p) => p.id === rebought.id)).toBe(
        true,
      );

      // Bought again afterwards: ownership reopened, so the entry on the shelf
      // is this acquisition rather than the leftover.
      await seedLine({
        name: "grinder bought again",
        cost: 95,
        date: "2024-09-15",
        vendor: "eBay",
        orderId: "REBUY-BUY-2",
        productId: rebought.id,
        productQuantity: 1,
      });

      const after = await findFastProblems(ctx.db);
      expect(after.soldButStillStocked.some((p) => p.id === rebought.id)).toBe(
        false,
      );
    });
  });

  describe("findToolsUsedOutsideOwnership", () => {
    it("flags a recorded use that predates the tool, and clears once detached", async () => {
      // The live Kitchen Remodel shape: explicit end 2022-06-30, tool first
      // acquired well after. These edges were created before the ownership gate
      // existed, so only a detector can surface them.
      const { output: finished, entityId: finishedId } = await createProject(
        ctx.db,
        projectCreateInput.parse({
          name: "Closed reno",
          status: "done",
          startDate: "2022-01-01",
          endDate: "2022-06-30",
        }),
        ctx.actor,
      );
      const { output: ledger } = await createProject(
        ctx.db,
        projectCreateInput.parse({ name: "Ledger home" }),
        ctx.actor,
      );

      const late = await createProduct(
        ctx.db,
        makeProductInput({ name: "Anachronistic Press", category: "tools" }),
        ctx.actor,
      );
      const fine = await createProduct(
        ctx.db,
        makeProductInput({ name: "Contemporary Level", category: "tools" }),
        ctx.actor,
      );
      const undated = await createProduct(
        ctx.db,
        makeProductInput({ name: "Ledgerless Chisel", category: "tools" }),
        ctx.actor,
      );
      for (const row of [
        { product: late, date: "2024-03-01" },
        { product: fine, date: "2022-02-01" },
      ]) {
        await createExpense(
          ctx.db,
          expenseCreateInput.parse(
            makeExpenseInput({
              name: row.product.name,
              projectId: ledger.id,
              productId: row.product.id,
              costType: "tools",
              cost: 250,
              date: row.date,
            }),
          ),
          ctx.actor,
        );
      }

      // Straight to the table: the write path now refuses exactly this, which
      // is the point — these rows can only pre-date the gate.
      await getDb(ctx.db)
        .insert(projectToolUsage)
        .values([
          { projectId: finishedId, productId: late.entityId },
          { projectId: finishedId, productId: fine.entityId },
          { projectId: finishedId, productId: undated.entityId },
        ]);

      const found = await findFastProblems(ctx.db);
      const rows = found.toolsUsedOutsideOwnership.filter(
        (row) => row.projectName === "Closed reno",
      );
      expect(rows).toEqual([
        {
          id: late.id,
          name: "Anachronistic Press",
          manufacturer: expect.any(String),
          projectId: finished.id,
          projectName: "Closed reno",
          conflict: "acquired_after_end",
          toolDate: "2024-03-01",
          projectBoundary: "2022-06-30",
        },
      ]);

      await detachProjectResources(
        ctx.db,
        finishedId,
        [late.entityId],
        ctx.actor,
      );
      const after = await findFastProblems(ctx.db);
      expect(
        after.toolsUsedOutsideOwnership.some((row) => row.id === late.id),
      ).toBe(false);
    });
  });

  describe("findProductsWithIslandedMappings", () => {
    it("flags a product whose mappings form 2+ islands but not a connected one", async () => {
      // widget↔gadget are custom units unreachable from the standard unit graph,
      // so they island off from cup↔g.
      const islanded = await createProduct(
        ctx.db,
        makeProductInput({
          name: "Islanded Product",
          unitMappings: [
            {
              a: { value: 1, unit: "cup" },
              b: { value: 120, unit: "g" },
              source: null,
            },
            {
              a: { value: 1, unit: "widget" },
              b: { value: 3, unit: "gadget" },
              source: null,
            },
          ],
        }),
        ctx.actor,
      );
      // cup↔g and tsp↔ml all sit in the one connected standard graph.
      const connected = await createProduct(
        ctx.db,
        makeProductInput({
          name: "Connected Product",
          unitMappings: [
            {
              a: { value: 1, unit: "cup" },
              b: { value: 120, unit: "g" },
              source: null,
            },
            {
              a: { value: 1, unit: "tsp" },
              b: { value: 5, unit: "ml" },
              source: null,
            },
          ],
        }),
        ctx.actor,
      );

      const { productsWithIslandedMappings } = await findAllProblems(
        ctx.db,
        fakeUpcClient().client,
        fakeUsdaClient(),
      );
      const flagged = productsWithIslandedMappings.find(
        (p) => p.id === islanded.id,
      );
      expect(flagged).toBeDefined();
      expect(flagged!.islandCount).toBeGreaterThanOrEqual(2);
      expect(
        productsWithIslandedMappings.some((p) => p.id === connected.id),
      ).toBe(false);
    });

    it("does not flag a product whose USDA portion bridges the stored islands", async () => {
      // Mirrors "light brown sugar": its two STORED mappings island into
      // {cup packed, tsp, ml} (volume) and {g, cent} (weight/money), with no
      // stored edge between them. But its USDA link supplies a portion
      // (1 cup packed = 220 g) that bridges the two — so it's fully convertible
      // and must NOT be flagged. The detector now runs on effective mappings.
      const storedIslands = [
        // 1 cup packed = 1 cup → cup packed joins the volume cluster.
        {
          a: { value: 1, unit: "cup packed" },
          b: { value: 1, unit: "cup" },
          source: null,
        },
        // 2 lb = $5 → lb normalizes to g; the {g, cent} island.
        {
          a: { value: 2, unit: "lb" },
          b: { value: 5, unit: "dollar" },
          source: null,
        },
      ];
      // A USDA "Sugars, brown" food whose portion bridges cup packed ↔ g.
      const sugarFood: FoodSummary = {
        fdc_id: 168833,
        brandedFoodInfo: null,
        foodInfo: { data_type: "sr_legacy_food", description: "Sugars, brown" },
        legacyFoodInfo: { ndb_number: 19334 },
        nutritionInfo: { nutrientSummary: [], nutrientsPer100: {} },
        portionInfoRaw: [
          { amount: 1, modifier: "cup packed", gram_weight: 220 },
        ],
      };

      const product = await createProduct(
        ctx.db,
        makeProductInput({
          name: "USDA-bridged sugar",
          // The USDA link is what pulls in the bridging portion below; without an
          // fdc_id no lookup fires and the stored mappings island on their own.
          fdc_id: sugarFood.fdc_id,
          unitMappings: storedIslands,
        }),
        ctx.actor,
      );

      // Control: WITHOUT the USDA food, stored mappings alone island → flagged.
      const withoutFood = await findAllProblems(
        ctx.db,
        fakeUpcClient().client,
        fakeUsdaClient([null]),
      );
      expect(
        withoutFood.productsWithIslandedMappings.some(
          (p) => p.id === product.id,
        ),
      ).toBe(true);

      // With the bridging USDA portion, the product is one component → not flagged.
      const withFood = await findAllProblems(
        ctx.db,
        fakeUpcClient().client,
        fakeUsdaClient([sugarFood]),
      );
      expect(
        withFood.productsWithIslandedMappings.some((p) => p.id === product.id),
      ).toBe(false);
    });
  });

  describe("findProductsWithBetterUpcData", () => {
    // Valid UPC-A codes (12 digits) so the products clear the candidate query.
    const UPC_MANU = "012345678905";
    const UPC_PRICE = "036000291452";
    const UPC_IMAGE = "078000053258";
    const UPC_FULL = "022000004444";
    const UPC_MISC = "044000031091";

    const attachImage = async (productId: ProductId) => {
      const [img] = await getDb(ctx.db)
        .insert(image)
        .values({
          url: "https://example.com/i.jpg",
          key: `key-${productId}`,
          filename: "i.jpg",
          size: 1,
          contentType: "image/jpeg",
        })
        .returning();
      await getDb(ctx.db)
        .insert(productImage)
        .values({ productId, imageId: img!.id });
    };

    const attachPdf = async (productId: ProductId) => {
      const [img] = await getDb(ctx.db)
        .insert(image)
        .values({
          url: "https://example.com/manual.pdf",
          key: `pdf-key-${productId}`,
          filename: "manual.pdf",
          size: 1,
          contentType: PDF_CONTENT_TYPE,
        })
        .returning();
      await getDb(ctx.db)
        .insert(productImage)
        .values({ productId, imageId: img!.id });
    };

    it("flags each fillable gap and skips fully-populated products without a lookup", async () => {
      // (a) Unspecified manufacturer, but priced + imaged → only the manufacturer gap.
      const noManu = await createProduct(
        ctx.db,
        makeProductInput({ name: "No Manufacturer", upc: UPC_MANU }),
        ctx.actor,
      );
      await getDb(ctx.db)
        .update(product)
        .set({ manufacturer: UNSPECIFIED_MANUFACTURER, price: 5 })
        .where(eq(product.id, noManu.entityId));
      await attachImage(noManu.entityId);

      // (b) Has manufacturer + image, but no price → only the price gap.
      const noPrice = await createProduct(
        ctx.db,
        makeProductInput({ name: "No Price", upc: UPC_PRICE }),
        ctx.actor,
      );
      await attachImage(noPrice.entityId);

      // (c) Has manufacturer + price, but no image → only the image gap.
      const noImage = await createProduct(
        ctx.db,
        makeProductInput({ name: "No Image", upc: UPC_IMAGE }),
        ctx.actor,
      );
      await getDb(ctx.db)
        .update(product)
        .set({ price: 9 })
        .where(eq(product.id, noImage.entityId));

      // (d) Fully populated → not a candidate, must never be looked up.
      const full = await createProduct(
        ctx.db,
        makeProductInput({ name: "Full Product", upc: UPC_FULL }),
        ctx.actor,
      );
      await getDb(ctx.db)
        .update(product)
        .set({ price: 3 })
        .where(eq(product.id, full.entityId));
      await attachImage(full.entityId);

      // (e) Misc product with a manufacturer gap → excluded regardless.
      const misc = await createProduct(
        ctx.db,
        makeProductInput({ name: "misc: Loose Screw", upc: UPC_MISC }),
        ctx.actor,
      );
      await getDb(ctx.db)
        .update(product)
        .set({ manufacturer: UNSPECIFIED_MANUFACTURER, price: 1 })
        .where(eq(product.id, misc.entityId));
      await attachImage(misc.entityId);

      const { client, calls } = fakeUpcClient({
        [UPC_MANU]: upcResponse(UPC_MANU, { brand: "Acme" }),
        [UPC_PRICE]: upcResponse(UPC_PRICE, { priceDollars: 4.5 }),
        [UPC_IMAGE]: upcResponse(UPC_IMAGE, {
          imageUrl: "https://example.com/p.jpg",
        }),
        // A response for the full product would still be irrelevant — it must not be fetched.
        [UPC_FULL]: upcResponse(UPC_FULL, { brand: "Acme", priceDollars: 1 }),
      });

      const { productsWithBetterUpcData } = await findAllProblems(
        ctx.db,
        client,
        fakeUsdaClient(),
      );

      const byId = new Map(productsWithBetterUpcData.map((p) => [p.id, p]));

      // `proposed` carries the value each gap would be filled with (null = no
      // change). An absolute lookup image URL is returned unchanged.
      expect(byId.get(noManu.id)?.proposed).toEqual({
        manufacturer: "Acme",
        price: null,
        imageUrl: null,
      });
      expect(byId.get(noPrice.id)?.proposed).toEqual({
        manufacturer: null,
        price: 4.5,
        imageUrl: null,
      });
      expect(byId.get(noImage.id)?.proposed).toEqual({
        manufacturer: null,
        price: null,
        imageUrl: "https://example.com/p.jpg",
      });

      // Fully-populated and misc products are neither flagged nor looked up.
      expect(byId.has(full.id)).toBe(false);
      expect(byId.has(misc.id)).toBe(false);
      expect(calls).not.toContain(UPC_FULL);
      expect(calls).not.toContain(UPC_MISC);
    });

    it("does not flag a gap the lookup itself can't fill", async () => {
      // Missing price, but the lookup has no price either → nothing to re-import.
      const noPrice = await createProduct(
        ctx.db,
        makeProductInput({ name: "Still No Price", upc: UPC_PRICE }),
        ctx.actor,
      );
      await attachImage(noPrice.entityId);

      const { client } = fakeUpcClient({
        [UPC_PRICE]: upcResponse(UPC_PRICE), // all-null payload
      });

      const { productsWithBetterUpcData } = await findAllProblems(
        ctx.db,
        client,
        fakeUsdaClient(),
      );
      expect(productsWithBetterUpcData.some((p) => p.id === noPrice.id)).toBe(
        false,
      );
    });

    it("treats a PDF-only attachment as no real image, so it still surfaces as an image-gap candidate", async () => {
      // Regression: `hasImage` used to read true off ProductImage alone, so a
      // product whose only attachment was a PDF (an owner's manual, a spec
      // sheet) looked fully imaged and silently dropped out of the UPC-lookup
      // candidate list — it never got the chance to have a real photo filled
      // in. `hasImage` now inner-joins Image and excludes PDF_CONTENT_TYPE,
      // matching `productIdsWithImages` in product/crud.ts.
      const pdfOnly = await createProduct(
        ctx.db,
        makeProductInput({ name: "Manual Only Product", upc: UPC_IMAGE }),
        ctx.actor,
      );
      await getDb(ctx.db)
        .update(product)
        .set({ price: 9 })
        .where(eq(product.id, pdfOnly.entityId));
      await attachPdf(pdfOnly.entityId);

      const { client } = fakeUpcClient({
        [UPC_IMAGE]: upcResponse(UPC_IMAGE, {
          imageUrl: "https://example.com/real-photo.jpg",
        }),
      });

      const { productsWithBetterUpcData } = await findAllProblems(
        ctx.db,
        client,
        fakeUsdaClient(),
      );

      const flagged = productsWithBetterUpcData.find(
        (p) => p.id === pdfOnly.id,
      );
      expect(flagged).toBeDefined();
      expect(flagged?.proposed).toEqual({
        manufacturer: null,
        price: null,
        imageUrl: "https://example.com/real-photo.jpg",
      });
    });
  });
});

// The household-tracker slice of the Problems payload. Detection itself lives in
// repo/project/attention.ts (covered there); this asserts the service-layer
// split — that the flat attention list lands in the right per-rule slices, and
// that a removed project's rows don't leak into the always-on badge count.
describe("problems service — tracker slice", () => {
  const ctx = withTestDb();

  it("surfaces an overdue task and a past-due planned expense in their slices", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "tracker slice project",
        status: "in_progress",
      }),
      ctx.actor,
    );
    const { output: overdue } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "tracker overdue task",
        projectId: project.id,
        dueDate: householdDaysAgo(3),
      }),
      ctx.actor,
    );
    // Control: a task due in the future is not overdue.
    const { output: upcoming } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "tracker upcoming task",
        projectId: project.id,
        dueDate: householdDaysFromNow(3),
      }),
      ctx.actor,
    );
    const { output: pastDuePlanned } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "tracker past-due planned expense",
        projectId: project.id,
        cost: 250,
        future: true,
        date: householdDaysAgo(5),
      }),
      ctx.actor,
    );

    const tracker = await findTrackerProblems(ctx.db);

    expect(tracker.overdueTasks.map((i) => i.entityId)).toContain(overdue.id);
    expect(tracker.overdueTasks.map((i) => i.entityId)).not.toContain(
      upcoming.id,
    );
    expect(tracker.pastDuePlannedExpenses.map((i) => i.entityId)).toContain(
      pastDuePlanned.id,
    );
    // Rows carry the rule type + a route the Problems card can link to.
    expect(
      tracker.overdueTasks.find((i) => i.entityId === overdue.id),
    ).toMatchObject({ type: "overdue_task", entityType: "task" });
    expect(
      tracker.pastDuePlannedExpenses.find(
        (i) => i.entityId === pastDuePlanned.id,
      ),
    ).toMatchObject({
      type: "past_due_planned_expense",
      entityType: "expense",
    });
  });

  it("excludes rows belonging to a deleted project", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "tracker deleted project",
        status: "in_progress",
      }),
      ctx.actor,
    );
    const { output: task } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "tracker deleted overdue task",
        projectId: project.id,
        dueDate: householdDaysAgo(3),
      }),
      ctx.actor,
    );
    const { output: planned } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "tracker deleted planned expense",
        projectId: project.id,
        cost: 100,
        future: true,
        date: householdDaysAgo(5),
      }),
      ctx.actor,
    );

    // Sanity: they're flagged while live.
    const before = await findTrackerProblems(ctx.db);
    expect(before.overdueTasks.map((i) => i.entityId)).toContain(task.id);
    expect(before.pastDuePlannedExpenses.map((i) => i.entityId)).toContain(
      planned.id,
    );

    // A project can only be deleted once its tasks/expenses are (the delete
    // guards enforce that), so removing the project removes the whole subtree.
    await deleteTasks(ctx.db, [task.id], ctx.actor);
    await deleteExpenses(ctx.db, [planned.id], ctx.actor);
    await deleteProjects(ctx.db, [project.id], ctx.actor);

    const after = await findTrackerProblems(ctx.db);
    const everyEntityId = Object.values(after).flatMap((items) =>
      items.map((i) => i.entityId),
    );
    expect(everyEntityId).not.toContain(task.id);
    expect(everyEntityId).not.toContain(planned.id);
    expect(everyEntityId).not.toContain(project.id);
  });

  // A budget estimate is a FORECAST, so asking for one on finished work is
  // busywork that can never be satisfied meaningfully. This dominated the real
  // count: 29 of 32 flagged projects were `done` (a completed wedding, a
  // replaced furnace, a 2023 garden). `stalled_project` already scoped itself
  // to live projects; `missing_budget` simply didn't.
  it("asks for a budget only on live projects, not finished ones", async () => {
    const spend = async (projectId: ProjectShortcode, name: string) => {
      await createExpense(
        ctx.db,
        expenseCreateInput.parse({
          date: "2024-01-15",
          trade: "other",
          costType: "materials",
          name,
          projectId,
          cost: 500,
        }),
        ctx.actor,
      );
    };

    const { output: live } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "budget live project",
        status: "in_progress",
      }),
      ctx.actor,
    );
    const { output: finished } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "budget finished project",
        status: "done",
      }),
      ctx.actor,
    );
    // Both have spend and neither has a cost estimate — the only difference is
    // status, so status alone must decide.
    await spend(live.id, "budget live spend");
    await spend(finished.id, "budget finished spend");

    const tracker = await findTrackerProblems(ctx.db);
    const flagged = tracker.projectsMissingBudget.map((i) => i.entityId);

    expect(flagged).toContain(live.id);
    expect(flagged).not.toContain(finished.id);
  });
});

// The recount-staleness detectors (tenet 1: only a deliberate recount restores
// inventory truth). All three are cheap SQL in the `fast` group, so drive them
// through findFastProblems rather than the full findAllProblems scan.
describe("problems service — recount staleness", () => {
  const ctx = withTestDb();
  const amount = { value: 2, unit: "each" };
  const daysAgo = (days: number) =>
    new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // A stocked location: one live entry of a fresh product, never verified.
  const seedStocked = async (name: string) => {
    const loc = await createLocation(
      ctx.db,
      makeLocationInput({ name }),
      ctx.actor,
    );
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: `Widget for ${name}` }),
      ctx.actor,
    );
    const entry = await createInventoryEntry(
      ctx.db,
      { productId: prod.id, locationId: loc.id, amount },
      ctx.actor,
    );
    return { loc, product: prod, entry };
  };

  const setLastRecount = (locationId: LocationId, at: Date) =>
    getDb(ctx.db)
      .update(locationTable)
      .set({ lastBulkInventory: at })
      .where(eq(locationTable.id, locationId));

  it("flags stocked locations never recounted or recounted long ago, not fresh ones", async () => {
    const never = await seedStocked("Never-recounted shelf");
    const long = await seedStocked("Long-ago shelf");
    const fresh = await seedStocked("Freshly-recounted shelf");
    await setLastRecount(long.loc.entityId, daysAgo(90));
    await setLastRecount(fresh.loc.entityId, daysAgo(3));

    const { staleLocations } = await findViewProblems(ctx.db);
    const ids = staleLocations.map((l) => l.id);
    expect(ids).toContain(never.loc.id);
    expect(ids).toContain(long.loc.id);
    expect(ids).not.toContain(fresh.loc.id);

    const row = staleLocations.find((l) => l.id === never.loc.id);
    expect(row?.itemCount).toBe(1);
    expect(row?.lastBulkInventory).toBeNull();
  });

  it("ignores locations with no live stock (empty, or emptied by a soft delete)", async () => {
    const empty = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Empty bin" }),
      ctx.actor,
    );
    const emptied = await seedStocked("Emptied bin");
    await deleteInventoryEntries(ctx.db, [emptied.entry.entityId], ctx.actor);

    const { staleLocations } = await findViewProblems(ctx.db);
    const ids = staleLocations.map((l) => l.id);
    // Nothing to recount — the `location/empty-leaves` view already owns these.
    expect(ids).not.toContain(empty.id);
    expect(ids).not.toContain(emptied.loc.id);
  });

  /**
   * The `inventory/never-verified` saved view's own server filters.
   *
   * Read from the manifest so these tests exercise the predicate the app ships.
   * A test that retyped `{ verifiedPresenceFilter: "none" }` would keep passing
   * if the view were edited to mean something else — which is the exact class of
   * drift this whole conversion exists to remove.
   */
  const neverVerifiedView = () => {
    const declaration = viewProblemDeclarations().find(
      (d) => d.problem.key === "neverVerifiedInventory",
    );
    if (!declaration) throw new Error("neverVerifiedInventory view is gone");
    return declaration.problem;
  };

  it("lists never-verified entries, and drops them once verified or deleted", async () => {
    const unverified = await seedStocked("Unverified bin");
    const verified = await seedStocked("Verified bin");
    const removed = await seedStocked("Removed bin");
    await getDb(ctx.db)
      .update(inventoryEntry)
      .set({ verifiedAt: new Date() })
      .where(eq(inventoryEntry.id, verified.entry.entityId));
    await deleteInventoryEntries(ctx.db, [removed.entry.entityId], ctx.actor);

    // Drives the SAVED VIEW's own declared filters through the ordinary list
    // path — this is the parity assertion that let the detector be deleted.
    // Taking `serverFilters` from the manifest rather than retyping it here is
    // the point: a test that restated the predicate could agree with itself
    // while disagreeing with what the app actually runs.
    const { data } = await inventoryentryList(
      ctx.db,
      {
        ...neverVerifiedView().serverFilters,
        // Scopes to this test's fixtures; the describe shares one database, and
        // the predicate is what's under test, not the pagination. Filters by
        // NAME rather than id because the repo takes resolved uuids while the
        // view speaks shortcodes — see the guard in view-manifest.unit.test.tsx.
        locationNameFilter: "Unverified bin",
      },
      [],
      { pageIndex: 0, pageSize: 100 },
    );
    const ids = data.map((i) => i.id);
    expect(ids).toContain(unverified.entry.id);
    expect(ids).not.toContain(removed.entry.id);

    const verifiedRows = await inventoryentryList(
      ctx.db,
      {
        ...neverVerifiedView().serverFilters,
        locationNameFilter: "Verified bin",
      },
      [],
      { pageIndex: 0, pageSize: 100 },
    );
    expect(verifiedRows.data.map((i) => i.id)).not.toContain(verified.entry.id);

    // Rows carry both refs so the card can link product AND location.
    expect(data.find((i) => i.id === unverified.entry.id)).toMatchObject({
      product: { id: unverified.product.id },
      location: { id: unverified.loc.id, name: "Unverified bin" },
    });
  });

  it("flags only items parked in the global Unknown location", async () => {
    const unknown = await ensureGlobalUnknownLocation(ctx.db, ctx.actor);
    const parkedProduct = await createProduct(
      ctx.db,
      makeProductInput({ name: "Parked widget" }),
      ctx.actor,
    );
    const parked = await createInventoryEntry(
      ctx.db,
      { productId: parkedProduct.id, locationId: unknown.id, amount },
      ctx.actor,
    );
    const filed = await seedStocked("Properly filed shelf");

    const { unknownParkedItems } = await findFastProblems(ctx.db);
    expect(unknownParkedItems.map((i) => i.id)).toContain(parked.id);
    expect(unknownParkedItems.map((i) => i.id)).not.toContain(filed.entry.id);
    // The location ref is what lets the Problems card offer a recount rooted at
    // Unknown — the only thing that actually drains it.
    expect(unknownParkedItems.find((i) => i.id === parked.id)).toMatchObject({
      product: { id: parkedProduct.id, name: "Parked widget" },
      location: { name: "Unknown" },
    });

    // Filing it away (here: soft-deleting the parked row) clears the problem.
    await deleteInventoryEntries(ctx.db, [parked.entityId], ctx.actor);
    const after = await findFastProblems(ctx.db);
    expect(after.unknownParkedItems.map((i) => i.id)).not.toContain(parked.id);
  });

  // The original detector `.limit(25)`d, reporting 25 for a real population of
  // 178 — a number both wrong and impossible to drive to zero. Uncapping fixed
  // it. The view-backed section reintroduces a page cap ON THE ROWS, so the
  // count has to come from somewhere else: `sectionTotals`, computed as the
  // list's own `countWhere`. This test is what keeps that honest — if the
  // meter ever went back to reading `rows.length`, it would read 12 of 212.
  it("reports the true population even though the rows are a page", async () => {
    const loc = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Uncapped bin" }),
      ctx.actor,
    );
    // One entry per product: (productId, locationId) is unique, so a bigger
    // sample needs distinct products rather than repeated rows.
    const seeded = 30;
    for (let i = 0; i < seeded; i++) {
      const prod = await createProduct(
        ctx.db,
        makeProductInput({ name: `Uncapped widget ${i}` }),
        ctx.actor,
      );
      await createInventoryEntry(
        ctx.db,
        { productId: prod.id, locationId: loc.id, amount },
        ctx.actor,
      );
    }

    const { neverVerifiedInventory, sectionTotals } = await findViewProblems(
      ctx.db,
    );
    // The rows are a page and are allowed to be.
    expect(neverVerifiedInventory.length).toBeLessThanOrEqual(
      sectionTotals.neverVerifiedInventory ?? 0,
    );
    // The count is not. It must see past the page to the whole population —
    // this describe shares a database, so the total is at least what we seeded.
    expect(sectionTotals.neverVerifiedInventory ?? 0).toBeGreaterThanOrEqual(
      seeded,
    );
    expect(sectionTotals.neverVerifiedInventory).toBeGreaterThan(
      neverVerifiedInventory.length,
    );
  });
});

// The defect/coverage split. `totalProblems` — the navbar badge, the homepage
// banner, the headline card — must count only rows that can reach zero;
// coverage rows (un-itemized bins, un-photographed tools, un-recounted shelves)
// never can, and folding them in is what made the badge permanently red.
describe("problems service — totals count defects only", () => {
  const ctx = withTestDb();

  it("excludes coverage sections from totalProblems but still lists them", async () => {
    // An empty leaf location is coverage; an orphaned product is a defect.
    const emptyLoc = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Totals empty bin" }),
      ctx.actor,
    );
    const orphan = await createProduct(
      ctx.db,
      makeProductInput({ name: "Totals orphan widget" }),
      ctx.actor,
    );

    const all = await findAllProblems(
      ctx.db,
      fakeUpcClient().client,
      fakeUsdaClient(),
    );

    // Both are detected...
    expect(all.emptyLocations.map((l) => l.id)).toContain(emptyLoc.id);
    expect(all.orphanedProducts.map((p) => p.id)).toContain(orphan.id);

    // ...but only the defect moves the total. Compare against the summed
    // defect sections rather than a literal, since the shared fixture DB may
    // carry unrelated rows.
    const defectSum = sumProblemSections(
      Object.fromEntries(
        Object.entries(all).filter(([, v]) => Array.isArray(v)),
      ) as Record<string, readonly unknown[]>,
      "defect",
    );
    expect(all.totalProblems).toBe(defectSum);
    expect(all.emptyLocations.length).toBeGreaterThan(0);

    // countProblems reports the two populations separately, and byType keeps
    // the FULL roster so per-detector consumers and MCP slices still work.
    const counts = countProblems(all);
    expect(counts.total).toBe(all.totalProblems);
    expect(counts.coverageTotal).toBeGreaterThanOrEqual(
      all.emptyLocations.length,
    );
    expect(counts.byType.emptyLocations).toBe(all.emptyLocations.length);
  });
});

describe("findDuplicateProductIdentities", () => {
  const ctx = withTestDb();

  const seed = (
    name: string,
    overrides: Parameters<typeof makeProductInput>[0],
  ) =>
    createProduct(ctx.db, makeProductInput({ name, ...overrides }), ctx.actor);

  it("flags one SKU entered twice from two retailers", async () => {
    const amazonRow = await seed("DEWALT 20V MAX XR Drill", {
      manufacturer: "DeWalt",
      model: "DCD791D2",
      externalIds: [
        { source: "amazon", kind: "asin", externalId: "B01DUPE001", url: null },
      ],
    });
    const hdRow = await seed("Dewalt Cordless Drill Kit", {
      // Different casing on purpose: the canonical manufacturer key has to
      // hold the pair together, or the duplicate splits before it is found.
      manufacturer: "DEWALT",
      model: "DCD791D2",
      externalIds: [
        {
          source: "homedepot",
          kind: "retailer_sku",
          externalId: "HD-DUPE-001",
          url: null,
        },
      ],
    });

    const { duplicateProductIdentities } = await findFastProblems(ctx.db);
    const found = duplicateProductIdentities.find(
      (row) => row.model === "DCD791D2",
    );
    expect(found?.products.map((p) => p.id).sort()).toEqual(
      [amazonRow.id, hdRow.id].sort(),
    );
  });

  it("does not flag a variant family separated by distinct UPCs", async () => {
    await seed("Milwaukee Grinder 4.5in", {
      manufacturer: "Milwaukee",
      model: "M18-GRINDER",
      upc: "011111111116",
      externalIds: [
        { source: "amazon", kind: "asin", externalId: "B01VAR0001", url: null },
      ],
    });
    await seed("Milwaukee Grinder 6in", {
      manufacturer: "Milwaukee",
      model: "M18-GRINDER",
      // A different retail package — positive evidence these are two products,
      // not one entered twice.
      upc: "022222222229",
      externalIds: [
        {
          source: "homedepot",
          kind: "retailer_sku",
          externalId: "HD-VAR-0001",
          url: null,
        },
      ],
    });

    const { duplicateProductIdentities } = await findFastProblems(ctx.db);
    expect(
      duplicateProductIdentities.some((row) => row.model === "M18-GRINDER"),
    ).toBe(false);
  });

  it("does not flag rows whose identifiers all come from one source", async () => {
    // Two Amazon rows for one model are far likelier to be two listings of a
    // real variant than one item imported twice — the "different sources" half
    // of the signal is what makes it high precision.
    await seed("Bosch Bit Set A", {
      manufacturer: "Bosch",
      model: "BOSCH-BITS",
      externalIds: [
        { source: "amazon", kind: "asin", externalId: "B01SAME001", url: null },
      ],
    });
    await seed("Bosch Bit Set B", {
      manufacturer: "Bosch",
      model: "BOSCH-BITS",
      externalIds: [
        { source: "amazon", kind: "asin", externalId: "B01SAME002", url: null },
      ],
    });

    const { duplicateProductIdentities } = await findFastProblems(ctx.db);
    expect(
      duplicateProductIdentities.some((row) => row.model === "BOSCH-BITS"),
    ).toBe(false);
  });
});

describe("problems — brand-label spelling variants", () => {
  const ctx = withTestDb();

  const seedProduct = (name: string, manufacturer: string) =>
    createProduct(ctx.db, makeProductInput({ name, manufacturer }), ctx.actor);

  /**
   * A product carrying a spelling that drifts from an established one.
   *
   * It has to go in through the EDIT path, because the create path no longer
   * lets drift in: `resolveEstablishedManufacturer` snaps a new product onto
   * the spelling already in use. That's not a test workaround — it's the only
   * remaining door, and therefore the case these detectors now exist for.
   * Seeding a throwaway brand first keeps the create from snapping onto the
   * very spelling the test is trying to drift away from.
   */
  const seedVariantSpelling = async (name: string, manufacturer: string) => {
    const created = await seedProduct(name, `pending ${name}`);
    await updateProduct(ctx.db, created.entityId, { manufacturer }, ctx.actor);
    return created;
  };

  it("flags the minority spelling of a manufacturer, pointing at the majority", async () => {
    await seedProduct("Ryobi drill", "Ryobi");
    await seedProduct("Ryobi saw", "Ryobi");
    const odd = await seedVariantSpelling("Ryobi sander", "RYOBI");

    const { manufacturerSpellingVariants } = await findFastProblems(ctx.db);
    expect(manufacturerSpellingVariants).toEqual([
      {
        value: "RYOBI",
        count: 1,
        canonical: "Ryobi",
        canonicalCount: 2,
        sampleId: odd.id,
      },
    ]);
  });

  it("ignores the (unspecified) manufacturer sentinel", async () => {
    // The sentinel is carried by ~40% of products; it is not a brand, so two
    // products sharing it must never read as a spelling collision.
    await seedProduct("mystery a", UNSPECIFIED_MANUFACTURER);
    await seedProduct("mystery b", UNSPECIFIED_MANUFACTURER);

    const { manufacturerSpellingVariants } = await findFastProblems(ctx.db);
    expect(manufacturerSpellingVariants).toEqual([]);
  });

  it("excludes the sentinel however it is cased or spaced", async () => {
    // A case-sensitive `<>` would let these through the exclusion, and then
    // canonicalKey would fold them onto the same `unspecified` key as the
    // correctly-cased rows — reporting the not-a-brand sentinel as a brand
    // spelling variant, the exact false positive this detector avoids. The
    // exclusion compares canonical keys, so casing and spacing can't matter.
    await seedProduct("mystery a", UNSPECIFIED_MANUFACTURER);
    await seedProduct("mystery b", UNSPECIFIED_MANUFACTURER);
    // Through the edit path — a create would snap all three onto the correctly
    // cased sentinel and the exclusion would never be exercised.
    await seedVariantSpelling("mystery c", "(Unspecified)");
    await seedVariantSpelling("mystery d", "(UNSPECIFIED)");
    await seedVariantSpelling("mystery e", " (unspecified) ");

    const { manufacturerSpellingVariants } = await findFastProblems(ctx.db);
    expect(manufacturerSpellingVariants).toEqual([]);
  });

  it("clears once the odd spelling is soft-deleted", async () => {
    await seedProduct("Milwaukee drill", "Milwaukee");
    const odd = await seedVariantSpelling("Milwaukee saw", "MILWAUKEE");

    const before = await findFastProblems(ctx.db);
    expect(before.manufacturerSpellingVariants).toHaveLength(1);

    await deleteProducts(ctx.db, [odd.entityId], ctx.actor);

    const after = await findFastProblems(ctx.db);
    expect(after.manufacturerSpellingVariants).toEqual([]);
  });
});

describe("problems — duplicate vendors", () => {
  const ctx = withTestDb();

  // Seed through the door the duplicates actually come in: `createExpense`
  // resolves its `vendor` name via findOrCreateVendor, which matches EXACTLY, so
  // a second spelling mints a second roster row. Each distinct orderId is a
  // separate charge on that vendor, which is what the detector weighs.
  const seedCharge = (vendor: string, orderId: string) =>
    unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({
            name: `${vendor} ${orderId}`,
            cost: 10,
            vendor,
            orderId,
          }),
        ),
        ctx.actor,
      ),
    );

  // Idempotent by contract (vendor.integration.test pins it), so this reads an
  // existing roster row's internal uuid rather than creating anything.
  // The detector rows expose these entities by their canonical public ids.
  const vendorUuidOf = (name: string) => findOrCreateVendor(ctx.db, name);

  it("pairs two spellings of one vendor, keeping the one with more charges", async () => {
    await seedCharge("Amazon", "AMZ-1");
    await seedCharge("Amazon", "AMZ-2");
    await seedCharge("amazon", "AMZ-3");

    const { duplicateVendors } = await findFastProblems(ctx.db);
    const sampleUuid = await vendorUuidOf("amazon");
    const canonicalUuid = await vendorUuidOf("Amazon");
    const sample = await getVendorByID(ctx.db, sampleUuid);
    const canonicalSample = await getVendorByID(ctx.db, canonicalUuid);
    expect(duplicateVendors).toEqual([
      {
        value: "amazon",
        // Live CHARGES, not roster rows: `Vendor.name` is unique among live rows,
        // so a row count would be 1 on both sides and the canonical pick would
        // fall through to alphabetical order.
        count: 1,
        canonical: "Amazon",
        canonicalCount: 2,
        sampleId: sample.id,
        canonicalSampleId: canonicalSample.id,
      },
    ]);
  });

  it("leaves vendors that are each spelled one way alone", async () => {
    await seedCharge("Tool Nirvana", "TN-1");
    await seedCharge("Home Depot", "HD-1");
    await seedCharge("Home Depot", "HD-2");

    const { duplicateVendors } = await findFastProblems(ctx.db);
    expect(duplicateVendors).toEqual([]);
  });

  it("does not fold an abbreviation, only a respelling", async () => {
    // `bh` vs `bhphoto` are different canonical keys. This pair was real and was
    // merged by hand — the detector deliberately doesn't guess at it, so the UI
    // copy must not claim it does.
    await seedCharge("B&H", "BH-1");
    await seedCharge("B&H Photo", "BH-2");

    const { duplicateVendors } = await findFastProblems(ctx.db);
    expect(duplicateVendors).toEqual([]);
  });

  it("clears once merged with the two ids the row carries", async () => {
    // The row's own `canonicalSampleId`/`sampleId` are exactly
    // what the Problems card hands `mergeVendors` (which now speaks
    // shortcodes) — this pins that they're the right way round.
    await seedCharge("Lowes", "LW-1");
    await seedCharge("Lowes", "LW-2");
    await seedCharge("Lowe's", "LW-3");

    const before = await findFastProblems(ctx.db);
    expect(before.duplicateVendors).toHaveLength(1);
    const row = before.duplicateVendors[0];
    if (!row) throw new Error("expected a duplicate-vendor row");
    expect(row.value).toBe("Lowe's");

    const keeper = await mergeVendors(
      ctx.db,
      {
        keepId: row.canonicalSampleId,
        mergeIds: [row.sampleId],
      },
      ctx.actor,
    );
    expect(keeper.name).toBe("Lowes");
    // All three charges are now the keeper's — the merge moved them rather than
    // stranding them on a soft-deleted vendor.
    expect(keeper.purchaseCount).toBe(3);

    const after = await findFastProblems(ctx.db);
    expect(after.duplicateVendors).toEqual([]);
  });
});

describe("problems — cooked meals with nothing planned", () => {
  const ctx = withTestDb();

  const makeMeal = (date: string, overrides: Record<string, unknown> = {}) =>
    createMealFixture(
      ctx.db,
      mealCreateInput.parse({ date, ...overrides }),
      ctx.actor,
    );

  it("flags a cooked meal with no recipes", async () => {
    await makeMeal("2026-04-01", { name: "Thursday" });

    const { emptyCookedMeals } = await findViewProblems(ctx.db);

    expect(emptyCookedMeals.map((row) => row.name)).toEqual(["Thursday"]);
    expect(emptyCookedMeals[0]).toMatchObject({ date: "2026-04-01" });
  });

  it("never flags a meal that is deliberately recipe-less", async () => {
    // The whole reason this detector became writable: these are complete
    // records, not gaps, and flagging them would argue with the stated intent.
    await makeMeal("2026-04-02", { mealKind: "eating_out" });
    await makeMeal("2026-04-03", { mealKind: "takeout" });
    await makeMeal("2026-04-04", { mealKind: "leftovers" });

    const { emptyCookedMeals } = await findViewProblems(ctx.db);

    expect(emptyCookedMeals).toEqual([]);
  });

  it("clears once a recipe is planned, and again once re-kinded", async () => {
    const recipe = await createRecipe(
      ctx.db,
      makeRecipeInput({ name: "Chili" }),
      ctx.actor,
    );
    const planned = await makeMeal("2026-04-05", { name: "Planned" });
    const rekinded = await makeMeal("2026-04-06", { name: "Rekinded" });

    expect((await findViewProblems(ctx.db)).emptyCookedMeals).toHaveLength(2);

    await addRecipeToMeal(
      ctx.db,
      planned.entityId,
      { recipeId: recipe.id, scale: 1 },
      ctx.actor,
    );
    await updateMeal(
      ctx.db,
      rekinded.entityId,
      { mealKind: "eating_out" },
      ctx.actor,
    );

    expect((await findViewProblems(ctx.db)).emptyCookedMeals).toEqual([]);
  });

  it("still flags a meal whose only recipe was deleted", async () => {
    // The two-guard case. Unplanning soft-deletes the LINK; deleting the
    // recipe leaves the link intact. `dbMealToAPI` filters on both, so this
    // meal renders as empty — a detector checking only the link would leave it
    // unflagged while the page shows nothing planned.
    const recipe = await createRecipe(
      ctx.db,
      makeRecipeInput({ name: "Doomed" }),
      ctx.actor,
    );
    const meal = await makeMeal("2026-04-07", { name: "Orphaned" });
    await addRecipeToMeal(
      ctx.db,
      meal.entityId,
      { recipeId: recipe.id, scale: 1 },
      ctx.actor,
    );

    expect((await findViewProblems(ctx.db)).emptyCookedMeals).toEqual([]);

    await deleteRecipes(ctx.db, [recipe.entityId], ctx.actor);

    expect(
      (await findViewProblems(ctx.db)).emptyCookedMeals.map((r) => r.name),
    ).toEqual(["Orphaned"]);
  });
});

describe("problems — vendor mini-logo coverage", () => {
  const ctx = withTestDb();

  const seedLine = (vendor: string, orderId: string) =>
    unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({ name: `${vendor} ${orderId}`, vendor, orderId }),
        ),
        ctx.actor,
      ),
    );

  it("lists only active unseeded vendors and weights them by ledger visibility", async () => {
    await findOrCreateVendor(ctx.db, "Unused Roster Vendor");
    await seedLine("Quiet Unseeded Vendor", "Q-1");
    await seedLine("Busy Unseeded Vendor", "B-1");
    await seedLine("Busy Unseeded Vendor", "B-2");

    const { vendorsWithoutLogos } = await findFastProblems(ctx.db);

    expect(vendorsWithoutLogos.map((row) => row.name)).toEqual([
      "Busy Unseeded Vendor",
      "Quiet Unseeded Vendor",
    ]);
    expect(vendorsWithoutLogos[0]).toMatchObject({
      purchaseCount: 2,
      expenseRowCount: 2,
    });
    expect((await findCoverageTotals(ctx.db)).vendorsWithPurchases).toBe(2);
  });

  it("excludes a vendor whose public shortcode is in the generated manifest", async () => {
    const [seededShortcode] = Object.keys(VENDOR_LOGO_BY_SHORTCODE);
    if (!seededShortcode) throw new Error("expected a seeded vendor logo");

    await seedLine("Manifest-backed Vendor", "M-1");
    const vendorId = await findOrCreateVendor(ctx.db, "Manifest-backed Vendor");
    await getDb(ctx.db)
      .update(vendorTable)
      .set({ shortcode: seededShortcode })
      .where(eq(vendorTable.id, vendorId));

    const { vendorsWithoutLogos } = await findFastProblems(ctx.db);
    expect(vendorsWithoutLogos).toEqual([]);
  });

  it("excludes soft-deleted expense lines from the visibility count", async () => {
    const keep = await seedLine("Deletion-count Vendor", "D-1");
    const remove = await seedLine("Deletion-count Vendor", "D-2");
    await deleteExpenses(ctx.db, [remove.id], ctx.actor);

    const { vendorsWithoutLogos } = await findFastProblems(ctx.db);
    expect(vendorsWithoutLogos).toEqual([
      expect.objectContaining({
        name: "Deletion-count Vendor",
        purchaseCount: 2,
        expenseRowCount: 1,
      }),
    ]);
    expect(keep.id).not.toBe(remove.id);
  });
});

describe("problems — charges not reconciling", () => {
  const ctx = withTestDb();

  // A charge is minted by the expense write (findOrCreateVendor +
  // findOrCreatePurchase on vendor+orderId), so two lines sharing an order id
  // land on ONE charge. `statedTotal` is charge-level and is set afterwards —
  // there is deliberately no path that derives it from the lines.
  const seedLine = (overrides: Partial<ExpenseCreateInput>) =>
    unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(makeExpenseInput(overrides)),
        ctx.actor,
      ),
    );

  const setStated = (id: PurchaseShortcode, statedTotal: number) =>
    unwrap(
      updatePurchase(
        ctx.db,
        purchaseUpdateInput.parse({ id, data: { statedTotal } }),
        ctx.actor,
      ),
    );

  it("flags charges whose lines don't add up, biggest gap first, and leaves a matching one alone", async () => {
    const big = await seedLine({
      name: "big gap line",
      cost: 300,
      vendor: "Reconcile Depot",
      orderId: "RD-BIG",
    });
    const small = await seedLine({
      name: "small gap line",
      cost: 85,
      vendor: "Reconcile Depot",
      orderId: "RD-SMALL",
    });
    // Two lines on one order = one charge with two lines, which is the case a
    // charge-level stated total exists to check.
    const okFirst = await seedLine({
      name: "matching line a",
      cost: 60,
      vendor: "Reconcile Depot",
      orderId: "RD-OK",
    });
    const okSecond = await seedLine({
      name: "matching line b",
      cost: 40,
      vendor: "Reconcile Depot",
      orderId: "RD-OK",
    });
    expect(okSecond.purchaseId).toBe(okFirst.purchaseId);

    const bigCharge = await setStated(big.purchaseId as PurchaseShortcode, 500);
    const smallCharge = await setStated(
      small.purchaseId as PurchaseShortcode,
      100,
    );
    const okCharge = await setStated(
      okFirst.purchaseId as PurchaseShortcode,
      100,
    );

    const { purchasesNotReconciling } = await findFastProblems(ctx.db);

    // The detector's id is the canonical public purchase id.
    // Ordered by the size of the discrepancy: $200 before $15.
    expect(purchasesNotReconciling.map((c) => c.id)).toEqual([
      bigCharge.id,
      smallCharge.id,
    ]);
    expect(purchasesNotReconciling.map((c) => c.id)).not.toContain(okCharge.id);
    expect(purchasesNotReconciling[1]).toMatchObject({
      id: smallCharge.id,
      vendorName: "Reconcile Depot",
      orderId: "RD-SMALL",
      statedTotal: 100,
      expenseTotal: 85,
      expenseCount: 1,
    });
  });

  it("doesn't compare a charge with no stated total recorded", async () => {
    // `statedTotal` is null on ~every charge (nobody has keyed the paperwork in
    // yet), which reconciles as "unknown" — absence of a claim is not a
    // discrepancy, and flagging it would make the section permanently full.
    await seedLine({
      name: "no paperwork line",
      cost: 42,
      vendor: "No Paperwork Co",
      orderId: "NP-1",
    });

    const { purchasesNotReconciling } = await findFastProblems(ctx.db);
    expect(purchasesNotReconciling).toEqual([]);
  });

  it("sums only live lines, so emptying one re-opens the discrepancy", async () => {
    const kept = await seedLine({
      name: "kept portion",
      cost: 60,
      vendor: "Refund Mart",
      orderId: "RM-1",
    });
    const refunded = await seedLine({
      name: "refunded portion",
      cost: 40,
      vendor: "Refund Mart",
      orderId: "RM-1",
    });
    const charge = await setStated(kept.purchaseId as PurchaseShortcode, 100);

    const before = await findFastProblems(ctx.db);
    expect(before.purchasesNotReconciling).toEqual([]);

    await deleteExpenses(ctx.db, [refunded.id], ctx.actor);

    const after = await findFastProblems(ctx.db);
    expect(after.purchasesNotReconciling).toMatchObject([
      {
        id: charge.id,
        statedTotal: 100,
        expenseTotal: 60,
        expenseCount: 1,
      },
    ]);
  });

  it("excludes differences fully explained by posted refund evidence", async () => {
    const line = await seedLine({
      name: "refund-adjusted purchase",
      cost: 60,
      vendor: "Posted Refund Mart",
      orderId: "PRM-1",
    });
    const charge = await setStated(line.purchaseId as PurchaseShortcode, 100);
    const purchaseId = unsafePurchaseId(
      (await resolveLiveShortcode(ctx.db, charge.id, "purchase"))!,
    );
    const account = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Posted Refund Card",
      identity: {
        kind: "credit_card",
        issuer: null,
        network: "visa",
        last4: "4040",
      },
      provisional: false,
      sourceAliases: [],
      notes: null,
    });
    const refund = await insertSettlementTransaction(ctx.db, {
      accountId: account.id,
      purchaseId,
      kind: "refund",
      status: "pending",
      amount: -40,
      transactionDate: "2026-07-02",
      postedDate: null,
      merchant: "Posted Refund Mart",
      rawDescription: null,
      sourceCategory: null,
      sourceRefs: [],
      notes: null,
    });

    expect(
      (await findFastProblems(ctx.db)).purchasesNotReconciling,
    ).toHaveLength(1);

    await getDb(ctx.db)
      .update(financialTransaction)
      .set({ status: "posted", postedDate: "2026-07-03" })
      .where(eq(financialTransaction.id, refund.id));

    expect((await findFastProblems(ctx.db)).purchasesNotReconciling).toEqual(
      [],
    );
  });

  it("is advisory: reported, but never counted as a defect", async () => {
    const line = await seedLine({
      name: "advisory line",
      cost: 85,
      vendor: "Advisory Mart",
      orderId: "AM-1",
    });
    await setStated(line.purchaseId as PurchaseShortcode, 100);

    const { purchasesNotReconciling } = await findFastProblems(ctx.db);
    expect(purchasesNotReconciling).toHaveLength(1);
    // A mismatch is frequently correct (a partial refund), so it must never
    // reach `totalProblems` or the navbar badge.
    expect(PROBLEM_CLASS.purchasesNotReconciling).not.toBe("defect");
    expect(sumProblemSections({ purchasesNotReconciling }, "defect")).toBe(0);
  });
});

describe("problems — duplicate spend candidates", () => {
  const ctx = withTestDb();

  // An expense with vendor+orderId mints a Purchase and lands linked; one with
  // neither stays unlinked, which is the whole population this detector scans.
  const seedLine = (overrides: Partial<ExpenseCreateInput>) =>
    unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(makeExpenseInput(overrides)),
        ctx.actor,
      ),
    );

  const setStated = (id: PurchaseShortcode, statedTotal: number) =>
    unwrap(
      updatePurchase(
        ctx.db,
        purchaseUpdateInput.parse({ id, data: { statedTotal } }),
        ctx.actor,
      ),
    );

  const candidates = async () =>
    (await findFastProblems(ctx.db)).duplicateSpendCandidates;

  it("flags an unlinked lump matching a purchase's expense total", async () => {
    await seedLine({
      name: "framing nails 2 in ring shank collated",
      cost: 30,
      date: "2024-06-02",
      vendor: "Nail Depot",
      orderId: "ND-1",
    });
    await seedLine({
      name: "wood glue",
      cost: 13.43,
      date: "2024-06-02",
      vendor: "Nail Depot",
      orderId: "ND-1",
    });
    // The hand-entered lump: same money, no purchase, terse name.
    const lump = await seedLine({
      name: "framing nails",
      cost: 43.43,
      date: "2024-06-02",
    });

    const rows = await candidates();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: lump.id,
      cost: 43.43,
      matchedOn: "expense_total",
      dayDelta: 0,
      purchaseExpenseTotal: 43.43,
      purchaseExpenseCount: 2,
      alternateMatchCount: 0,
    });
    expect(rows[0]?.nameSimilarity).toBeGreaterThanOrEqual(0.15);
  });

  it("flags a lump matching only the stated total, when the import left the purchase under-itemized", async () => {
    const line = await seedLine({
      name: "duplex outlet receptacle white",
      cost: 47.47,
      date: "2024-05-22",
      vendor: "Outlet Mart",
      orderId: "OM-1",
    });
    // Tax never made it into the vendor export, so the lines fall short of what
    // the paperwork says — the shape that produced the worst real double-counts.
    await setStated(line.purchaseId as PurchaseShortcode, 50.71);
    const lump = await seedLine({
      name: "duplex outlet receptacle",
      cost: 50.71,
      date: "2024-05-22",
    });

    const rows = await candidates();
    expect(rows.map((r) => r.id)).toEqual([lump.id]);
    expect(rows[0]).toMatchObject({
      matchedOn: "stated_total",
      purchaseStatedTotal: 50.71,
      purchaseExpenseTotal: 47.47,
    });
  });

  it("ignores a same-amount, same-day collision between unrelated things", async () => {
    await seedLine({
      name: "monoprice cat6a ethernet patch cable",
      cost: 22,
      date: "2024-02-16",
      vendor: "Cable Mart",
      orderId: "CM-1",
    });
    // Real case: a $22.00 pruners row collided with an unrelated $22.00 order.
    // Amount and date alone would pair these; the name gate is what refuses.
    await seedLine({ name: "fiskars pruners", cost: 22, date: "2024-02-16" });

    expect(await candidates()).toEqual([]);
  });

  it("never reports a purchase's own lines, nor a soft-deleted lump", async () => {
    await seedLine({
      name: "cabinet hinge",
      cost: 43.43,
      date: "2024-06-02",
      vendor: "Hinge Co",
      orderId: "HC-1",
    });
    const lump = await seedLine({
      name: "cabinet hinge",
      cost: 43.43,
      date: "2024-06-02",
    });
    expect((await candidates()).map((r) => r.id)).toEqual([lump.id]);

    // The linked line has the identical name and cost, so if liveness or the
    // purchaseId filter were wrong it would pair with its own purchase.
    await deleteExpenses(ctx.db, [lump.id], ctx.actor);
    expect(await candidates()).toEqual([]);
  });

  it("ignores planned spend", async () => {
    await seedLine({
      name: "tile saw rental",
      cost: 88.5,
      date: "2024-07-01",
      vendor: "Rental Yard",
      orderId: "RY-1",
    });
    await seedLine({
      name: "tile saw rental",
      cost: 88.5,
      date: "2024-07-01",
      future: true,
    });

    expect(await candidates()).toEqual([]);
  });

  it("reports the best-scoring purchase once, and counts the weaker ones", async () => {
    await seedLine({
      name: "framing nails",
      cost: 43.43,
      date: "2024-06-02",
      vendor: "Nail Depot",
      orderId: "ND-NEAR",
    });
    // Same total and an equally strong name, but further from the lump's date —
    // so the tiebreak, not the score, decides which one is reported.
    await seedLine({
      name: "galvanized framing nails collated box",
      cost: 43.43,
      date: "2024-06-04",
      vendor: "Nail Depot",
      orderId: "ND-FAR",
    });
    const lump = await seedLine({
      name: "framing nails",
      cost: 43.43,
      date: "2024-06-02",
    });

    const rows = await candidates();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: lump.id,
      dayDelta: 0,
      alternateMatchCount: 1,
    });
  });

  it("is advisory: reported, but never counted as a defect", async () => {
    await seedLine({
      name: "spar urethane quart",
      cost: 10.93,
      date: "2024-03-01",
      vendor: "Finish Supply",
      orderId: "FS-1",
    });
    await seedLine({ name: "spar urethane", cost: 10.93, date: "2024-03-01" });

    const duplicateSpendCandidates = await candidates();
    expect(duplicateSpendCandidates).toHaveLength(1);
    // The match is a heuristic and the remedy deletes a row, so this must never
    // reach `totalProblems` or the navbar badge.
    expect(PROBLEM_CLASS.duplicateSpendCandidates).not.toBe("defect");
    expect(sumProblemSections({ duplicateSpendCandidates }, "defect")).toBe(0);
  });
});

// The settlement verdict against FinancialTransaction evidence — a different
// question from "charges not reconciling" above, which compares a charge's
// stated total against its own lines and never looks at a card statement.
describe("problems — purchase financial settlement mismatches", () => {
  const ctx = withTestDb();

  const seedLine = (overrides: Partial<ExpenseCreateInput>) =>
    unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(makeExpenseInput(overrides)),
        ctx.actor,
      ),
    );

  const seedAccount = () =>
    insertWithShortcode(ctx.db, "financialAccount", {
      name: "Settlement Visa",
      identity: {
        kind: "credit_card",
        issuer: null,
        network: "visa",
        last4: "1111",
      },
      provisional: false,
      sourceAliases: [],
      notes: null,
    });

  /** A posted card charge against the purchase an expense minted. */
  const postCharge = async (
    accountId: FinancialAccountId,
    purchaseShortcode: PurchaseShortcode,
    amount: number,
  ) => {
    const purchaseId = unsafePurchaseId(
      (await resolveLiveShortcode(ctx.db, purchaseShortcode, "purchase"))!,
    );
    await insertSettlementTransaction(ctx.db, {
      accountId,
      purchaseId,
      kind: "purchase",
      status: "posted",
      amount,
      transactionDate: "2026-07-01",
      postedDate: "2026-07-03",
      merchant: "Settlement Merchant",
      rawDescription: null,
      sourceCategory: null,
      sourceRefs: [],
      notes: null,
    });
  };

  const mismatches = async () =>
    (await findFastProblems(ctx.db)).purchaseFinancialSettlementMismatches;

  it("flags a purchase the card evidence underpays, and leaves a fully-settled one alone", async () => {
    const settled = await seedLine({
      name: "settled in full",
      cost: 120,
      vendor: "Settle Depot",
      orderId: "SD-MATCH",
    });
    const short = await seedLine({
      name: "short-settled",
      cost: 120,
      vendor: "Settle Depot",
      orderId: "SD-SHORT",
    });
    const account = await seedAccount();
    await postCharge(account.id, settled.purchaseId as PurchaseShortcode, 120);
    await postCharge(account.id, short.purchaseId as PurchaseShortcode, 95);

    const rows = await mismatches();
    expect(rows.map((row) => row.id)).toEqual([short.purchaseId]);
    expect(rows[0]).toMatchObject({
      vendorName: "Settle Depot",
      expenseTotal: 120,
      financialReconciliation: {
        status: "mismatch",
        postedTransactionCount: 1,
        outstandingTransactionCount: 0,
        postedTotal: 95,
        delta: -25,
      },
    });
  });

  it("compares against incurred spend only, so a planned line can't manufacture a mismatch", async () => {
    // The payment-schedule shape from FinancialReconciliationInput: a deposit
    // has settled, the rest of the contract is booked but hasn't happened yet.
    // Counting the planned $400 would report a mismatch against a purchase
    // behaving exactly as intended.
    const deposit = await seedLine({
      name: "venue deposit",
      cost: 100,
      vendor: "Venue Co",
      orderId: "VC-1",
    });
    const planned = await seedLine({
      name: "venue remaining payments",
      cost: 400,
      future: true,
      vendor: "Venue Co",
      orderId: "VC-1",
    });
    expect(planned.purchaseId).toBe(deposit.purchaseId);

    const account = await seedAccount();
    await postCharge(account.id, deposit.purchaseId as PurchaseShortcode, 100);

    expect(await mismatches()).toEqual([]);
  });

  it("still flags the incurred portion when the rest of the schedule is planned", async () => {
    // The mirror of the case above: excluding planned spend must not also
    // suppress a real disagreement on the part that HAS settled.
    const deposit = await seedLine({
      name: "gala deposit",
      cost: 100,
      vendor: "Gala Co",
      orderId: "GC-1",
    });
    await seedLine({
      name: "gala remaining payments",
      cost: 400,
      future: true,
      vendor: "Gala Co",
      orderId: "GC-1",
    });
    const account = await seedAccount();
    await postCharge(account.id, deposit.purchaseId as PurchaseShortcode, 88);

    const rows = await mismatches();
    expect(rows.map((row) => row.id)).toEqual([deposit.purchaseId]);
    // The worklist row still names the purchase's real size, even though only
    // the incurred $100 was compared.
    expect(rows[0]).toMatchObject({
      expenseTotal: 500,
      financialReconciliation: { delta: -12 },
    });
  });

  it("goes quiet on an unpriced incurred line, but not on an unpriced planned one", async () => {
    const unknown = await seedLine({
      name: "unknown-priced order line",
      cost: 60,
      vendor: "Unpriced Mart",
      orderId: "UM-UNKNOWN",
    });
    await seedLine({
      name: "unknown-priced order tax",
      cost: null,
      vendor: "Unpriced Mart",
      orderId: "UM-UNKNOWN",
    });
    // Same shape, except the unpriced row is planned — which takes it out of
    // the settleable population and restores the comparison.
    const compared = await seedLine({
      name: "planned-unpriced order line",
      cost: 60,
      vendor: "Unpriced Mart",
      orderId: "UM-PLANNED",
    });
    await seedLine({
      name: "planned-unpriced order tax",
      cost: null,
      future: true,
      vendor: "Unpriced Mart",
      orderId: "UM-PLANNED",
    });
    const account = await seedAccount();
    await postCharge(account.id, unknown.purchaseId as PurchaseShortcode, 95);
    await postCharge(account.id, compared.purchaseId as PurchaseShortcode, 95);

    // Cost unknown is not cost zero: with an incurred row unpriced there is no
    // total to compare, so the first purchase is silence, not a mismatch.
    const rows = await mismatches();
    expect(rows.map((row) => row.id)).toEqual([compared.purchaseId]);
    expect(rows[0]?.financialReconciliation.delta).toBe(35);
  });
});
