import type {
  FinancialAccountId,
  LocationId,
  ProductId,
  ProjectShortcode,
  PurchaseShortcode,
} from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
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
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import type { UPCLookupResponse } from "@cubby/upc-contract";
import type { FoodSummary } from "@cubby/usda-schemas";
import { eq } from "drizzle-orm";
import { insertSettlementTransaction } from "tooling/settlement-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";
import { compileProblemFilters } from "~/entities/problem-filter-semantics";
import { viewProblemDeclarations } from "~/entities/view-manifest";
import { householdDaysAgo, householdDaysFromNow } from "~/lib/household-date";
import {
  PartialUpcBatchLookupError,
  type UPCLookupClient,
} from "~/server/clients/upc-lookup";
import type { USDAClient } from "~/server/clients/usda";
import {
  financialTransaction,
  inventoryEntry,
  location as locationTable,
  product,
  productComponent,
  productImage,
  project as projectTable,
  projectToolUsage,
  upcLookupCache,
  vendor as vendorTable,
} from "~/server/db/schema";
import { findViewProblems } from "../services/problem-views.service";
import {
  findAllProblems,
  findFastProblems,
  findTrackerProblems,
  rebuildProductConversionCoverageProjection,
  reparseStaleIngredientParses,
} from "../services/problems.service";
import { getDb } from "./database-helpers";
import { createExpense, deleteExpenses } from "./expense";
import { createIngredient, getIngredientByName } from "./ingredient";
import { deleteInventoryEntries, inventoryentryList } from "./inventory";
import { ensureGlobalUnknownLocation } from "./location";
import { addRecipeToMeal, updateMeal } from "./meal";
import { findCoverageTotals, findStaleIngredientParses } from "./problems";
import { deleteProducts, productList, updateProduct } from "./product";
import { attachProductComponents } from "./product-components";
import { createProject, deleteProjects } from "./project";
import { computeAttentionItems } from "./project/attention";
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
import { readCachedUpcLookups } from "./upc-lookup-cache";
import { findOrCreateVendor, getVendorByID, mergeVendors } from "./vendor";

/**
 * The ledger repos hand back `{ output, entityId }` — the uuid is for audit and
 * side-effect bookkeeping. These tests assert on the public shape.
 */
const unwrap = async <T>(p: Promise<{ output: T }>): Promise<T> =>
  (await p).output;

const drainGen = async <R>(gen: AsyncGenerator<unknown, R>): Promise<R> => {
  let next = await gen.next();
  while (!next.done) next = await gen.next();
  return next.value;
};

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

const fakeUsdaClient = (foods: (FoodSummary | null)[] = []) =>
  ({
    findFoodsBatch: async (lookups: unknown[]) =>
      lookups.map((_, i) => foods[i] ?? null),
  }) as unknown as USDAClient;

describe("problems repo", () => {
  const ctx = withTestDb();

  describe("UPC enrichment cache", () => {
    const UPC = "cache-test-upc";

    it("reports unavailable, recovers into a durable answer, and serves stale data on a later outage", async () => {
      const unavailable = await readCachedUpcLookups(
        ctx.db,
        [UPC],
        async () => {
          throw new Error("provider down");
        },
      );
      expect(unavailable.freshness).toMatchObject({
        status: "unavailable",
        unavailableCount: 1,
      });
      expect(unavailable.lookups.size).toBe(0);

      const lookupBatch = vi
        .fn()
        .mockResolvedValue(
          new Map([[UPC, upcResponse(UPC, { brand: "Acme" })]]),
        );
      const recovered = await readCachedUpcLookups(ctx.db, [UPC], lookupBatch);
      expect(recovered.freshness.status).toBe("fresh");
      expect(recovered.lookups.get(UPC)?.brand).toBe("Acme");

      // An expired answer must try the provider again. A failure retains the
      // known proposal and advertises it as stale rather than empty/healthy.
      await getDb(ctx.db)
        .update(upcLookupCache)
        .set({ fetchedAt: new Date(0) })
        .where(eq(upcLookupCache.upc, UPC));
      const stale = await readCachedUpcLookups(ctx.db, [UPC], async () => {
        throw new Error("provider down again");
      });
      expect(stale.freshness).toMatchObject({ status: "stale" });
      expect(stale.lookups.get(UPC)?.brand).toBe("Acme");
    });

    it("persists successful chunks and marks only failed UPCs unavailable", async () => {
      const completed = `${UPC}-completed`;
      const failed = `${UPC}-failed`;
      const result = await readCachedUpcLookups(
        ctx.db,
        [completed, failed],
        async () => {
          throw new PartialUpcBatchLookupError(
            new Error("second chunk failed"),
            new Map([
              [completed, upcResponse(completed, { brand: "Preserved" })],
            ]),
            [failed],
          );
        },
      );

      expect(result.lookups.get(completed)?.brand).toBe("Preserved");
      expect(result.lookups.has(failed)).toBe(false);
      expect(result.freshness).toMatchObject({
        status: "stale",
        unavailableCount: 1,
      });
      expect(
        await getDb(ctx.db).query.upcLookupCache.findMany({
          where: (row, { inArray }) => inArray(row.upc, [completed, failed]),
          columns: { upc: true, status: true },
        }),
      ).toEqual(
        expect.arrayContaining([
          { upc: completed, status: "ready" },
          { upc: failed, status: "unavailable" },
        ]),
      );
    });
  });

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

      const drifted = await recipeWithRow("Drifted", flour.id, {
        amounts: [{ value: 99, unit: "cup" }],
        rawLine: "2 cups flour",
      });
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

      const staleIngredientParses = await findStaleIngredientParses(ctx.db);
      expect(staleIngredientParses.some((s) => s.recipeId === recipe.id)).toBe(
        false,
      );
      expect(
        (await drainGen(reparseStaleIngredientParses(ctx.db))).updated,
      ).toBe(0);
    });

    it("find-or-creates the ingredient when the parsed name drifted", async () => {
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

      const before = await findAllProblems(
        ctx.db,
        fakeUpcClient().client,
        fakeUsdaClient(),
      );
      expect(before.orphanedProducts.some((p) => p.id === bought.id)).toBe(
        false,
      );

      await deleteExpenses(ctx.db, [expense.id], ctx.actor);

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
      const bucket = await createProduct(
        ctx.db,
        makeProductInput({ name: "misc: assorted clamps", price: null }),
        ctx.actor,
      );
      const unstocked = await createProduct(
        ctx.db,
        makeProductInput({ name: "Unpriced Unstocked Tool", price: null }),
        ctx.actor,
      );

      // A kit component carries no Expense of its own — the money stays on the
      // kit — so its price is the share projected down through
      // `ProductComponent` (kit-projection.ts). It IS priced, and the row on
      // this very view renders that projected number, so the filter selecting
      // the rows must agree with the column rendering them.
      const kit = await createProduct(
        ctx.db,
        makeProductInput({ name: "Nine Piece Combo Kit", price: null }),
        ctx.actor,
      );
      const kitPart = await createProduct(
        ctx.db,
        makeProductInput({ name: "Combo Kit Part", price: null }),
        ctx.actor,
      );
      await getDb(ctx.db).insert(productComponent).values({
        parentProductId: kit.entityId,
        componentProductId: kitPart.entityId,
        quantity: 1,
      });
      await createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({
            name: "bought the combo kit",
            cost: 199,
            productId: kit.id,
            productQuantity: 1,
          }),
        ),
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
      for (const productId of [priced.id, bucket.id, kitPart.id]) {
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

      for (const id of [priced.id, bucket.id, unstocked.id, kitPart.id]) {
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
      // The old `sold >= stocked` predicate only spared a partial sale when
      // the remainder happened to be larger than the quantity sold. These two
      // fixtures cover both sides of that accidental comparison.
      const partialEqual = await createProduct(
        ctx.db,
        makeProductInput({ name: "Two-pack Work Light", price: 20 }),
        ctx.actor,
      );
      const partialLargeSale = await createProduct(
        ctx.db,
        makeProductInput({ name: "Parts Bin Case", price: 10 }),
        ctx.actor,
      );
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
          productId: partialEqual.id,
          locationId: loc.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
      await createInventoryEntry(
        ctx.db,
        {
          productId: partialLargeSale.id,
          locationId: loc.id,
          amount: { value: 3, unit: "each" },
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
        name: "two work lights bought",
        cost: 40,
        vendor: "Home Depot",
        orderId: "BUY-PARTIAL-1",
        productId: partialEqual.id,
        productQuantity: 2,
      });
      await seedLine({
        name: "one work light sold",
        cost: -10,
        vendor: "eBay",
        orderId: "SALE-PARTIAL-1",
        productId: partialEqual.id,
        productQuantity: -1,
      });
      await seedLine({
        name: "eleven bins bought",
        cost: 110,
        vendor: "Home Depot",
        orderId: "BUY-PARTIAL-2",
        productId: partialLargeSale.id,
        productQuantity: 11,
      });
      await seedLine({
        name: "eight bins sold",
        cost: -80,
        vendor: "eBay",
        orderId: "SALE-PARTIAL-2",
        productId: partialLargeSale.id,
        productQuantity: -8,
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
      expect(flagged?.proceeds).toBe(-320);
      expect(flagged?.locations.map((l) => l.id)).toEqual([loc.id]);

      for (const id of [partialEqual.id, partialLargeSale.id]) {
        expect(found.soldButStillStocked.some((p) => p.id === id)).toBe(false);
      }
      expect(found.soldButStillStocked.some((p) => p.id === refunded.id)).toBe(
        false,
      );

      await deleteInventoryEntries(ctx.db, [soldEntry.entityId], ctx.actor);
      const after = await findFastProblems(ctx.db);
      expect(after.soldButStillStocked.some((p) => p.id === sold.id)).toBe(
        false,
      );
    });

    it("shares $0 discard eligibility with the canonical Product filter", async () => {
      const shelf = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Hand-entered discard shelf" }),
        ctx.actor,
      );
      const zeroDiscard = await createProduct(
        ctx.db,
        makeProductInput({ name: "Hand-entered zero discard", price: 10 }),
        ctx.actor,
      );
      const freebie = await createProduct(
        ctx.db,
        makeProductInput({ name: "Zero-cost free acquisition", price: 10 }),
        ctx.actor,
      );
      const refund = await createProduct(
        ctx.db,
        makeProductInput({ name: "Ordinary purchase refund", price: 10 }),
        ctx.actor,
      );
      const futureDiscard = await createProduct(
        ctx.db,
        makeProductInput({ name: "Future zero discard", price: 10 }),
        ctx.actor,
      );
      const deletedDiscard = await createProduct(
        ctx.db,
        makeProductInput({ name: "Deleted zero discard", price: 10 }),
        ctx.actor,
      );
      const partialOwnership = await createProduct(
        ctx.db,
        makeProductInput({ name: "Partially discarded stock", price: 10 }),
        ctx.actor,
      );

      for (const item of [
        zeroDiscard,
        freebie,
        refund,
        futureDiscard,
        deletedDiscard,
        partialOwnership,
      ]) {
        await createInventoryEntry(
          ctx.db,
          {
            productId: item.id,
            locationId: shelf.id,
            amount: { value: 1, unit: "each" },
          },
          ctx.actor,
        );
      }

      await seedLine({
        name: "hand-entered discard",
        cost: 0,
        productId: zeroDiscard.id,
        productQuantity: -1,
      });
      await seedLine({
        name: "free promotional item",
        cost: 0,
        productId: freebie.id,
        productQuantity: 1,
      });
      await seedLine({
        name: "original ordinary purchase",
        cost: 20,
        vendor: "Ordinary Store",
        orderId: "ORDINARY-REFUND",
        productId: refund.id,
        productQuantity: 1,
      });
      await seedLine({
        name: "ordinary refund",
        cost: -5,
        vendor: "Ordinary Store",
        orderId: "ORDINARY-REFUND",
        productId: refund.id,
        productQuantity: -1,
      });
      await seedLine({
        name: "planned discard",
        cost: 0,
        future: true,
        productId: futureDiscard.id,
        productQuantity: -1,
      });
      const deletedLine = await seedLine({
        name: "removed discard",
        cost: 0,
        productId: deletedDiscard.id,
        productQuantity: -1,
      });
      await deleteExpenses(ctx.db, [deletedLine.id], ctx.actor);
      await seedLine({
        name: "two units acquired",
        cost: 20,
        productId: partialOwnership.id,
        productQuantity: 2,
      });
      await seedLine({
        name: "one unit discarded",
        cost: 0,
        productId: partialOwnership.id,
        productQuantity: -1,
      });

      const [problems, canonical] = await Promise.all([
        findFastProblems(ctx.db),
        productList(
          ctx.db,
          { ownershipReconciliation: "disposed_still_on_hand" },
          [{ orderBy: "name", direction: "asc" }],
          { pageIndex: 0, pageSize: 100 },
        ),
      ]);
      const problemIds = new Set(
        problems.soldButStillStocked.map((row) => row.id),
      );
      const canonicalIds = new Set(canonical.data.map((row) => row.id));

      for (const item of [zeroDiscard]) {
        expect(problemIds.has(item.id)).toBe(true);
        expect(canonicalIds.has(item.id)).toBe(true);
      }
      for (const item of [
        freebie,
        refund,
        futureDiscard,
        deletedDiscard,
        partialOwnership,
      ]) {
        expect(problemIds.has(item.id)).toBe(false);
        expect(canonicalIds.has(item.id)).toBe(false);
      }
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

    it("uses shared on-hand and uncertainty semantics", async () => {
      const shelf = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Quantity semantics shelf" }),
        ctx.actor,
      );
      const secondShelf = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Second quantity semantics shelf" }),
        ctx.actor,
      );
      const installed = await createProduct(
        ctx.db,
        makeProductInput({ name: "Installed Sold Cabinet", price: 100 }),
        ctx.actor,
      );
      const mixed = await createProduct(
        ctx.db,
        makeProductInput({ name: "Mixed Unit Sold Stock", price: 20 }),
        ctx.actor,
      );
      const uncertain = await createProduct(
        ctx.db,
        makeProductInput({ name: "Unknown Acquisition Count", price: 30 }),
        ctx.actor,
      );

      const installedLocation = await createLocation(
        ctx.db,
        makeLocationInput({
          name: "Cabinet that is the product",
          type: null,
          productId: installed.id,
        }),
        ctx.actor,
      );
      for (const row of [
        { locationId: shelf.id, amount: { value: 1, unit: "each" } },
        { locationId: secondShelf.id, amount: { value: 1, unit: "box" } },
      ]) {
        await createInventoryEntry(
          ctx.db,
          { productId: mixed.id, ...row },
          ctx.actor,
        );
      }
      await createInventoryEntry(
        ctx.db,
        {
          productId: uncertain.id,
          locationId: shelf.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );

      await seedLine({
        name: "cabinet bought",
        cost: 100,
        productId: installed.id,
        productQuantity: 1,
      });
      await seedLine({
        name: "cabinet sold",
        cost: -80,
        vendor: "eBay",
        orderId: "INSTALLED-SALE",
        productId: installed.id,
        productQuantity: -1,
      });
      await seedLine({
        name: "mixed stock sold",
        cost: -10,
        vendor: "eBay",
        orderId: "MIXED-SALE",
        productId: mixed.id,
        productQuantity: -1,
      });
      await seedLine({
        name: "unknown amount bought",
        cost: 30,
        productId: uncertain.id,
      });
      await seedLine({
        name: "one uncertain item sold",
        cost: -20,
        vendor: "eBay",
        orderId: "UNCERTAIN-SALE",
        productId: uncertain.id,
        productQuantity: -1,
      });

      const { soldButStillStocked } = await findFastProblems(ctx.db);
      expect(
        soldButStillStocked.find((row) => row.id === installed.id),
      ).toMatchObject({
        liveQuantity: 1,
        locations: [
          { id: installedLocation.id, name: "Cabinet that is the product" },
        ],
      });
      expect(soldButStillStocked.some((row) => row.id === mixed.id)).toBe(
        false,
      );
      expect(soldButStillStocked.some((row) => row.id === uncertain.id)).toBe(
        false,
      );
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

      const unlinked = await seedLine({
        name: "ebay payout - unknown item",
        cost: -140,
        vendor: "eBay",
        orderId: "UNLINKED-SALE",
        productId: null,
      });
      await seedLine({
        name: "drill sold",
        cost: -90,
        vendor: "eBay",
        orderId: "LINKED-SALE",
        productId: linked.id,
        productQuantity: -1,
      });
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
      expect(
        found.unlinkedExitExpenses.some(
          (row) => row.name === "lumber overcharge refunded",
        ),
      ).toBe(false);
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
      await seedLine({
        name: "ebay payout - unknown item",
        cost: -140,
        vendor: "eBay",
        orderId: "PURCHASELESS-MIRROR",
        productId: null,
      });
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

      const during = await findFastProblems(ctx.db);
      expect(during.soldButStillStocked.some((p) => p.id === rebought.id)).toBe(
        true,
      );

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

    it("spares a partial-exit use and flags a use inside a sell-rebuy gap", async () => {
      const { output: afterPartial, entityId: afterPartialId } =
        await createProject(
          ctx.db,
          projectCreateInput.parse({
            name: "After partial sale",
            status: "done",
            startDate: "2024-01-01",
            endDate: "2024-02-01",
          }),
          ctx.actor,
        );
      const { output: inGap, entityId: inGapId } = await createProject(
        ctx.db,
        projectCreateInput.parse({
          name: "Inside ownership gap",
          status: "done",
          startDate: "2022-06-01",
          endDate: "2022-07-01",
        }),
        ctx.actor,
      );
      const partial = await createProduct(
        ctx.db,
        makeProductInput({ name: "Partially sold detector tool" }),
        ctx.actor,
      );
      const rebought = await createProduct(
        ctx.db,
        makeProductInput({ name: "Gap detector tool" }),
        ctx.actor,
      );
      const movement = (
        productId: (typeof partial)["id"],
        date: string,
        cost: number,
        productQuantity: number,
      ) =>
        createExpense(
          ctx.db,
          expenseCreateInput.parse(
            makeExpenseInput({
              name: `ownership ${date}`,
              productId,
              date,
              cost,
              productQuantity,
              lineKind: "principal",
            }),
          ),
          ctx.actor,
        );

      await movement(partial.id, "2021-01-01", 200, 2);
      await movement(partial.id, "2023-01-01", -80, -1);
      await movement(rebought.id, "2021-01-01", 100, 1);
      await movement(rebought.id, "2022-01-01", -80, -1);
      await movement(rebought.id, "2023-01-01", 120, 1);

      await getDb(ctx.db)
        .insert(projectToolUsage)
        .values([
          { projectId: afterPartialId, productId: partial.entityId },
          { projectId: inGapId, productId: rebought.entityId },
        ]);

      const rows = (await findFastProblems(ctx.db)).toolsUsedOutsideOwnership;
      expect(
        rows.some(
          (row) => row.id === partial.id && row.projectId === afterPartial.id,
        ),
      ).toBe(false);
      expect(rows).toContainEqual(
        expect.objectContaining({
          id: rebought.id,
          projectId: inGap.id,
          conflict: "disposed_before_start",
          toolDate: "2022-01-01",
        }),
      );
    });
  });

  describe("findProductsWithIslandedMappings", () => {
    it("flags a product whose mappings form 2+ islands but not a connected one", async () => {
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
        {
          a: { value: 1, unit: "cup packed" },
          b: { value: 1, unit: "cup" },
          source: null,
        },
        {
          a: { value: 2, unit: "lb" },
          b: { value: 5, unit: "dollar" },
          source: null,
        },
      ];
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
          fdc_id: sugarFood.fdc_id,
          unitMappings: storedIslands,
        }),
        ctx.actor,
      );

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

      await rebuildProductConversionCoverageProjection(
        ctx.db,
        fakeUsdaClient([sugarFood]),
      );
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
    const UPC_MANU = "012345678905";
    const UPC_PRICE = "036000291452";
    const UPC_IMAGE = "078000053258";
    const UPC_FULL = "022000004444";
    const UPC_MISC = "044000031091";

    const attachImage = async (productId: ProductId) => {
      const img = await insertWithShortcode(ctx.db, "image", {
        key: `key-${productId}`,
        filename: "i.jpg",
        size: 1,
        contentType: "image/jpeg",
      });
      await getDb(ctx.db)
        .insert(productImage)
        .values({ productId, imageId: img.id });
    };

    const attachPdf = async (productId: ProductId) => {
      const img = await insertWithShortcode(ctx.db, "image", {
        key: `pdf-key-${productId}`,
        filename: "manual.pdf",
        size: 1,
        contentType: PDF_CONTENT_TYPE,
      });
      await getDb(ctx.db)
        .insert(productImage)
        .values({ productId, imageId: img.id });
    };

    it("flags each fillable gap and skips fully-populated products without a lookup", async () => {
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

      const noPrice = await createProduct(
        ctx.db,
        makeProductInput({ name: "No Price", upc: UPC_PRICE }),
        ctx.actor,
      );
      await attachImage(noPrice.entityId);

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

      expect(byId.has(full.id)).toBe(false);
      expect(byId.has(misc.id)).toBe(false);
      expect(calls).not.toContain(UPC_FULL);
      expect(calls).not.toContain(UPC_MISC);
    });

    it("does not flag a gap the lookup itself can't fill", async () => {
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

    const presentedOverdue = tracker.overdueTasks.find(
      (i) => i.entityId === overdue.id,
    );
    expect(presentedOverdue?.name).toBe("tracker overdue task");
    expect(presentedOverdue?.severity).toBe("critical");
    expect(
      presentedOverdue?.type === "overdue_task" && presentedOverdue.facts,
    ).toMatchObject({ due: householdDaysAgo(3), daysOverdue: 3 });

    const presentedPlanned = tracker.pastDuePlannedExpenses.find(
      (i) => i.entityId === pastDuePlanned.id,
    );
    expect(presentedPlanned?.name).toBe("tracker past-due planned expense");
    expect(
      presentedPlanned?.type === "past_due_planned_expense" &&
        presentedPlanned.facts,
    ).toMatchObject({
      plannedFor: householdDaysAgo(5),
      daysPastDue: 5,
      // Carried through from the expense, so the card can lead with the money.
      cost: 250,
    });

    // Every presented row matches what `computeAttentionItems` says, field for
    // field. This is the invariant the old presenter broke.
    const ruleRows = await computeAttentionItems(ctx.db);
    for (const presented of [
      ...tracker.overdueTasks,
      ...tracker.pastDuePlannedExpenses,
      ...tracker.blockedWorkProjects,
      ...tracker.stalledProjects,
      ...tracker.projectsMissingBudget,
      ...tracker.unclassifiedExpenses,
    ]) {
      const rule = ruleRows.find((r) => r.key === presented.key);
      expect(rule, `no rule row for ${presented.key}`).toBeDefined();
      expect(presented).toEqual(rule);
    }
  });

  it("dates a stalled project by its real activity, never by updatedAt", async () => {
    // `project.updatedAt` is the value `attention.ts` documents at length as
    // meaningless here — on production it dates every project to one Notion
    // import. The old presenter used it anyway, and via `.toISOString()`, which
    // is a UTC day in a household-local app. Both are locked out.
    const lastWork = householdDaysAgo(120);
    const { output: project, entityId } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "tracker stalled project",
        status: "in_progress",
      }),
      ctx.actor,
    );
    await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "tracker stalled task",
        projectId: project.id,
        dueDate: lastWork,
      }),
      ctx.actor,
    );
    // `updatedAt` is one of the candidates the rule maxes over, so a row written
    // seconds ago is never stalled. Push it back further than the task's due
    // date, leaving the task as the real last-activity signal — which is the
    // whole point of the assertion below.
    await getDb(ctx.db)
      .update(projectTable)
      .set({ updatedAt: new Date(`${householdDaysAgo(200)}T12:00:00Z`) })
      .where(eq(projectTable.id, entityId));

    const tracker = await findTrackerProblems(ctx.db);
    const stalled = tracker.stalledProjects.find(
      (i) => i.entityId === project.id,
    );
    expect(stalled?.name).toBe("tracker stalled project");
    expect(stalled?.severity).toBe("warning");
    expect(stalled?.type === "stalled_project" && stalled.facts).toMatchObject({
      lastActivity: lastWork,
      thresholdDays: 30,
    });
    expect(stalled?.date).toBe(lastWork);
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
    const { sectionTotals: _sectionTotals, ...sections } = after;
    const everyEntityId = Object.values(sections).flatMap((items) =>
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
  const neverVerifiedFilters = () => {
    const source = neverVerifiedView().source;
    if (source.kind !== "entity") {
      throw new Error("neverVerifiedInventory must remain entity-backed");
    }
    return source.filters;
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

    const { data } = await inventoryentryList(
      ctx.db,
      {
        ...compileProblemFilters("inventory", neverVerifiedFilters()),
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
        ...compileProblemFilters("inventory", neverVerifiedFilters()),
        locationNameFilter: "Verified bin",
      },
      [],
      { pageIndex: 0, pageSize: 100 },
    );
    expect(verifiedRows.data.map((i) => i.id)).not.toContain(verified.entry.id);

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
    expect(unknownParkedItems.find((i) => i.id === parked.id)).toMatchObject({
      product: { id: parkedProduct.id, name: "Parked widget" },
      location: { name: "Unknown" },
    });

    // Filing it away (here: soft-deleting the parked row) clears the problem.
    await deleteInventoryEntries(ctx.db, [parked.entityId], ctx.actor);
    const after = await findFastProblems(ctx.db);
    expect(after.unknownParkedItems.map((i) => i.id)).not.toContain(parked.id);
  });

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

    expect(all.emptyLocations.map((l) => l.id)).toContain(emptyLoc.id);
    expect(all.orphanedProducts.map((p) => p.id)).toContain(orphan.id);

    const defectSum = sumProblemSections(
      Object.fromEntries(
        Object.entries(all).filter(([, v]) => Array.isArray(v)),
      ) as Record<string, readonly unknown[]>,
      "defect",
    );
    expect(all.totalProblems).toBe(defectSum);
    expect(all.emptyLocations.length).toBeGreaterThan(0);

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

  it("keeps duplicate models with JavaScript-trim whitespace in the candidate set", async () => {
    const amazonRow = await seed("Whitespace-normalized drill", {
      manufacturer: "DeWalt",
      // The ASCII whitespace path must agree with JavaScript's `trim()`.
      model: "\t\nDCD791D2\n\t",
      externalIds: [
        { source: "amazon", kind: "asin", externalId: "B01DUPEWS1", url: null },
      ],
    });
    const hdRow = await seed("Whitespace-normalized drill listing", {
      manufacturer: "DEWALT",
      model: "DCD791D2",
      externalIds: [
        {
          source: "homedepot",
          kind: "retailer_sku",
          externalId: "HD-DUPE-WS-1",
          url: null,
        },
      ],
    });

    const { duplicateProductIdentities } = await findFastProblems(ctx.db);
    const found = duplicateProductIdentities.find((row) =>
      row.products.some((product) => product.id === amazonRow.id),
    );
    expect(found?.products.map((product) => product.id).sort()).toEqual(
      [amazonRow.id, hdRow.id].sort(),
    );
  });

  it("falls back conservatively for duplicate models with non-ASCII whitespace", async () => {
    const amazonRow = await seed("Unicode-whitespace drill", {
      manufacturer: "DeWalt",
      // NBSP is whitespace to JavaScript trim but not PostgreSQL btrim. The
      // fallback must retain this row AND its ASCII-normalized peer.
      model: "\u00a0DCD792D2\u00a0",
      externalIds: [
        {
          source: "amazon",
          kind: "asin",
          externalId: "B01DUPEUNICODE1",
          url: null,
        },
      ],
    });
    const hdRow = await seed("Unicode-whitespace drill listing", {
      manufacturer: "DEWALT",
      model: "DCD792D2",
      externalIds: [
        {
          source: "homedepot",
          kind: "retailer_sku",
          externalId: "HD-DUPE-UNICODE-1",
          url: null,
        },
      ],
    });

    const { duplicateProductIdentities } = await findFastProblems(ctx.db);
    const found = duplicateProductIdentities.find((row) =>
      row.products.some((product) => product.id === amazonRow.id),
    );
    expect(found?.products.map((product) => product.id).sort()).toEqual(
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
    await seedCharge("Lowes", "LW-1");
    await seedCharge("Lowes", "LW-2");
    await seedCharge("Lowe's", "LW-3");

    const before = await findFastProblems(ctx.db);
    expect(before.duplicateVendors).toHaveLength(1);
    const row = before.duplicateVendors[0];
    if (!row) throw new Error("expected a duplicate-vendor row");
    expect(row.value).toBe("Lowe's");

    const { vendor: keeper } = await mergeVendors(
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

  it("excludes a vendor with a persisted logo image", async () => {
    await seedLine("Logo-backed Vendor", "M-1");
    const vendorId = await findOrCreateVendor(ctx.db, "Logo-backed Vendor");
    const logo = await insertWithShortcode(ctx.db, "image", {
      key: `vendor-logo-${vendorId}`,
      filename: "vendor-logo.png",
      size: 1,
      contentType: "image/png",
    });
    await getDb(ctx.db)
      .update(vendorTable)
      .set({ logoImageId: logo.id })
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

  const seedLine = (overrides: Partial<ExpenseCreateInput>) =>
    unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(makeExpenseInput(overrides)),
        ctx.actor,
      ),
    );

  const setStated = (id: PurchaseShortcode, statedTotal: number) =>
    unwrap(updatePurchase(ctx.db, id, { statedTotal }, ctx.actor));

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

    const bigCharge = await setStated(
      parseShortcodeFor("purchase", big.purchaseId),
      500,
    );
    const smallCharge = await setStated(
      parseShortcodeFor("purchase", small.purchaseId),
      100,
    );
    const okCharge = await setStated(
      parseShortcodeFor("purchase", okFirst.purchaseId),
      100,
    );

    const { purchasesNotReconciling } = await findFastProblems(ctx.db);

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
    const charge = await setStated(
      parseShortcodeFor("purchase", kept.purchaseId),
      100,
    );

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
    const charge = await setStated(
      parseShortcodeFor("purchase", line.purchaseId),
      100,
    );
    const purchaseId = parseEntityId(
      "purchase",
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
    await setStated(parseShortcodeFor("purchase", line.purchaseId), 100);

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

  const seedLine = (overrides: Partial<ExpenseCreateInput>) =>
    unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(makeExpenseInput(overrides)),
        ctx.actor,
      ),
    );

  const setStated = (id: PurchaseShortcode, statedTotal: number) =>
    unwrap(updatePurchase(ctx.db, id, { statedTotal }, ctx.actor));

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
    await setStated(parseShortcodeFor("purchase", line.purchaseId), 50.71);
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

  const postCharge = async (
    accountId: FinancialAccountId,
    purchaseShortcode: PurchaseShortcode,
    amount: number,
  ) => {
    const purchaseId = parseEntityId(
      "purchase",
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
    await postCharge(
      account.id,
      parseShortcodeFor("purchase", settled.purchaseId),
      120,
    );
    await postCharge(
      account.id,
      parseShortcodeFor("purchase", short.purchaseId),
      95,
    );

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
    await postCharge(
      account.id,
      parseShortcodeFor("purchase", deposit.purchaseId),
      100,
    );

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
    await postCharge(
      account.id,
      parseShortcodeFor("purchase", deposit.purchaseId),
      88,
    );

    const rows = await mismatches();
    expect(rows.map((row) => row.id)).toEqual([deposit.purchaseId]);
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
    await postCharge(
      account.id,
      parseShortcodeFor("purchase", unknown.purchaseId),
      95,
    );
    await postCharge(
      account.id,
      parseShortcodeFor("purchase", compared.purchaseId),
      95,
    );

    const rows = await mismatches();
    expect(rows.map((row) => row.id)).toEqual([compared.purchaseId]);
    expect(rows[0]?.financialReconciliation.delta).toBe(35);
  });
});

/**
 * `kitsCountedTwice` — a kit on the books under its own name AND under its
 * parts', together claiming more units than were bought.
 *
 * Asserted through `findFastProblems` rather than the list filter it compiles
 * to, because the presenter is a separate switch that THROWS on an unregistered
 * key. A detector whose filter works and whose card presenter is missing fails
 * only when the first real row appears, which is the worst possible moment.
 */
describe("kits counted twice", () => {
  const ctx = withTestDb();

  it("reports a kit stocked on top of parts that already account for it", async () => {
    const room = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Twice-counted room" }),
      ctx.actor,
    );
    const kit = await createProduct(
      ctx.db,
      makeProductInput({ name: "Twice Counted Set" }),
      ctx.actor,
    );
    const half = await createProduct(
      ctx.db,
      makeProductInput({ name: "Twice Counted Half" }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "one set",
          cost: 120,
          productId: kit.id,
          productQuantity: 1,
        }),
      ),
      ctx.actor,
    );
    await attachProductComponents(
      ctx.db,
      kit.entityId,
      [{ productId: half.entityId, quantity: 2 }],
      ctx.actor,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: half.entityId,
        locationId: room.entityId,
        amount: { value: 2, unit: "each" },
      },
      ctx.actor,
    );

    const clean = await findFastProblems(ctx.db);
    expect(clean.kitsCountedTwice.some((row) => row.id === kit.id)).toBe(false);

    await createInventoryEntry(
      ctx.db,
      {
        productId: kit.entityId,
        locationId: room.entityId,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );

    const found = await findFastProblems(ctx.db);
    const flagged = found.kitsCountedTwice.find((row) => row.id === kit.id);
    expect(flagged).toBeDefined();
    expect(flagged?.name).toBe("Twice Counted Set");
    expect(flagged?.ownUnits).toBe(1);
    expect(flagged?.expectedUnits).toBe(1);
  });
});
