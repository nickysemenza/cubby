import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { fromPartial } from "@total-typescript/shoehorn";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { McpOperationContext } from "~/server/mcp/operation-context";
import { findOrCreateIngredient } from "~/server/repo/ingredient";
import { createRecipe } from "~/server/repo/recipe";
import { selectStaleRecipeIds } from "~/server/repo/recipe/totals";
import {
  createImageFixture,
  ingredientRef,
  insertEntityAttachments,
  makeRecipeInput,
} from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

/**
 * The purchase agent runs an approved tool inside ONE MCP transaction
 * (`McpOperationContext.inTransaction`); the kernel's own write units nest in
 * it as savepoints. Two regressions guarded here:
 *
 * - a service still bound to the request pool (recipe costing's stale mark)
 *   UPDATEs a Recipe row the MCP transaction already locked and waits on it
 *   forever — the test database is a real pool, so that shows up as a hang;
 * - a nested unit's queue publications and R2 deletes ran at the savepoint,
 *   before the real commit, so a rolled-back agent call still woke consumers
 *   and destroyed bytes for rows that survived.
 */
describe("MCP operation transaction", () => {
  const ctx = withTestDb();
  const published: string[] = [];
  /** Object paths R2 was asked to DELETE (the S3 API goes through `fetch`). */
  const storageDeletes: string[] = [];

  beforeEach(() => {
    published.length = 0;
    storageDeletes.length = 0;
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.method !== "DELETE") return realFetch(input, init);
        storageDeletes.push(new URL(request.url).pathname);
        return new Response(null, { status: 204 });
      },
    );
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          send: async () => {},
          sendBatch: async (
            messages: Iterable<{ body: { task: { kind: string } } }>,
          ) => {
            for (const message of messages)
              published.push(message.body.task.kind);
          },
        },
      }),
    );
  });
  afterEach(() => {
    setCfEnv(undefined);
    vi.unstubAllGlobals();
  });

  const requestContext = () =>
    requireActor(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
  const operationContext = () => new McpOperationContext(requestContext());

  const seedAliasRecipe = async () => {
    const keeper = await findOrCreateIngredient(ctx.db, "agent keeper flour");
    const alias = await findOrCreateIngredient(ctx.db, "agent alias flour");
    const recipe = await createRecipe(
      ctx.db,
      makeRecipeInput({
        name: "Agent merge recipe",
        sections: [
          {
            instructions: [{ instruction: "Mix" }],
            ingredients: [
              ingredientRef(alias.shortcode, {
                amounts: [{ value: 1, unit: "cup" }],
              }),
            ],
          },
        ],
      }),
      ctx.actor,
    );
    const recipeId = await resolveLiveShortcode(ctx.db, recipe.id, "recipe");
    if (!recipeId) throw new Error("seeded recipe did not resolve");
    // A fresh recipe is the case whose stale mark rewrites the locked row.
    await requestContext().services.recipeCosting.recomputeQueued([recipeId]);
    expect(await selectStaleRecipeIds(ctx.db, [recipeId])).toEqual([]);
    published.length = 0;
    return { keeper, alias, recipeId };
  };

  it(
    "merges ingredients on the agent path without deadlocking, publishing only after commit",
    { timeout: 15_000 },
    async () => {
      const { keeper, alias, recipeId } = await seedAliasRecipe();

      await operationContext().inTransaction(async (prepared) => {
        await executeEntity(
          entityKernelContextSchema.parse(prepared.entityKernel),
          {
            action: "merge",
            entity: "ingredient",
            data: { keepId: keeper.shortcode, mergeIds: [alias.shortcode] },
          },
        );
        expect(published).toEqual([]);
      });

      expect(await selectStaleRecipeIds(ctx.db, [recipeId])).toEqual([
        recipeId,
      ]);
      expect(published).toContain("recipe-totals.recompute");
      expect(
        await resolveLiveShortcode(ctx.db, alias.shortcode, "ingredient"),
      ).toBeNull();
    },
  );

  it(
    "runs no publication and no storage delete when the agent transaction rolls back",
    { timeout: 15_000 },
    async () => {
      const { keeper, alias, recipeId } = await seedAliasRecipe();
      const created = await executeEntity(
        entityKernelContextSchema.parse(requestContext()),
        {
          action: "create",
          entity: "location",
          data: { name: "Agent rollback shelf", type: "area" },
        },
      );
      if (created.action !== "create") throw new Error("expected create");
      const locationId = await resolveLiveShortcode(
        ctx.db,
        created.item.id,
        "location",
      );
      if (!locationId) throw new Error("created location did not resolve");
      const photo = await createImageFixture(ctx.db, "agent-rollback-shelf");
      await insertEntityAttachments(ctx.db, {
        entityId: locationId,
        imageId: photo.id,
      });
      published.length = 0;
      storageDeletes.length = 0;

      await expect(
        operationContext().inTransaction(async (prepared) => {
          const kernel = entityKernelContextSchema.parse(prepared.entityKernel);
          await executeEntity(kernel, {
            action: "merge",
            entity: "ingredient",
            data: { keepId: keeper.shortcode, mergeIds: [alias.shortcode] },
          });
          await executeEntity(kernel, {
            action: "delete",
            entity: "location",
            ids: [parseShortcodeFor("location", created.item.id)],
          });
          throw new Error("synthetic agent failure after the writes");
        }),
      ).rejects.toThrow("synthetic agent failure after the writes");

      expect(published).toEqual([]);
      expect(storageDeletes).toEqual([]);
      expect(await selectStaleRecipeIds(ctx.db, [recipeId])).toEqual([]);
      expect(
        await resolveLiveShortcode(ctx.db, alias.shortcode, "ingredient"),
      ).not.toBeNull();
      expect(
        await resolveLiveShortcode(ctx.db, created.item.id, "location"),
      ).not.toBeNull();

      // The same delete committed outside the agent transaction does drop
      // the orphaned object — the assertion above is not vacuous.
      await executeEntity(entityKernelContextSchema.parse(requestContext()), {
        action: "delete",
        entity: "location",
        ids: [parseShortcodeFor("location", created.item.id)],
      });
      expect(
        storageDeletes.map((path) => path.endsWith(`/${photo.key}`)),
      ).toEqual([true]);
    },
  );
});
