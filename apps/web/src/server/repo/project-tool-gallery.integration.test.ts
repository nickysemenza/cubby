import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { projectCreateInput } from "@cubby/schemas/project";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { product as productTable } from "~/server/db/schema";

import { getDb } from "./database-helpers";
import { createExpense } from "./expense";
import { deleteInventoryEntries } from "./inventory";
import { getHomeLocation } from "./location/home";
import { createProject } from "./project";
import { projectToolGallery } from "./project/tool-gallery";
import { deriveToolTrades } from "./project/tool-trades";
import { setProjectToolUsage } from "./project/tools";
import {
  createInventoryFixture as createInventory,
  createLocationFixture as createLocation,
  createProductFixture as createProduct,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "./repo.fixtures";

describe("project tool gallery", () => {
  const ctx = withTestDb();

  it("returns one enriched card per live inventoried tool", async () => {
    const homeRoot = await getHomeLocation(ctx.db);
    const home = {
      id: parseShortcodeFor("location", homeRoot.shortcode),
      name: homeRoot.name,
    };
    const garage = await createLocation(
      ctx.db,
      makeLocationInput({
        name: "Garage",
        type: "room",
        parentId: home.id,
      }),
      ctx.actor,
    );
    const cabinet = await createLocation(
      ctx.db,
      makeLocationInput({
        name: "Tool cabinet",
        type: "cabinet",
        parentId: garage.id,
      }),
      ctx.actor,
    );
    const workshop = await createLocation(
      ctx.db,
      makeLocationInput({
        name: "Workshop",
        type: "room",
        parentId: home.id,
      }),
      ctx.actor,
    );

    const drill = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Cordless drill",
        aliases: ["Impact driver"],
        tags: ["cordless", "18v"],
        manufacturer: "Makita",
        model: "XFD10",
        category: "tools",
      }),
      ctx.actor,
    );
    const saw = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Hand saw",
        manufacturer: "(unspecified)",
        model: null,
        category: "tools",
      }),
      ctx.actor,
    );
    const hardware = await createProduct(
      ctx.db,
      makeProductInput({ name: "Wood screws", category: "hardware" }),
      ctx.actor,
    );
    await createProduct(
      ctx.db,
      makeProductInput({ name: "Unstocked wrench", category: "tools" }),
      ctx.actor,
    );

    await createInventory(
      ctx.db,
      {
        productId: drill.id,
        locationId: cabinet.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
    await createInventory(
      ctx.db,
      {
        productId: drill.id,
        locationId: workshop.id,
        amount: { value: 2, unit: "each" },
        placement: "installed",
      },
      ctx.actor,
    );
    await createInventory(
      ctx.db,
      {
        productId: saw.id,
        locationId: cabinet.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
    await createInventory(
      ctx.db,
      {
        productId: hardware.id,
        locationId: cabinet.id,
        amount: { value: 50, unit: "each" },
      },
      ctx.actor,
    );

    const deletedInventoryTool = await createProduct(
      ctx.db,
      makeProductInput({ name: "Deleted inventory tool", category: "tools" }),
      ctx.actor,
    );
    const deletedEntry = await createInventory(
      ctx.db,
      {
        productId: deletedInventoryTool.id,
        locationId: cabinet.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
    await deleteInventoryEntries(ctx.db, [deletedEntry.entityId], ctx.actor);

    const deletedProduct = await createProduct(
      ctx.db,
      makeProductInput({ name: "Deleted product", category: "tools" }),
      ctx.actor,
    );
    await createInventory(
      ctx.db,
      {
        productId: deletedProduct.id,
        locationId: cabinet.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(productTable)
      .set({ deletedAt: new Date() })
      .where(eq(productTable.id, deletedProduct.entityId));

    const { output: project, entityId: projectId } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Electrical refresh" }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Drill acquisition",
        productId: drill.id,
        projectId: project.id,
        costType: "tools",
        trade: "electrical",
        cost: 240,
      }),
      ctx.actor,
    );
    await setProjectToolUsage(
      ctx.db,
      projectId,
      drill.entityId,
      true,
      ctx.actor,
    );

    const gallery = await projectToolGallery(ctx.db, {
      groupBy: "location",
      pagination: { pageIndex: 0, pageSize: 60 },
    });

    expect(gallery.meta.totalCount).toBe(2);
    expect(gallery.totals).toEqual({ products: 2, placements: 3 });
    expect(gallery.items.map((item) => item.productId)).toEqual([
      saw.id,
      drill.id,
    ]);
    expect(gallery.groups).toEqual([
      { key: garage.id, label: "Garage", itemCount: 1, startIndex: 0 },
      {
        key: "__multiple_locations__",
        label: "Multiple locations",
        itemCount: 1,
        startIndex: 1,
      },
    ]);

    const drillCard = gallery.items[1]!;
    expect(drillCard).toMatchObject({
      productId: drill.id,
      trade: "electrical",
      groupLabel: "Multiple locations",
      projectUseCount: 1,
      netLifetimeCost: 240,
      costPerProjectUse: 240,
    });
    expect(drillCard.inventoryEntries).toHaveLength(2);
    expect(drillCard.inventoryEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ placement: "installed" }),
        expect.objectContaining({
          location: expect.objectContaining({
            name: "Tool cabinet",
            ancestors: [
              expect.objectContaining({ name: home.name }),
              expect.objectContaining({ name: "Garage" }),
            ],
          }),
        }),
      ]),
    );
    expect(gallery.items[0]).toMatchObject({
      productId: saw.id,
      trade: null,
      projectUseCount: 0,
      netLifetimeCost: 0,
      costPerProjectUse: null,
    });

    const trades = await deriveToolTrades(getDb(ctx.db), [drill.entityId]);
    expect(trades.get(drill.entityId)).toBe(drillCard.trade);
  });

  it("searches normalized identity and location text and paginates stably", async () => {
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Basement Workshop", type: "room" }),
      ctx.actor,
    );
    for (const [name, alias] of [
      ["Alpha driver", "impact"],
      ["Beta driver", "rotary"],
    ] as const) {
      const tool = await createProduct(
        ctx.db,
        makeProductInput({
          name,
          aliases: [alias],
          tags: ["Cordless"],
          manufacturer: "Bosch",
          model: `${name.slice(0, 1)}-1`,
          category: "tools",
        }),
        ctx.actor,
      );
      await createInventory(
        ctx.db,
        {
          productId: tool.id,
          locationId: location.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
    }

    const input = {
      search: "  CORDLESS  ",
      groupBy: "manufacturer" as const,
      pagination: { pageIndex: 0, pageSize: 1 },
    };
    const first = await projectToolGallery(ctx.db, input);
    const second = await projectToolGallery(ctx.db, {
      ...input,
      pagination: { ...input.pagination, pageIndex: 1 },
    });
    expect(first.meta.totalCount).toBe(2);
    expect(first.groups).toEqual([
      { key: "bosch", label: "Bosch", itemCount: 2, startIndex: 0 },
    ]);
    expect(first.items[0]?.productName).toBe("Alpha driver");
    expect(second.items[0]?.productName).toBe("Beta driver");
    expect(second.items[0]?.productId).not.toBe(first.items[0]?.productId);

    const byAlias = await projectToolGallery(ctx.db, {
      ...input,
      search: "RoTaRy",
      pagination: { pageIndex: 0, pageSize: 60 },
    });
    expect(byAlias.items.map((item) => item.productName)).toEqual([
      "Beta driver",
    ]);

    const byLocation = await projectToolGallery(ctx.db, {
      ...input,
      search: "basement workshop",
      pagination: { pageIndex: 0, pageSize: 60 },
    });
    expect(byLocation.meta.totalCount).toBe(2);
  });
});
