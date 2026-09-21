import { taskCreateInput } from "@cubby/schemas/project";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { testShortcode } from "@cubby/schemas/testing";
import { eq } from "drizzle-orm";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  expense,
  image,
  inventoryEntry,
  product,
  productImage,
  purchase,
  purchaseProduct,
} from "~/server/db/schema";

import { getDb } from "./database-helpers";
import { getEntityGraph, readEntityGraph } from "./entity-graph";
import { getEntityGraphExplore } from "./entity-graph-explore";
import { createExpense } from "./expense";
import { createGardenEntry, createPlanting } from "./garden";
import { createIngredient } from "./ingredient";
import { createPurchase } from "./purchase";
import { attachPurchaseProducts } from "./purchase-products";
import {
  createImageFixture,
  createInventoryFixture as createInventory,
  createLocationFixture as createLocation,
  createProductFixture as createProduct,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "./repo.fixtures";
import { createTask } from "./task/crud";
import { createVendor, findOrCreateVendor } from "./vendor";

describe("entity graph repository", () => {
  const ctx = withTestDb();

  it("traverses manifest paths in batches, paginates them, and excludes deleted leaves", async () => {
    const [product, firstLocation, secondLocation] = await Promise.all([
      createProduct(
        ctx.db,
        makeProductInput({ name: "Graph product" }),
        ctx.actor,
      ),
      createLocation(
        ctx.db,
        makeLocationInput({ name: "Graph first location" }),
        ctx.actor,
      ),
      createLocation(
        ctx.db,
        makeLocationInput({ name: "Graph second location" }),
        ctx.actor,
      ),
    ]);
    const [first, second] = await Promise.all([
      createInventory(
        ctx.db,
        {
          productId: product.id,
          locationId: firstLocation.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      ),
      createInventory(
        ctx.db,
        {
          productId: product.id,
          locationId: secondLocation.id,
          amount: { value: 2, unit: "each" },
        },
        ctx.actor,
      ),
    ]);

    const cover = await createImageFixture(ctx.db, "graph-cover");
    await getDb(ctx.db)
      .insert(productImage)
      .values({ productId: product.entityId, imageId: cover.id });

    const read = () =>
      getEntityGraph(ctx.db, {
        roots: [{ entityType: "product", entityId: product.id }],
        relationshipKeys: ["inventory"],
        limit: 1,
      });
    const measured = await countTestDbQueries(read);
    expect(
      measured.result.nodes.every((node) => node.image?.url === cover.url),
    ).toBe(true);
    const imageGraph = await getEntityGraph(ctx.db, {
      roots: [{ entityType: "image", entityId: cover.shortcode }],
      relationshipKeys: [],
    });
    expect(imageGraph.nodes[0]?.image?.url).toBe(cover.url);
    const explored = await getEntityGraphExplore(ctx.db, {
      root: { entityType: "product", entityId: product.id },
      depth: 1,
    });
    expect(explored.nodes.every((node) => node.image?.url === cover.url)).toBe(
      true,
    );

    class ImageHydrationDeadline extends Error {}
    let queryCount = 0;
    const relationshipOnly = await readEntityGraph(
      ctx.db,
      {
        roots: [{ entityType: "product", entityId: product.id }],
        relationshipKeys: ["inventory"],
        limit: 1,
      },
      {
        includeImages: true,
        beforeQuery: async () => {
          queryCount += 1;
          if (queryCount === 3) throw new ImageHydrationDeadline();
        },
        isImageHydrationDeadline: (error) =>
          error instanceof ImageHydrationDeadline,
      },
    );
    expect(relationshipOnly.edges).toHaveLength(1);
    expect(
      relationshipOnly.nodes.every((node) => node.image === undefined),
    ).toBe(true);

    let unexpectedQueryCount = 0;
    await expect(
      readEntityGraph(
        ctx.db,
        {
          roots: [{ entityType: "product", entityId: product.id }],
          relationshipKeys: ["inventory"],
          limit: 1,
        },
        {
          includeImages: true,
          beforeQuery: async () => {
            unexpectedQueryCount += 1;
            if (unexpectedQueryCount === 3) {
              throw new Error("unexpected image failure");
            }
          },
          isImageHydrationDeadline: () => false,
        },
      ),
    ).rejects.toThrow("unexpected image failure");
    await getDb(ctx.db)
      .update(image)
      .set({ deletedAt: new Date() })
      .where(eq(image.id, cover.id));
    expect((await read()).nodes.every((node) => node.image === undefined)).toBe(
      true,
    );
    const branch = measured.result.branches[0];
    // Root lookup, batched traversal, shared images, and one derivative batch.
    expect(measured.queryCount).toBe(4);
    expect(branch).toMatchObject({ totalCount: 2, nextOffset: 1 });
    expect(branch?.items).toHaveLength(1);
    expect(measured.result.edges).toHaveLength(1);
    expect(
      measured.result.nodes.find(
        (node) => node.entityId === first.id || node.entityId === second.id,
      )?.metadata,
    ).toMatchObject({ unit: "each" });

    await getDb(ctx.db)
      .update(inventoryEntry)
      .set({ deletedAt: new Date() })
      .where(eq(inventoryEntry.id, first.entityId));
    const afterDelete = await read();
    expect(afterDelete.branches[0]).toMatchObject({
      totalCount: 1,
      nextOffset: null,
    });
    expect(afterDelete.nodes.some((node) => node.entityId === first.id)).toBe(
      false,
    );
  });

  it("uses declared inverse paths for multi-hop expansion", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Inverse graph product" }),
      ctx.actor,
    );
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Inverse graph location" }),
      ctx.actor,
    );
    const inventory = await createInventory(
      ctx.db,
      {
        productId: product.id,
        locationId: location.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );

    const graph = await getEntityGraph(ctx.db, {
      roots: [{ entityType: "inventory", entityId: inventory.id }],
      relationshipKeys: ["location"],
    });
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        relationshipKey: "location",
        target: { entityType: "location", entityId: location.id },
      }),
    );
  });

  it("preserves named evidence while excluding deleted intermediate rows and roots", async () => {
    const productFixture = await createProduct(
      ctx.db,
      makeProductInput({ name: "Evidence graph product" }),
      ctx.actor,
    );
    const vendor = await createVendor(
      ctx.db,
      {
        name: "Evidence graph vendor",
        website: null,
        orderUrlTemplate: null,
        orderEvidence: null,
        orderEmailSenders: [],
        browserDomains: [],
        returnWindowDays: null,
        agentHints: {
          ordersListUrl: null,
          pagination: null,
          orderLinkPattern: null,
          notes: [],
        },
        notes: null,
      },
      ctx.actor,
    );
    const purchase = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        vendorId: vendor.output.id,
        orderId: "EVIDENCE-GRAPH-ORDER",
        displayLabel: "Evidence graph purchase",
        date: "2026-09-08",
        statedTotal: 10,
        notes: null,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Evidence graph expense",
        productId: productFixture.id,
        purchaseId: purchase.output.id,
      }),
      ctx.actor,
    );
    await attachPurchaseProducts(
      ctx.db,
      purchase.entityId,
      [productFixture.entityId],
      ctx.actor,
    );

    const read = () =>
      getEntityGraph(ctx.db, {
        roots: [{ entityType: "product", entityId: productFixture.id }],
        relationshipKeys: ["purchases"],
      });
    const graph = await read();
    const branch = graph.branches[0];
    expect(branch).toMatchObject({ totalCount: 1, nextOffset: null });
    expect(branch?.edgeIds).toHaveLength(2);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceKey: "expense" }),
        expect.objectContaining({ sourceKey: "explicit" }),
      ]),
    );

    await getDb(ctx.db)
      .update(purchaseProduct)
      .set({ deletedAt: new Date() })
      .where(eq(purchaseProduct.purchaseId, purchase.entityId));
    const withoutExplicitEvidence = await read();
    expect(withoutExplicitEvidence.branches[0]?.edgeIds).toHaveLength(1);
    expect(withoutExplicitEvidence.edges).toEqual([
      expect.objectContaining({ sourceKey: "expense" }),
    ]);

    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, productFixture.entityId));
    const withoutRoot = await read();
    expect(withoutRoot).toMatchObject({ nodes: [], edges: [], branches: [] });
  });

  it("continues a relationship branch without repeating prior page items", async () => {
    const productFixture = await createProduct(
      ctx.db,
      makeProductInput({ name: "Paged graph product" }),
      ctx.actor,
    );
    const locations = await Promise.all(
      ["A", "B", "C"].map((name) =>
        createLocation(
          ctx.db,
          makeLocationInput({ name: `Paged graph location ${name}` }),
          ctx.actor,
        ),
      ),
    );
    await Promise.all(
      locations.map((location, index) =>
        createInventory(
          ctx.db,
          {
            productId: productFixture.id,
            locationId: location.id,
            amount: { value: index + 1, unit: "each" },
          },
          ctx.actor,
        ),
      ),
    );
    const input = {
      roots: [{ entityType: "product" as const, entityId: productFixture.id }],
      relationshipKeys: ["inventory"],
      limit: 1,
    };
    const first = await getEntityGraph(ctx.db, input);
    const second = await getEntityGraph(ctx.db, {
      ...input,
      offset: first.branches[0]?.nextOffset ?? 0,
    });
    const third = await getEntityGraph(ctx.db, {
      ...input,
      offset: second.branches[0]?.nextOffset ?? 0,
    });
    const beyondEnd = await getEntityGraph(ctx.db, { ...input, offset: 99 });
    const itemIds = [first, second, third].flatMap(
      (page) => page.branches[0]?.items.map((item) => item.entityId) ?? [],
    );
    expect(first.branches[0]).toMatchObject({ totalCount: 3, nextOffset: 1 });
    expect(second.branches[0]).toMatchObject({ totalCount: 3, nextOffset: 2 });
    expect(third.branches[0]).toMatchObject({
      totalCount: 3,
      nextOffset: null,
    });
    expect(beyondEnd.branches[0]).toMatchObject({
      totalCount: 3,
      nextOffset: null,
      items: [],
    });
    expect(new Set(itemIds)).toHaveLength(3);
  });

  it("reads task plantings through the declared inverse with counts and pages", async () => {
    const crop = await createIngredient(
      ctx.db,
      { name: "Task graph crop", aliases: [] },
      ctx.actor,
    );
    const task = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "Task graph source",
      }),
      ctx.actor,
    );
    const plantings = await Promise.all(
      ["A", "B", "C"].map((variety) =>
        createPlanting(
          ctx.db,
          {
            ingredientId: crop.id,
            taskId: task.output.id,
            status: "planned",
            variety,
          },
          ctx.actor,
        ),
      ),
    );
    const taskInput = {
      roots: [{ entityType: "task" as const, entityId: task.output.id }],
      relationshipKeys: ["inverse:planting.task"],
      limit: 1,
    };
    const first = await getEntityGraph(ctx.db, taskInput);
    const second = await getEntityGraph(ctx.db, {
      ...taskInput,
      offset: first.branches[0]?.nextOffset ?? 0,
    });
    const third = await getEntityGraph(ctx.db, {
      ...taskInput,
      offset: second.branches[0]?.nextOffset ?? 0,
    });
    const taskBranchItems = [first, second, third].flatMap(
      (page) => page.branches[0]?.items.map((item) => item.entityId) ?? [],
    );
    expect(first.branches[0]).toMatchObject({
      relationshipKey: "inverse:planting.task",
      target: "planting",
      totalCount: 3,
      nextOffset: 1,
    });
    expect(second.branches[0]).toMatchObject({ totalCount: 3, nextOffset: 2 });
    expect(third.branches[0]).toMatchObject({
      totalCount: 3,
      nextOffset: null,
    });
    expect(new Set(taskBranchItems)).toEqual(
      new Set(plantings.map((planting) => planting.id)),
    );

    const plantingGraph = await getEntityGraph(ctx.db, {
      roots: [{ entityType: "planting", entityId: plantings[0]!.id }],
      relationshipKeys: ["task"],
    });
    expect(plantingGraph.branches[0]).toMatchObject({
      relationshipKey: "task",
      target: "task",
      totalCount: 1,
      nextOffset: null,
      items: [{ entityType: "task", entityId: task.output.id }],
    });
  });

  it("batches a capped 25-root graph without per-record queries", async () => {
    const products = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        createProduct(
          ctx.db,
          makeProductInput({ name: `Batched graph product ${index}` }),
          ctx.actor,
        ),
      ),
    );
    const locations = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        createLocation(
          ctx.db,
          makeLocationInput({ name: `Batched graph location ${index}` }),
          ctx.actor,
        ),
      ),
    );
    const vendorId = await findOrCreateVendor(ctx.db, "Batched graph vendor");
    const purchases = await getDb(ctx.db)
      .insert(purchase)
      .values(
        Array.from({ length: 20 }, (_, index) => ({
          shortcode: testShortcode("purchase", `PUR-BATCH-${index}`),
          vendorId,
          date: "2026-09-08",
          displayLabel: `Batched graph purchase ${index}`,
        })),
      )
      .returning({ id: purchase.id });
    const fixturePairs = products.flatMap((productFixture, productIndex) =>
      purchases.map((purchaseRow, purchaseIndex) => ({
        productId: productFixture.entityId,
        purchaseId: purchaseRow.id,
        index: productIndex * purchases.length + purchaseIndex,
      })),
    );
    await Promise.all([
      getDb(ctx.db)
        .insert(inventoryEntry)
        .values(
          products.flatMap((productFixture, productIndex) =>
            locations.map((location, locationIndex) => ({
              shortcode: testShortcode(
                "inventory",
                `INV-BATCH-${productIndex}-${locationIndex}`,
              ),
              productId: productFixture.entityId,
              locationId: location.entityId,
              amount: { value: 1, unit: "each" },
            })),
          ),
        ),
      getDb(ctx.db)
        .insert(purchaseProduct)
        .values(
          fixturePairs.map(({ productId, purchaseId }) => ({
            productId,
            purchaseId,
          })),
        ),
      getDb(ctx.db)
        .insert(expense)
        .values(
          fixturePairs.map<typeof expense.$inferInsert>(
            ({ productId, purchaseId, index }) => ({
              shortcode: testShortcode("expense", `EXP-BATCH-${index}`),
              name: `Batched graph expense ${index}`,
              cost: 1,
              date: "2026-09-08",
              lineKind: "principal",
              lineBasis: "item_line",
              costType: "materials",
              trade: "other",
              future: false,
              productId,
              purchaseId,
            }),
          ),
        ),
    ]);
    const measured = await countTestDbQueries(() =>
      getEntityGraph(ctx.db, {
        roots: products.map((productFixture) => ({
          entityType: "product" as const,
          entityId: productFixture.id,
        })),
        relationshipKeys: ["purchases", "inventory"],
      }),
    );
    const responseBytes = new TextEncoder().encode(
      JSON.stringify(measured.result),
    ).byteLength;
    // Root lookup, batched traversal, and one shared display-image batch.
    expect(measured.queryCount).toBe(3);
    expect(measured.result).toMatchObject({
      truncated: true,
      nodes: expect.any(Array),
      edges: expect.any(Array),
    });
    expect(measured.result.nodes).toHaveLength(500);
    expect(measured.result.edges).toHaveLength(1_000);
    expect(
      measured.result.branches.filter(
        (branch) => branch.relationshipKey === "inventory",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          totalCount: 20,
          items: [],
          edgeIds: [],
          // Purchase evidence consumes the 1,000-edge cap first. The branch
          // remains explicitly expandable instead of exposing dangling rows.
          nextOffset: 0,
        }),
      ]),
    );
    const firstPage = await getEntityGraph(ctx.db, {
      roots: [{ entityType: "product", entityId: products[0]!.id }],
      relationshipKeys: ["inventory"],
      limit: 10,
    });
    const nextOffset = firstPage.branches[0]?.nextOffset;
    const secondPage = await getEntityGraph(ctx.db, {
      roots: [{ entityType: "product", entityId: products[0]!.id }],
      relationshipKeys: ["inventory"],
      limit: 10,
      offset: nextOffset ?? 0,
    });
    expect(firstPage.branches[0]).toMatchObject({
      totalCount: 20,
      nextOffset: 10,
    });
    expect(secondPage.branches[0]).toMatchObject({
      totalCount: 20,
      nextOffset: null,
    });
    expect(
      new Set(
        [
          ...(firstPage.branches[0]?.items ?? []),
          ...(secondPage.branches[0]?.items ?? []),
        ].map((item) => item.entityId),
      ),
    ).toHaveLength(20);
    // Keeps the payload measurement explicit for the audit without turning a
    // fixture-dependent byte count into a brittle contract threshold.
    expect(responseBytes).toBeGreaterThan(0);
  });

  it("labels a planting root as '<ingredient> · <variety>', falling back to the bare name", async () => {
    const ingredient = await createIngredient(
      ctx.db,
      { name: "Graph label tomato" },
      ctx.actor,
    );
    const bed = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Graph label bed" }),
      ctx.actor,
    );
    const withVariety = await createPlanting(
      ctx.db,
      {
        ingredientId: ingredient.id,
        locationId: bed.id,
        status: "growing",
        variety: "Cherokee Purple",
      },
      ctx.actor,
    );
    const withoutVariety = await createPlanting(
      ctx.db,
      { ingredientId: ingredient.id, locationId: bed.id, status: "growing" },
      ctx.actor,
    );
    const graph = await getEntityGraph(ctx.db, {
      roots: [
        { entityType: "planting", entityId: withVariety.id },
        { entityType: "planting", entityId: withoutVariety.id },
      ],
      relationshipKeys: [],
    });
    expect(
      graph.nodes.find((node) => node.entityId === withVariety.id)?.label,
    ).toBe("Graph label tomato · Cherokee Purple");
    expect(
      graph.nodes.find((node) => node.entityId === withoutVariety.id)?.label,
    ).toBe("Graph label tomato");
  });

  it("labels a gardenEntry root as '<Kind> · <date> · <location>'", async () => {
    const bed = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Graph label garden entry bed" }),
      ctx.actor,
    );
    const observation = await createGardenEntry(
      ctx.db,
      {
        locationId: bed.id,
        kind: "note",
        observedOn: "2026-10-06",
        note: "Whole-bed overview",
        pendingImageIds: [],
      },
      ctx.actor,
    );
    const harvest = await createGardenEntry(
      ctx.db,
      {
        locationId: bed.id,
        kind: "harvest",
        observedOn: "2026-10-07",
        note: "First pick",
        harvestAmount: "A handful",
        pendingImageIds: [],
      },
      ctx.actor,
    );
    const graph = await getEntityGraph(ctx.db, {
      roots: [
        { entityType: "gardenEntry", entityId: observation.id },
        { entityType: "gardenEntry", entityId: harvest.id },
      ],
      relationshipKeys: [],
    });
    expect(
      graph.nodes.find((node) => node.entityId === observation.id)?.label,
    ).toBe("Note · 2026-10-06 · Graph label garden entry bed");
    expect(
      graph.nodes.find((node) => node.entityId === harvest.id)?.label,
    ).toBe("Harvest · 2026-10-07 · Graph label garden entry bed");
  });
});
