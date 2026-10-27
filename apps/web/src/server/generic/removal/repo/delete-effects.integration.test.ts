import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb, runAfterCommit } from "~/server/db/helpers";
import { recipe } from "~/server/db/schema";
import {
  deleteRecipes,
  RECIPE_DELETE_EDGE_POLICY,
  recipeScaffold,
} from "~/server/domains/recipe/repo/crud";
import { defineEntityOperations } from "~/server/entity-kernel/entity-operations";
import { defineRepository } from "~/server/entity-kernel/repo/repository";
import { requireActor } from "~/server/http/request-context";
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
  });
  const fixture = () =>
    createRecipeFixture(
      ctx.db,
      makeRecipeInput({
        name: "Synthetic deletion snapshot recipe",
      }),
      ctx.actor,
    );

  it("retains snapshot retries through the kernel delete workflow", async () => {
    const subject = await fixture();
    let attempts = 0;
    const binding = defineRepository("recipe", {
      lifecycle: { delete: RECIPE_DELETE_EDGE_POLICY },
      scaffold: recipeScaffold,
      delete: async (context) => {
        if (++attempts === 1) {
          await getDb(ctx.db)
            .update(recipe)
            .set({ totalsComputedAt: new Date(0) })
            .where(eq(recipe.id, subject.entityId));
        }
        return deleteRecipes(
          context.db,
          [subject.entityId],
          context.actorContext,
        );
      },
    });
    const operations = defineEntityOperations(binding);
    const context = requireActor(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );
    await operations.delete(context, [subject.id]);
    expect(attempts).toBe(2);
    const [stored] = await getDb(ctx.db)
      .select({ deletedAt: recipe.deletedAt })
      .from(recipe)
      .where(eq(recipe.id, subject.entityId));
    expect(stored?.deletedAt).toBeInstanceOf(Date);
  });

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
});
