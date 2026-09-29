import type { Entity } from "@cubby/schemas/entity";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { upsertCookbook } from "./cookbook";
import { getDb } from "./database-helpers";
import { getEntityGraph } from "./entity-graph";
import { getEntityGraphExplore } from "./entity-graph-explore";
import { createExpense } from "./expense";
import { createPurchase } from "./purchase";
import { upsertCookbookRecipe } from "./recipe";
import {
  createIngredientFixture as createIngredient,
  createInventoryFixture as createInventory,
  createLocationFixture as createLocation,
  createProductFixture as createProduct,
  ingredientRef,
  makeExpenseInput,
  makeCookbookExtraction,
  makeCookbookRecipe,
  makeLocationInput,
  makeProductInput,
  makeRecipeInput,
} from "./repo.fixtures";
import { createVendor } from "./vendor";

describe("entity graph cross-entity journey", () => {
  const ctx = withTestDb();

  it("follows cookbook, stock, and purchase paths through their declared entity relationships", async () => {
    const cookbookName = "Journey cookbook";
    const ingredient = await createIngredient(
      ctx.db,
      { name: "Journey ingredient", aliases: [] },
      ctx.actor,
    );
    const product = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Journey product",
        ingredientId: ingredient.id,
      }),
      ctx.actor,
    );
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Journey location" }),
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
    const cookbook = await upsertCookbook(
      ctx.db,
      {
        name: cookbookName,
        sourceLabel: "journey.epub",
        rawJson: makeCookbookExtraction([
          makeCookbookRecipe("Journey source", ["1 cup flour"]),
        ]),
      },
      ctx.actor,
    );
    const recipe = await upsertCookbookRecipe(
      makeRecipeInput({
        name: "Journey recipe",
        sections: [
          {
            instructions: [],
            ingredients: [ingredientRef(ingredient.id)],
          },
        ],
      }),
      { id: cookbook.entityId, name: cookbookName },
      ctx.db,
      ctx.actor,
    );
    const vendor = await createVendor(
      ctx.db,
      {
        name: "Journey vendor",
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
        orderId: "journey-order",
        displayLabel: "Journey purchase",
        date: "2026-09-08",
        statedTotal: 10,
        notes: null,
      }),
      ctx.actor,
    );
    const expense = await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Journey expense",
        cost: 10,
        productId: product.id,
        purchaseId: purchase.output.id,
      }),
      ctx.actor,
    );

    const follow = async (
      source: { entityKind: Entity; entityId: string },
      relationshipKey: string,
      target: { entityKind: Entity; entityId: string },
      canonicalEdge = { source, target, relationshipKey },
    ) => {
      const graph = await getEntityGraph(ctx.db, {
        roots: [source],
        relationshipKeys: [relationshipKey],
      });
      expect(graph.nodes).toContainEqual(expect.objectContaining(target));
      expect(graph.branches).toContainEqual(
        expect.objectContaining({
          root: source,
          relationshipKey,
          target: target.entityKind,
          items: expect.arrayContaining([target]),
        }),
      );
      expect(graph.edges).toContainEqual(
        expect.objectContaining(canonicalEdge),
      );
      return graph;
    };

    await follow(
      { entityKind: "cookbook", entityId: cookbook.output.id },
      // Declared on the cookbook for its TOC section, so the derived
      // `inverse:recipe.cookbook` branch is superseded by this key.
      "recipes",
      { entityKind: "recipe", entityId: recipe.shortcode },
      {
        source: { entityKind: "recipe", entityId: recipe.shortcode },
        target: { entityKind: "cookbook", entityId: cookbook.output.id },
        relationshipKey: "cookbook",
      },
    );
    await follow(
      { entityKind: "recipe", entityId: recipe.shortcode },
      "ingredients",
      { entityKind: "ingredient", entityId: ingredient.id },
    );
    await follow(
      { entityKind: "ingredient", entityId: ingredient.id },
      "products",
      { entityKind: "product", entityId: product.id },
      {
        source: { entityKind: "product", entityId: product.id },
        target: { entityKind: "ingredient", entityId: ingredient.id },
        relationshipKey: "ingredient",
      },
    );
    // The side holding the foreign key owns the arrow: both reads share the
    // inventory → product edge, whichever entity declared its relation first.
    const fromProduct = await follow(
      { entityKind: "product", entityId: product.id },
      "inventory",
      { entityKind: "inventory", entityId: inventory.id },
      {
        source: { entityKind: "inventory", entityId: inventory.id },
        target: { entityKind: "product", entityId: product.id },
        relationshipKey: "product",
      },
    );
    const fromInventory = await follow(
      { entityKind: "inventory", entityId: inventory.id },
      "product",
      { entityKind: "product", entityId: product.id },
    );
    expect(fromProduct.edges).toHaveLength(1);
    expect(fromInventory.edges).toHaveLength(1);
    expect(fromInventory.edges[0]).toEqual(fromProduct.edges[0]);
    await follow(
      { entityKind: "inventory", entityId: inventory.id },
      "location",
      { entityKind: "location", entityId: location.id },
    );
    await follow({ entityKind: "product", entityId: product.id }, "purchases", {
      entityKind: "purchase",
      entityId: purchase.output.id,
    });
    await follow(
      { entityKind: "purchase", entityId: purchase.output.id },
      "expenses",
      { entityKind: "expense", entityId: expense.output.id },
      {
        source: { entityKind: "expense", entityId: expense.output.id },
        target: { entityKind: "purchase", entityId: purchase.output.id },
        relationshipKey: "purchase",
      },
    );

    const explored = await getEntityGraphExplore(ctx.db, {
      root: { entityKind: "product", entityId: product.id },
      depth: 2,
    });
    expect(explored.nodes).toContainEqual(
      expect.objectContaining({
        entityKind: "location",
        entityId: location.id,
      }),
    );
    expect(explored.paths).toContainEqual({
      nodeRefs: [
        { entityKind: "product", entityId: product.id },
        { entityKind: "inventory", entityId: inventory.id },
        { entityKind: "location", entityId: location.id },
      ],
      edgeIds: expect.arrayContaining([expect.any(String), expect.any(String)]),
    });
    expect(explored.completion).toMatchObject({
      status: "depth-limit",
      requestedDepth: 2,
      reachedDepth: 2,
    });
  });

  it("keeps opposite self-referential edges distinct while the declared reverse relation preserves their identity", async () => {
    const first = await createLocation(
      ctx.db,
      makeLocationInput({ name: "First cyclic location" }),
      ctx.actor,
    );
    const second = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Second cyclic location" }),
      ctx.actor,
    );

    await getDb(ctx.db).execute(
      sql`UPDATE "Location" SET "parentId" = ${second.entityId} WHERE "id" = ${first.entityId}`,
    );
    await getDb(ctx.db).execute(
      sql`UPDATE "Location" SET "parentId" = ${first.entityId} WHERE "id" = ${second.entityId}`,
    );

    const firstParent = await getEntityGraph(ctx.db, {
      roots: [{ entityKind: "location", entityId: first.id }],
      relationshipKeys: ["parent"],
    });
    const secondParent = await getEntityGraph(ctx.db, {
      roots: [{ entityKind: "location", entityId: second.id }],
      relationshipKeys: ["parent"],
    });
    const inverseOfSecond = await getEntityGraph(ctx.db, {
      roots: [{ entityKind: "location", entityId: second.id }],
      relationshipKeys: ["children"],
    });

    const firstEdge = firstParent.edges[0];
    const secondEdge = secondParent.edges[0];
    const inverseEdge = inverseOfSecond.edges[0];

    expect(firstEdge).toMatchObject({
      source: { entityKind: "location", entityId: first.id },
      target: { entityKind: "location", entityId: second.id },
      relationshipKey: "parent",
    });
    expect(secondEdge).toMatchObject({
      source: { entityKind: "location", entityId: second.id },
      target: { entityKind: "location", entityId: first.id },
      relationshipKey: "parent",
    });
    expect(firstEdge?.id).not.toBe(secondEdge?.id);
    expect(inverseOfSecond.branches).toContainEqual(
      expect.objectContaining({
        root: { entityKind: "location", entityId: second.id },
        relationshipKey: "children",
        items: [
          expect.objectContaining({
            entityKind: "location",
            entityId: first.id,
          }),
        ],
      }),
    );
    expect(inverseEdge).toEqual(firstEdge);
  });
});
