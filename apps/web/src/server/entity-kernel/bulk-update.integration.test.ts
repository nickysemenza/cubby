import { fromPartial } from "@total-typescript/shoehorn";
/**
 * Bulk writes must use the normal update contract: pantry changes stale recipe
 * costs, task changes resolve assignments/dependencies and run CalDAV guards,
 * dates are audited, and any failing row rolls back the entire selection.
 * Collection patches preserve each row's unrelated values. Scalar routing must
 * avoid hydrating records while domain writes retain their per-record hooks.
 */
import { and, eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { USDAClient } from "~/server/clients/usda";
import { getDb } from "~/server/db/helpers";
import { auditLog } from "~/server/db/schema";
import { findOrCreateIngredient } from "~/server/domains/ingredient/repo/crud";
import { selectStaleRecipeIds } from "~/server/domains/recipe/repo/totals";
import {
  entityKernelContextSchema,
  executeEntityAs,
} from "~/server/entity-kernel";
import { executeEntityMutationRead } from "~/server/entity-kernel/execute";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  createProductFixture,
  createRecipeFixture,
  ingredientRef,
  makeProductInput,
  makeRecipeInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import {
  entityBulkUpdateCommandSchema,
  type EntityKernelEntity,
} from "./contracts";

describe("generic bulk updates", () => {
  const ctx = withTestDb();
  let queue: ReturnType<typeof captureBackgroundQueue>;
  beforeEach(() => {
    queue = captureBackgroundQueue();
  });
  afterEach(() => queue.restore());
  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
  const bulk = (entity: string, ids: string[], data: unknown) =>
    executeEntityAs(
      context(),
      "bulkUpdate",
      entityBulkUpdateCommandSchema.parse({
        action: "bulkUpdate",
        entity,
        ids,
        data,
      }),
    );
  const read = async (entity: EntityKernelEntity, id: string) =>
    (await executeEntityAs(context(), "get", { entity, id, missing: "error" }))
      .item;

  it("fingerprints sourced summary writes from their snapshot without hydrating food", async () => {
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic cited product", fdc_id: 123456 }),
      ctx.actor,
    );
    const result = await executeEntityMutationRead(
      {
        ...context(),
        usdaClient: fromPartial<USDAClient>({
          findFood: async () => {
            throw new Error("Unrequested synthetic food hydration");
          },
        }),
      },
      {
        action: "update",
        entity: "product",
        id: product.id,
        data: { manufacturer: "Synthetic Cited Maker" },
        sources: [
          { fieldPath: "manufacturer", quote: "Synthetic maker plate" },
        ],
      },
      ["id"],
    );
    expect(result.item).toMatchObject({ id: product.id });
    expect(await read("product", product.id)).toMatchObject({
      sources: [
        expect.objectContaining({
          fieldPath: "manufacturer",
          supportsCurrentValue: true,
        }),
      ],
    });
  });

  it("recomputes recipe costs after bulk pantry planning changes", async () => {
    const ingredient = await findOrCreateIngredient(
      ctx.db,
      "Synthetic pantry flour",
    );
    const recipe = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({
        name: "Synthetic pantry recipe",
        sections: [
          {
            instructions: [{ instruction: "Mix" }],
            ingredients: [ingredientRef(ingredient.shortcode)],
          },
        ],
      }),
      ctx.actor,
    );
    await context().services.recipeCosting.recomputeQueued([recipe.entityId]);
    expect(await selectStaleRecipeIds(ctx.db, [recipe.entityId])).toEqual([]);
    await bulk("ingredient", [ingredient.shortcode], { usuallyOnHand: true });
    expect(await selectStaleRecipeIds(ctx.db, [recipe.entityId])).toEqual([
      recipe.entityId,
    ]);
  });

  it("runs task guards for every row and rolls earlier writes back on refusal", async () => {
    const first = await createRepoEntity(ctx, "task", {
      name: "Synthetic guarded first",
      trade: "other",
    });
    const second = await createRepoEntity(ctx, "task", {
      name: "Synthetic guarded second",
      trade: "other",
    });
    const seen: string[] = [];
    const base = context();
    await expect(
      executeEntityAs(
        {
          ...base,
          caldavHooks: {
            task: {
              beforeUpdate: async (_tx, id) => {
                seen.push(id);
                if (id === second.entityId)
                  throw new Error("Synthetic calendar refusal");
              },
            },
          },
        },
        "bulkUpdate",
        {
          entity: "task",
          ids: [first.output.id, second.output.id],
          data: { status: "done" },
        },
      ),
    ).rejects.toThrow("Synthetic calendar refusal");
    expect(seen).toEqual([first.entityId, second.entityId]);
    expect(await read("task", first.output.id)).toMatchObject({
      status: "not_started",
    });
    expect(await read("task", second.output.id)).toMatchObject({
      status: "not_started",
    });
  });

  it("resolves task assignment modes and blocked-by shortcodes through normal updates", async () => {
    const parent = await createRepoEntity(ctx, "task", {
      name: "Synthetic blocker",
      trade: "other",
    });
    const task = await createRepoEntity(ctx, "task", {
      name: "Synthetic dependent",
      trade: "other",
    });
    const project = await createRepoEntity(ctx, "project", {
      name: "Synthetic project",
    });
    await bulk("task", [task.output.id], {
      projectId: project.output.id,
      projectMode: "explicit",
      blockedByIds: [{ op: "add", key: parent.output.id }],
    });
    expect(await read("task", task.output.id)).toMatchObject({
      projectId: project.output.id,
      blockedByIds: [parent.output.id],
    });
    await bulk("task", [task.output.id], {
      projectMode: "explicit",
      projectId: null,
    });
    expect(await read("task", task.output.id)).toMatchObject({
      projectId: null,
    });
  });

  it("audits bulk expense date changes", async () => {
    const expense = await createRepoEntity(ctx, "expense", {
      name: "Synthetic dated line",
      date: "2026-04-01",
      cost: 12,
      trade: "other",
    });
    await bulk("expense", [expense.output.id], { date: "2026-04-02" });
    const entries = await getDb(ctx.db)
      .select({ changes: auditLog.changes })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityKind, "expense"),
          eq(auditLog.entityId, expense.entityId),
          eq(auditLog.action, "update"),
        ),
      );
    expect(entries).toEqual([
      {
        changes: expect.objectContaining({
          date: { from: "2026-04-01", to: "2026-04-02" },
        }),
      },
    ]);
  });

  it("rolls back a manufacturer collision and reports the conflicting selection", async () => {
    const first = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic collision",
        manufacturer: "Synthetic Alpha",
      }),
      ctx.actor,
    );
    const second = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic collision",
        manufacturer: "Synthetic Beta",
      }),
      ctx.actor,
    );
    const bystander = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic collision bystander",
        manufacturer: "Synthetic Gamma",
      }),
      ctx.actor,
    );
    await expect(
      bulk("product", [first.id, second.id, bystander.id], {
        manufacturer: "Synthetic Shared",
      }),
    ).rejects.toThrow(
      `Conflicting rows: ${[first.id, second.id].sort().join(", ")}`,
    );
    expect(await read("product", first.id)).toMatchObject({
      manufacturer: "Synthetic Alpha",
    });
    expect(await read("product", second.id)).toMatchObject({
      manufacturer: "Synthetic Beta",
    });
    expect(await read("product", bystander.id)).toMatchObject({
      manufacturer: "Synthetic Gamma",
    });
  });

  it("adds and removes bulk list values without replacing row-specific values", async () => {
    const first = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic list first",
        tags: ["mount-a", "old"],
      }),
      ctx.actor,
    );
    const second = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic list second", tags: ["mount-b"] }),
      ctx.actor,
    );
    await bulk("product", [first.id, second.id], {
      tags: [
        { op: "add", key: "shared" },
        { op: "remove", key: "old" },
      ],
    });
    expect(await read("product", first.id)).toMatchObject({
      tags: ["mount-a", "shared"],
    });
    expect(await read("product", second.id)).toMatchObject({
      tags: ["mount-b", "shared"],
    });
    await expect(
      bulk("product", [first.id], { tags: ["replacement"] }),
    ).rejects.toThrow(/tags|Invalid input/);
  });

  it("bulk edits an entity without a former handwritten bulk path", async () => {
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic generic vendor",
    });
    await bulk("vendor", [vendor.output.id], { notes: "Synthetic bulk note" });
    expect(await read("vendor", vendor.output.id)).toMatchObject({
      notes: "Synthetic bulk note",
    });
  });
});
