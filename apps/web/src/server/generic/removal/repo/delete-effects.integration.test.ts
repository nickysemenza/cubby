import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDb, runAfterCommit } from "~/server/db/helpers";
import { derivedRefreshWork, recipe } from "~/server/db/schema";
import {
  deleteRecipes,
  RECIPE_DELETE_EDGE_POLICY,
} from "~/server/domains/recipe/repo/crud";
import { RecipeCostingService } from "~/server/domains/recipe/repo/recipe-costing";
import {
  entityKernelContextSchema,
  executeEntityAs,
} from "~/server/entity-kernel";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  createRecipeFixture,
  makeRecipeInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import { executeDeleteWithEffects } from "./delete-effects";

// Background cache writes may replace a tuple after delete accounting takes
// its snapshot. Retry an aborted transaction, never an already committed one.
describe("delete effect snapshot contention", () => {
  const ctx = withTestDb();
  let queue: ReturnType<typeof captureBackgroundQueue>;
  beforeEach(() => {
    queue = captureBackgroundQueue();
  });
  afterEach(() => {
    queue.restore();
    vi.restoreAllMocks();
  });
  const fixture = () =>
    createRecipeFixture(
      ctx.db,
      makeRecipeInput({
        name: "Synthetic deletion snapshot recipe",
      }),
      ctx.actor,
    );

  it("deletes after a background cache update replaces its snapshot tuple", async () => {
    const subject = await fixture();
    let interrupted = false;
    await executeDeleteWithEffects(
      ctx.db,
      "recipe",
      [subject.id],
      RECIPE_DELETE_EDGE_POLICY,
      async (tx) => {
        if (!interrupted) {
          interrupted = true;
          await getDb(ctx.db)
            .update(recipe)
            .set({ totalsComputedAt: new Date(0) })
            .where(eq(recipe.id, subject.entityId));
        }
        return deleteRecipes(tx, [subject.entityId], ctx.actor);
      },
    );
    const [stored] = await getDb(ctx.db)
      .select({ deletedAt: recipe.deletedAt })
      .from(recipe)
      .where(eq(recipe.id, subject.entityId));
    expect(stored?.deletedAt).toBeInstanceOf(Date);
  });

  it("does not replay a committed delete after a consumer's serialization failure", async () => {
    const subject = await fixture();
    let attempts = 0;
    await expect(
      executeDeleteWithEffects(
        ctx.db,
        "recipe",
        [subject.id],
        RECIPE_DELETE_EDGE_POLICY,
        async (tx) => {
          attempts++;
          await runAfterCommit(tx, async () => {
            throw Object.assign(
              new Error("Synthetic consumer snapshot failure"),
              { code: "40001" },
            );
          });
          return deleteRecipes(tx, [subject.entityId], ctx.actor);
        },
      ),
    ).rejects.toThrow(
      "Transaction committed, but an after-commit effect failed",
    );
    expect(attempts).toBe(1);
    const [stored] = await getDb(ctx.db)
      .select({ deletedAt: recipe.deletedAt })
      .from(recipe)
      .where(eq(recipe.id, subject.entityId));
    expect(stored?.deletedAt).toBeInstanceOf(Date);
  });

  it("discards buffered parent recomputations from a late aborted delete attempt", async () => {
    const subject = await fixture();
    await createRecipeFixture(
      ctx.db,
      makeRecipeInput({
        name: "Synthetic deletion parent recipe",
        sections: [
          {
            ingredients: [
              {
                type: "recipe",
                recipeId: subject.id,
                ingredientId: null,
                amounts: [{ value: 1, unit: "each" }],
              },
            ],
            instructions: [{ instruction: "Combine." }],
          },
        ],
      }),
      ctx.actor,
    );
    queue.tasks.length = 0;
    const dispatch = RecipeCostingService.prototype.dispatchRecompute;
    let interrupted = false;
    let attempts = 0;
    vi.spyOn(
      RecipeCostingService.prototype,
      "dispatchRecompute",
    ).mockImplementation(async function (
      this: RecipeCostingService,
      ids,
      metadata,
    ) {
      const result = await dispatch.call(this, ids, metadata);
      if (metadata?.source === "recipe.delete") attempts++;
      if (!interrupted && metadata?.source === "recipe.delete") {
        interrupted = true;
        await getDb(ctx.db)
          .update(derivedRefreshWork)
          .set({ availableAt: new Date(0) })
          .where(eq(derivedRefreshWork.entityId, subject.entityId));
      }
      return result;
    });
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );
    await executeEntityAs(context, "delete", {
      entity: "recipe",
      ids: [subject.id],
    });
    expect(attempts).toBe(2);
    expect(
      queue.tasks.filter((task) => task.kind === "recipe-totals.recompute"),
    ).toHaveLength(1);
  });
});
