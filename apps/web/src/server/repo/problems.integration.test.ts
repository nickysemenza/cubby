import type { LocationId, ProductId } from "@cubby/schemas/identifiers";
import {
  projectCreateInput,
  purchaseCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import type { UPCLookupResponse } from "@cubby/upc-contract";
import type { FoodSummary } from "@cubby/usda-schemas";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { householdDaysAgo, householdDaysFromNow } from "~/lib/household-date";
import type { UPCLookupClient } from "~/server/clients/upc-lookup";
import type { USDAClient } from "~/server/clients/usda";
import {
  image,
  inventoryEntry,
  location as locationTable,
  product,
  productImage,
} from "~/server/db/schema";
import {
  findAllProblems,
  findFastProblems,
  findTrackerProblems,
  reparseStaleIngredientParses,
} from "../services/problems.service";
import { getDb } from "./database-helpers";
import { createIngredient, getIngredientByName } from "./ingredient";
import { createInventoryEntry, deleteInventoryEntries } from "./inventory";
import { createLocation, ensureGlobalUnknownLocation } from "./location";
import { findStaleIngredientParses } from "./problems";
import { createProduct } from "./product";
import { createProject, deleteProjects } from "./project";
import { createPurchase, deletePurchases } from "./purchase";
import { createRecipe } from "./recipe";
import {
  ingredientRef,
  makeLocationInput,
  makeProductInput,
  makeRecipeInput,
} from "./repo.fixtures";
import { createTask, deleteTasks } from "./task";

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
      expect(result.recipesAffected).toContain(recipe.id);

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
        .where(eq(product.id, noManu.id));
      await attachImage(noManu.id);

      // (b) Has manufacturer + image, but no price → only the price gap.
      const noPrice = await createProduct(
        ctx.db,
        makeProductInput({ name: "No Price", upc: UPC_PRICE }),
        ctx.actor,
      );
      await attachImage(noPrice.id);

      // (c) Has manufacturer + price, but no image → only the image gap.
      const noImage = await createProduct(
        ctx.db,
        makeProductInput({ name: "No Image", upc: UPC_IMAGE }),
        ctx.actor,
      );
      await getDb(ctx.db)
        .update(product)
        .set({ price: 9 })
        .where(eq(product.id, noImage.id));

      // (d) Fully populated → not a candidate, must never be looked up.
      const full = await createProduct(
        ctx.db,
        makeProductInput({ name: "Full Product", upc: UPC_FULL }),
        ctx.actor,
      );
      await getDb(ctx.db)
        .update(product)
        .set({ price: 3 })
        .where(eq(product.id, full.id));
      await attachImage(full.id);

      // (e) Misc product with a manufacturer gap → excluded regardless.
      const misc = await createProduct(
        ctx.db,
        makeProductInput({ name: "misc: Loose Screw", upc: UPC_MISC }),
        ctx.actor,
      );
      await getDb(ctx.db)
        .update(product)
        .set({ manufacturer: UNSPECIFIED_MANUFACTURER, price: 1 })
        .where(eq(product.id, misc.id));
      await attachImage(misc.id);

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
      await attachImage(noPrice.id);

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
  });
});

// The household-tracker slice of the Problems payload. Detection itself lives in
// repo/project/attention.ts (covered there); this asserts the service-layer
// split — that the flat attention list lands in the right per-rule slices, and
// that a removed project's rows don't leak into the always-on badge count.
describe("problems service — tracker slice", () => {
  const ctx = withTestDb();

  it("surfaces an overdue task and a past-due planned purchase in their slices", async () => {
    const project = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "tracker slice project",
        status: "in_progress",
      }),
      ctx.actor,
    );
    const overdue = await createTask(
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
    const upcoming = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "tracker upcoming task",
        projectId: project.id,
        dueDate: householdDaysFromNow(3),
      }),
      ctx.actor,
    );
    const pastDuePlanned = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "tracker past-due planned purchase",
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
    expect(tracker.pastDuePlannedPurchases.map((i) => i.entityId)).toContain(
      pastDuePlanned.id,
    );
    // Rows carry the rule type + a route the Problems card can link to.
    expect(
      tracker.overdueTasks.find((i) => i.entityId === overdue.id),
    ).toMatchObject({ type: "overdue_task", entityType: "task" });
    expect(
      tracker.pastDuePlannedPurchases.find(
        (i) => i.entityId === pastDuePlanned.id,
      ),
    ).toMatchObject({
      type: "past_due_planned_purchase",
      entityType: "purchase",
    });
  });

  it("excludes rows belonging to a deleted project", async () => {
    const project = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "tracker deleted project",
        status: "in_progress",
      }),
      ctx.actor,
    );
    const task = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "tracker deleted overdue task",
        projectId: project.id,
        dueDate: householdDaysAgo(3),
      }),
      ctx.actor,
    );
    const planned = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "tracker deleted planned purchase",
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
    expect(before.pastDuePlannedPurchases.map((i) => i.entityId)).toContain(
      planned.id,
    );

    // A project can only be deleted once its tasks/purchases are (the delete
    // guards enforce that), so removing the project removes the whole subtree.
    await deleteTasks(ctx.db, [task.id], ctx.actor);
    await deletePurchases(ctx.db, [planned.id], ctx.actor);
    await deleteProjects(ctx.db, [project.id], ctx.actor);

    const after = await findTrackerProblems(ctx.db);
    const everyEntityId = Object.values(after).flatMap((items) =>
      items.map((i) => i.entityId),
    );
    expect(everyEntityId).not.toContain(task.id);
    expect(everyEntityId).not.toContain(planned.id);
    expect(everyEntityId).not.toContain(project.id);
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
    await setLastRecount(long.loc.id, daysAgo(90));
    await setLastRecount(fresh.loc.id, daysAgo(3));

    const { staleLocations } = await findFastProblems(ctx.db);
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
    await deleteInventoryEntries(ctx.db, [emptied.entry.id], ctx.actor);

    const { staleLocations } = await findFastProblems(ctx.db);
    const ids = staleLocations.map((l) => l.id);
    // Nothing to recount — findEmptyLocations already owns these.
    expect(ids).not.toContain(empty.id);
    expect(ids).not.toContain(emptied.loc.id);
  });

  it("lists never-verified entries, and drops them once verified or deleted", async () => {
    const unverified = await seedStocked("Unverified bin");
    const verified = await seedStocked("Verified bin");
    const removed = await seedStocked("Removed bin");
    await getDb(ctx.db)
      .update(inventoryEntry)
      .set({ verifiedAt: new Date() })
      .where(eq(inventoryEntry.id, verified.entry.id));
    await deleteInventoryEntries(ctx.db, [removed.entry.id], ctx.actor);

    const { neverVerifiedInventory } = await findFastProblems(ctx.db);
    const ids = neverVerifiedInventory.map((i) => i.id);
    expect(ids).toContain(unverified.entry.id);
    expect(ids).not.toContain(verified.entry.id);
    expect(ids).not.toContain(removed.entry.id);

    // Rows carry both refs so the card can link product AND location.
    expect(
      neverVerifiedInventory.find((i) => i.id === unverified.entry.id),
    ).toMatchObject({
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
    await deleteInventoryEntries(ctx.db, [parked.id], ctx.actor);
    const after = await findFastProblems(ctx.db);
    expect(after.unknownParkedItems.map((i) => i.id)).not.toContain(parked.id);
  });
});
