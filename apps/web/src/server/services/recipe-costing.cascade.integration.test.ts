import type { RecipeId, RecipeShortcode } from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { fromPartial } from "@total-typescript/shoehorn";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { findOrCreateIngredient } from "~/server/repo/ingredient";
import { createProduct, updateProduct } from "~/server/repo/product";
import { createRecipe, updateRecipe } from "~/server/repo/recipe";
import {
  getRecipeTotalsState,
  markRecipesStale,
} from "~/server/repo/recipe/totals";
import {
  ingredientRef,
  makeProductInput,
  makeRecipeInput,
} from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

/**
 * The cascade invariant behind the queue task: a child's committed totals
 * invalidate its parents in the same transaction, and publication of those
 * parents depends on their CURRENT staleness — never on having observed the
 * transition — so a lost wakeup is recoverable and a duplicate one is inert.
 */
describe("recipe totals cascade", () => {
  const ctx = withTestDb();
  const costing = () =>
    requireActor(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    ).services.recipeCosting;

  afterEach(() => setCfEnv(undefined));

  /** A queue that records what was published, and can refuse. */
  const installQueue = (options: { fail?: boolean } = {}) => {
    const published: RecipeId[][] = [];
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          sendBatch: async (
            messages: Iterable<{
              body: { task: { kind: string; recipeIds?: RecipeId[] } };
            }>,
          ) => {
            if (options.fail) throw new Error("publication refused");
            for (const message of messages) {
              if (message.body.task.recipeIds)
                published.push(message.body.task.recipeIds);
            }
          },
        },
      }),
    );
    return published;
  };

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

  it("commits the child and stales its parent together, then publishes the parent", async () => {
    const tree = await seedTree();
    await changePrice(tree.product, 9);
    await markRecipesStale(ctx.db, [tree.child]);
    const published = installQueue();

    await costing().recomputeQueued([tree.child]);

    expect(await stale(tree.child)).toBe(false);
    expect(await stale(tree.parent)).toBe(true);
    expect(published).toEqual([[tree.parent]]);
  });

  it("keeps the parent stale and recoverable when publication fails after commit", async () => {
    const tree = await seedTree();
    await changePrice(tree.product, 9);
    await markRecipesStale(ctx.db, [tree.child]);
    installQueue({ fail: true });

    await expect(costing().recomputeQueued([tree.child])).rejects.toThrow(
      "publication refused",
    );

    // The child's own commit stands; the parent's staleness is durable.
    expect(await stale(tree.child)).toBe(false);
    expect(await stale(tree.parent)).toBe(true);

    // Any later wakeup of the (already fresh) child republishes the parent —
    // no transition needs to be observed again.
    const published = installQueue();
    await costing().recomputeQueued([tree.child]);
    expect(published).toEqual([[tree.parent]]);
  });

  it("never re-stales a fresh parent on a duplicate wakeup", async () => {
    const tree = await seedTree();
    const published = installQueue();
    // Everything is fresh: a stray wakeup must publish nothing and stale nothing.
    await costing().recomputeQueued([tree.child]);
    expect(published).toEqual([]);
    expect(await stale(tree.parent)).toBe(false);
    expect(await stale(tree.grandparent)).toBe(false);
  });

  it("settles a deep cascade one wakeup at a time", async () => {
    const tree = await seedTree();
    await changePrice(tree.product, 9);
    await markRecipesStale(ctx.db, [tree.child]);
    const published = installQueue();

    await costing().recomputeQueued([tree.child]);
    expect(published).toEqual([[tree.parent]]);
    await costing().recomputeQueued([tree.parent]);
    expect(published).toEqual([[tree.parent], [tree.grandparent]]);
    await costing().recomputeQueued([tree.grandparent]);

    expect(await stale(tree.child)).toBe(false);
    expect(await stale(tree.parent)).toBe(false);
    expect(await stale(tree.grandparent)).toBe(false);
    expect(published).toHaveLength(2);
  });

  it("repairs a stale recipe on read and publishes its stale parents", async () => {
    const tree = await seedTree();
    await changePrice(tree.product, 9);
    await markRecipesStale(ctx.db, [tree.child]);
    const published = installQueue();

    const read = await executeEntity(
      entityKernelContextSchema.parse(
        createTestRequestContext(ctx.db, {
          auth: { userId: ctx.actor.userId },
        }),
      ),
      { action: "get", entity: "recipe", id: tree.childCode, missing: "error" },
    );
    if (read.action !== "get" || read.entity !== "recipe" || !read.item)
      throw new Error("expected a recipe");

    // The page never sees "pending": the read recomputed before returning.
    expect(read.item.totals?.cost).not.toMatchObject({ status: "pending" });
    expect(await stale(tree.child)).toBe(false);
    expect(await stale(tree.parent)).toBe(true);
    expect(published).toEqual([[tree.parent]]);
  });

  it("returns the recipe when repair-on-read fails after the child's commit", async () => {
    const tree = await seedTree();
    await changePrice(tree.product, 9);
    await markRecipesStale(ctx.db, [tree.child]);
    installQueue({ fail: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      // The repair is best-effort: a failure after the child's commit must
      // not fail the GET, or every later read would re-run the same failure.
      const read = await executeEntity(
        entityKernelContextSchema.parse(
          createTestRequestContext(ctx.db, {
            auth: { userId: ctx.actor.userId },
          }),
        ),
        {
          action: "get",
          entity: "recipe",
          id: tree.childCode,
          missing: "error",
        },
      );
      if (read.action !== "get" || read.entity !== "recipe" || !read.item)
        throw new Error("expected a recipe");

      expect(read.item.totals?.cost).not.toMatchObject({ status: "pending" });
      expect(await stale(tree.child)).toBe(false);
      expect(await stale(tree.parent)).toBe(true);
      // The freshness notifier also warns when no Durable Object is bound
      // (always, under vitest), so assert the repair warning itself.
      expect(warn).toHaveBeenCalledWith(
        "[recipe.get] repair-on-read failed",
        expect.objectContaining({ recipes: [tree.child] }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it(
    "stops at a sub-recipe cycle instead of re-staling around it",
    { timeout: 10_000 },
    async () => {
      const tree = await seedTree();
      // Close the loop: the child now also includes its own parent.
      await updateRecipe(
        ctx.db,
        tree.child,
        {
          sections: [
            {
              instructions: [{ instruction: "Use parent" }],
              ingredients: [
                {
                  type: "recipe" as const,
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
      await markRecipesStale(ctx.db, [tree.child]);
      const published = installQueue();

      // Inline transport would recurse here without bound; queued it would
      // ping-pong. Either way the totals around a cycle never converge, so
      // the cascade must refuse to stale a parent that is also a descendant.
      await costing().recomputeQueued([tree.child]);

      expect(await stale(tree.child)).toBe(false);
      expect(await stale(tree.parent)).toBe(false);
      expect(published).toEqual([]);
    },
  );
});
