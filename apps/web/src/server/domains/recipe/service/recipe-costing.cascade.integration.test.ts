import type { RecipeId, RecipeShortcode } from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { findOrCreateIngredient } from "~/server/domains/ingredient/repo/crud";
import {
  createProduct,
  updateProduct,
} from "~/server/domains/product/repo/crud";
import { createRecipe, updateRecipe } from "~/server/domains/recipe/repo/crud";
import { getRecipeTotalsState } from "~/server/domains/recipe/repo/totals";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { requireActor } from "~/server/http/request-context";
import {
  captureBackgroundQueue,
  drainDerivedRefreshFrontier,
} from "~/server/testing/background-queue";
import {
  ingredientRef,
  makeProductInput,
  makeRecipeInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

/**
 * Authoritative changes remain durable when wake-ups are lost. The generic
 * frontier computes each affected recipe and visits parent links once per wave;
 * pending reads and cyclic graphs must remain truthful and terminating.
 */
describe("recipe totals cascade", () => {
  const ctx = withTestDb();
  const costing = () =>
    requireActor(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    ).services.recipeCosting;

  let queue: ReturnType<typeof captureBackgroundQueue>;
  beforeEach(() => {
    queue = captureBackgroundQueue();
  });
  afterEach(() => queue.restore());

  const stale = async (id: RecipeId) =>
    (await getRecipeTotalsState(ctx.db, id))?.totalsComputedAt == null;

  const seedTree = async () => {
    const ingredient = await findOrCreateIngredient(ctx.db, "cascade flour");
    const product = await createProduct(
      ctx.db,
      makeProductInput({
        name: "cascade product",
        ingredientId: ingredient.id,
        price: 4,
      }),
      ctx.actor,
    );
    const child = await createRecipe(
      ctx.db,
      makeRecipeInput({
        name: "Child",
        sections: [
          {
            instructions: [{ instruction: "Mix" }],
            ingredients: [
              ingredientRef(ingredient.shortcode, {
                amounts: [{ value: 2, unit: "cup" }],
              }),
            ],
          },
        ],
      }),
      ctx.actor,
    );
    const subRecipe = (id: RecipeShortcode) => ({
      type: "recipe" as const,
      recipeId: id,
      ingredientId: null,
      amounts: [{ value: 1, unit: "each" }],
    });
    const parent = await createRecipe(
      ctx.db,
      makeRecipeInput({
        name: "Parent",
        sections: [
          {
            instructions: [{ instruction: "Use child" }],
            ingredients: [subRecipe(child.id)],
          },
        ],
      }),
      ctx.actor,
    );
    const grandparent = await createRecipe(
      ctx.db,
      makeRecipeInput({
        name: "Grandparent",
        sections: [
          {
            instructions: [{ instruction: "Use parent" }],
            ingredients: [subRecipe(parent.id)],
          },
        ],
      }),
      ctx.actor,
    );
    const resolve = async (code: string) => {
      const id = await resolveLiveShortcode(ctx.db, code, "recipe");
      if (!id) throw new Error("seed failed");
      return parseEntityId("recipe", id);
    };
    const ids = {
      childCode: child.id,
      parentCode: parent.id,
      child: await resolve(child.id),
      parent: await resolve(parent.id),
      grandparent: await resolve(grandparent.id),
    };
    // Settle the whole tree inline so every later assertion starts fresh.
    await costing().recompute([ids.child, ids.parent, ids.grandparent]);
    return { ...ids, product, ingredient };
  };

  const changePrice = async (
    product: Awaited<ReturnType<typeof seedTree>>["product"],
    price: number,
  ) => {
    await updateProduct(
      ctx.db,
      parseEntityId(
        "product",
        (await resolveLiveShortcode(ctx.db, product.id, "product"))!,
      ),
      { price },
      ctx.actor,
    );
  };

  const drainFrontier = async () => {
    const { processDerivedRefreshPage } =
      await import("~/server/domains/run/service/derived-refresh");
    for (let page = 0; page < 2_000; page++) {
      const result = await processDerivedRefreshPage(ctx.db);
      expect(result.errors).toEqual([]);
      if (result.done) return;
    }
    throw new Error("Synthetic recipe frontier did not terminate");
  };

  it("materializes a parent chain through the bounded generic frontier", async () => {
    const tree = await seedTree();
    await drainFrontier();
    queue.tasks.length = 0;
    await changePrice(tree.product, 9);
    await drainDerivedRefreshFrontier(ctx.db);
    expect(await stale(tree.child)).toBe(true);
    expect(await stale(tree.grandparent)).toBe(true);
    await drainFrontier();
    expect(await stale(tree.child)).toBe(false);
    expect(await stale(tree.parent)).toBe(false);
    expect(await stale(tree.grandparent)).toBe(false);
    // A duplicate delivery neither enumerates parents nor creates another wave.
    queue.tasks.length = 0;
    await costing().recomputeQueued([tree.child]);
    expect(queue.tasks).toEqual([]);
    expect(await stale(tree.parent)).toBe(false);
  });

  it("invalidates its own totals before background publication", async () => {
    const tree = await seedTree();
    await changePrice(tree.product, 9);
    await drainDerivedRefreshFrontier(ctx.db);
    expect(await stale(tree.child)).toBe(true);
    await drainFrontier();
    expect(await stale(tree.child)).toBe(false);
    expect(await stale(tree.grandparent)).toBe(false);
  });

  it("terminates a cyclic dependency frontier without repeated cache invalidation", async () => {
    const tree = await seedTree();
    await updateRecipe(
      ctx.db,
      tree.child,
      {
        sections: [
          {
            instructions: [{ instruction: "Synthetic cycle" }],
            ingredients: [
              {
                type: "recipe",
                recipeId: tree.parentCode,
                ingredientId: null,
                amounts: [{ value: 1, unit: "each" }],
              },
            ],
          },
        ],
      },
      ctx.actor,
    );
    await drainFrontier();
    expect(await stale(tree.child)).toBe(false);
    expect(await stale(tree.parent)).toBe(false);
    queue.tasks.length = 0;
    await drainFrontier();
    expect(queue.tasks).toEqual([]);
  });
});
