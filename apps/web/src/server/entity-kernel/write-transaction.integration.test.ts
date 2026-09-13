import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { fromPartial } from "@total-typescript/shoehorn";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { selectStaleRecipeIds } from "~/server/repo/recipe/totals";
import { makeRecipeInput } from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { createTestRequestContext } from "~/server/testing/request-context";

/**
 * Regression: the kernel's write transaction holds the row it is updating.
 * An adapter that reaches a service still bound to the request pool — the
 * recipe adapter's stale-marking `dispatchRecompute` — would then issue an
 * UPDATE on that same row from a second connection and wait on its own
 * transaction forever. The test database is a real pool, so a rebinding
 * regression shows up as a hang, not a wrong value.
 */
describe("entity kernel write transaction", () => {
  const ctx = withTestDb();
  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );

  afterEach(() => setCfEnv(undefined));

  const recordingQueue = () => {
    const published: Array<{ task: { kind: string } }> = [];
    setCfEnv(
      fromPartial<Env>({
        BACKGROUND_QUEUE: {
          sendBatch: async (
            messages: Iterable<{ body: { task: { kind: string } } }>,
          ) => {
            published.push(...[...messages].map((m) => m.body));
          },
        },
      }),
    );
    return published;
  };

  it(
    "updates a fresh recipe without deadlocking on its own stale mark, and publishes after commit",
    { timeout: 10_000 },
    async () => {
      const published = recordingQueue();
      const created = await executeEntity(context(), {
        action: "create",
        entity: "recipe",
        data: makeRecipeInput({ name: "Kernel write tx" }),
      });
      if (created.action !== "create") throw new Error("expected create");
      const entityId = await resolveLiveShortcode(
        ctx.db,
        created.item.id,
        "recipe",
      );
      if (!entityId) throw new Error("created recipe did not resolve");
      // A fresh recipe is the case whose stale mark actually rewrites the row.
      await context().services.recipeCosting.recomputeQueued([entityId]);
      expect(await selectStaleRecipeIds(ctx.db, [entityId])).toEqual([]);
      published.length = 0;

      await executeEntity(context(), {
        action: "update",
        entity: "recipe",
        id: parseShortcodeFor("recipe", created.item.id),
        data: { name: "Kernel write tx (renamed)" },
      });

      // The stale mark committed with the rename, and the wakeup went out
      // once — after the transaction — not from inside it.
      expect(await selectStaleRecipeIds(ctx.db, [entityId])).toEqual([
        entityId,
      ]);
      expect(published.map((m) => m.task.kind)).toContain(
        "recipe-totals.recompute",
      );
    },
  );
});
