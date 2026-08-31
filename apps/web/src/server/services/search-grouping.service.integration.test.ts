import { taskCreateInput } from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { createExpense } from "~/server/repo/expense";
import { attachProductComponents } from "~/server/repo/product-components";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { refreshSearchDocument } from "~/server/repo/search-document";
import { createTask } from "~/server/repo/task";

import { findGroupedSearchHits } from "./search-grouping.service";

describe("relational search groups", () => {
  const ctx = withTestDb();

  it("collapses placements under their Product and nests only linked matching activity", async () => {
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Relational Search Driver",
        manufacturer: "Fixture Tools",
      }),
      ctx.actor,
    );
    const sameNameProduct = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Relational Search Driver",
        manufacturer: "Other Fixture Tools",
      }),
      ctx.actor,
    );
    const garage = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Relational Garage" }),
      ctx.actor,
    );
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Driver shelf",
        parentId: garage.id,
      }),
      ctx.actor,
    );
    const stock = await createInventoryFixture(
      ctx.db,
      {
        productId: product.id,
        locationId: garage.id,
        amount: { value: 2, unit: "each" },
      },
      ctx.actor,
    );
    const installed = await createInventoryFixture(
      ctx.db,
      {
        productId: product.id,
        locationId: shelf.id,
        amount: { value: 1, unit: "each" },
        placement: "installed",
      },
      ctx.actor,
    );
    const linked = await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Relational Search Driver expense",
        productId: product.id,
      }),
      ctx.actor,
    );
    const unlinked = await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Relational Search Driver unrelated",
      }),
      ctx.actor,
    );
    const linkedTask = await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "Relational Search Driver maintenance",
        trade: "other",
        subjectProductId: product.id,
      }),
      ctx.actor,
    );
    await Promise.all([
      refreshSearchDocument(ctx.db, "product", product.entityId),
      refreshSearchDocument(ctx.db, "product", sameNameProduct.entityId),
      refreshSearchDocument(ctx.db, "location", garage.entityId),
      refreshSearchDocument(ctx.db, "location", shelf.entityId),
      refreshSearchDocument(ctx.db, "inventory", stock.entityId),
      refreshSearchDocument(ctx.db, "inventory", installed.entityId),
      refreshSearchDocument(ctx.db, "expense", linked.entityId),
      refreshSearchDocument(ctx.db, "expense", unlinked.entityId),
      refreshSearchDocument(ctx.db, "task", linkedTask.entityId),
    ]);

    const groups = await findGroupedSearchHits(ctx.db, {
      query: "Relational Search Driver",
      limit: 8,
    });
    const productGroups = groups.filter((group) => group.kind === "product");
    expect(productGroups).toHaveLength(2);
    const group = productGroups.find(
      (candidate) => candidate.primary.id === product.id,
    );
    expect(group).toBeDefined();
    expect(group?.placements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: stock.id,
          locationPath: expect.stringContaining("Relational Garage"),
          placement: "stock",
        }),
        expect.objectContaining({
          id: installed.id,
          locationPath: expect.stringContaining(
            "Relational Garage › Driver shelf",
          ),
          placement: "installed",
        }),
      ]),
    );
    expect(group?.matchedActivity.map((hit) => hit.id)).toContain(
      linked.output.id,
    );
    expect(group?.matchedActivity.map((hit) => hit.id)).toContain(
      linkedTask.output.id,
    );
    expect(group?.matchedActivity.map((hit) => hit.id)).not.toContain(
      unlinked.output.id,
    );
    expect(groups).toContainEqual(
      expect.objectContaining({
        kind: "entity",
        primary: expect.objectContaining({ id: unlinked.output.id }),
      }),
    );
  });

  it("fills distinct result slots after a long run of duplicate placement candidates", async () => {
    const products = [];
    for (let index = 0; index < 8; index += 1) {
      products.push(
        await createProductFixture(
          ctx.db,
          makeProductInput({
            name: "Overfetch Fixture Driver",
            manufacturer: `Fixture maker ${index}`,
          }),
          ctx.actor,
        ),
      );
    }
    const locations = [];
    for (let index = 0; index < 40; index += 1) {
      locations.push(
        await createLocationFixture(
          ctx.db,
          makeLocationInput({ name: `Overfetch shelf ${index}` }),
          ctx.actor,
        ),
      );
    }
    const placements = [];
    for (const location of locations) {
      placements.push(
        await createInventoryFixture(
          ctx.db,
          {
            productId: products[0]!.id,
            locationId: location.id,
            amount: { value: 1, unit: "each" },
          },
          ctx.actor,
        ),
      );
    }
    await Promise.all([
      ...products.map((product) =>
        refreshSearchDocument(ctx.db, "product", product.entityId),
      ),
      ...placements.map((placement) =>
        refreshSearchDocument(ctx.db, "inventory", placement.entityId),
      ),
    ]);

    const groups = await findGroupedSearchHits(ctx.db, {
      query: "Overfetch Fixture Driver",
      limit: 8,
    });

    expect(groups).toHaveLength(8);
    expect(groups.every((group) => group.kind === "product")).toBe(true);
    expect(new Set(groups.map((group) => group.key)).size).toBe(8);
  });

  it("reports verified component placements without calling them direct kit placements", async () => {
    const kit = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Component Placement Starter Kit" }),
      ctx.actor,
    );
    const component = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Component Placement Battery" }),
      ctx.actor,
    );
    const location = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Component Placement Garage" }),
      ctx.actor,
    );
    const inventory = await createInventoryFixture(
      ctx.db,
      {
        productId: component.id,
        locationId: location.id,
        amount: { value: 2, unit: "each" },
      },
      ctx.actor,
    );
    await attachProductComponents(
      ctx.db,
      kit.entityId,
      [{ productId: component.entityId, quantity: 2 }],
      ctx.actor,
    );
    await Promise.all([
      refreshSearchDocument(ctx.db, "product", kit.entityId),
      refreshSearchDocument(ctx.db, "product", component.entityId),
    ]);

    const [group] = await findGroupedSearchHits(ctx.db, {
      query: "Component Placement Starter Kit",
      limit: 8,
    });

    expect(group).toMatchObject({
      kind: "product",
      primary: { id: kit.id },
      placements: [],
      componentPlacements: [
        {
          component: { id: component.id },
          componentQuantity: 2,
          placement: {
            id: inventory.id,
            locationPath: expect.stringContaining("Component Placement Garage"),
          },
        },
      ],
    });
  });

  it("keeps exact shortcodes and explicit scopes direct while locations lead", async () => {
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Place Priority Wrench" }),
      ctx.actor,
    );
    const location = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Place Priority Garage" }),
      ctx.actor,
    );
    const inventory = await createInventoryFixture(
      ctx.db,
      {
        productId: product.id,
        locationId: location.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
    await Promise.all([
      refreshSearchDocument(ctx.db, "product", product.entityId),
      refreshSearchDocument(ctx.db, "location", location.entityId),
      refreshSearchDocument(ctx.db, "inventory", inventory.entityId),
    ]);

    const exact = await findGroupedSearchHits(ctx.db, {
      query: inventory.id,
      limit: 8,
    });
    expect(exact).toEqual([
      expect.objectContaining({
        kind: "entity",
        primary: expect.objectContaining({ id: inventory.id }),
      }),
    ]);

    const scoped = await findGroupedSearchHits(ctx.db, {
      query: "Place Priority Wrench",
      entityTypes: ["inventory"],
      limit: 8,
    });
    expect(scoped).toEqual([
      expect.objectContaining({
        kind: "entity",
        primary: expect.objectContaining({ id: inventory.id }),
      }),
    ]);

    const place = await findGroupedSearchHits(ctx.db, {
      query: "Place Priority Garage",
      limit: 8,
    });
    expect(place[0]).toMatchObject({
      kind: "entity",
      primary: { id: location.id },
    });
    expect(place).toContainEqual(
      expect.objectContaining({
        kind: "product",
        primary: expect.objectContaining({ id: product.id }),
      }),
    );
  });
});
