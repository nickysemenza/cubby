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
  findOrCreateVendor,
  getVendorByID,
} from "~/server/domains/vendor/repo/vendor";
import {
  entityKernelContextSchema,
  executeEntityAs,
} from "~/server/entity-kernel";
import { executeEntityMutationRead } from "~/server/entity-kernel/execute";
import { executeEntitySelectionIds } from "~/server/entity-kernel/selection-ids";
import {
  captureBackgroundQueue,
  drainDerivedRefreshFrontier,
  drainRecipeRefreshJobs,
} from "~/server/testing/background-queue";
import {
  createProductFixture,
  createProductIdentityFixture,
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
  const bulk = async (entity: string, ids: string[], data: unknown) =>
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

  it("preserves existing Wish candidates while adding and removing shared candidates", async () => {
    const products = await Promise.all(
      ["A", "B", "C"].map((name) =>
        createProductFixture(
          ctx.db,
          makeProductInput({ name: `Synthetic candidate ${name}` }),
          ctx.actor,
        ),
      ),
    );
    const wish = (
      await executeEntityAs(context(), "create", {
        entity: "wish",
        data: {
          name: "Synthetic candidate selection",
          notes: null,
          candidateProductIds: [products[0]!.id, products[1]!.id],
        },
      })
    ).item;
    await bulk("wish", [wish.id], {
      candidateProductIds: [{ op: "add", key: products[2]!.id }],
    });
    expect(await read("wish", wish.id)).toMatchObject({
      candidates: expect.arrayContaining(
        products.map((product) => expect.objectContaining({ id: product.id })),
      ),
    });
    await bulk("wish", [wish.id], {
      candidateProductIds: [{ op: "remove", key: products[1]!.id }],
    });
    expect(await read("wish", wish.id)).toMatchObject({
      candidates: expect.arrayContaining(
        [products[0], products[2]].map((product) =>
          expect.objectContaining({ id: product!.id }),
        ),
      ),
    });
    expect(await read("wish", wish.id)).toMatchObject({
      candidates: expect.not.arrayContaining([
        expect.objectContaining({ id: products[1]!.id }),
      ]),
    });
  });

  it("patches structured allocations without replacing each transaction's other purchase", async () => {
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic allocation vendor",
    });
    const purchases = await Promise.all(
      ["A", "B", "C", "D"].map((orderId) =>
        createRepoEntity(ctx, "purchase", {
          vendorId: vendor.output.id,
          date: "2026-04-01",
          orderId: `synthetic-${orderId}`,
        }),
      ),
    );
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic allocation account",
      identity: { kind: "credit_card", issuer: null, network: "visa" },
      cardNumbers: [],
    });
    const transactions = await Promise.all(
      [0, 1].map((index) =>
        createRepoEntity(ctx, "financialTransaction", {
          accountId: account.output.id,
          kind: "purchase",
          status: "posted",
          postedDate: "2026-04-01",
          amount: 4,
          allocations: [{ purchaseId: purchases[index]!.output.id, amount: 4 }],
        }),
      ),
    );
    await bulk(
      "financialTransaction",
      transactions.map((item) => item.output.id),
      {
        amount: 10,
        allocations: [
          {
            op: "add",
            key: { purchaseId: purchases[2]!.output.id },
            value: { amount: 6 },
          },
        ],
      },
    );
    for (const [index, transaction] of transactions.entries()) {
      expect(
        await read("financialTransaction", transaction.output.id),
      ).toMatchObject({
        allocations: expect.arrayContaining([
          { purchaseId: purchases[index]!.output.id, amount: 4 },
          { purchaseId: purchases[2]!.output.id, amount: 6 },
        ]),
      });
    }
    await bulk(
      "financialTransaction",
      transactions.map((item) => item.output.id),
      {
        allocations: [
          { op: "remove", key: { purchaseId: purchases[2]!.output.id } },
          {
            op: "add",
            key: { purchaseId: purchases[3]!.output.id },
            value: { amount: 6 },
          },
        ],
      },
    );
    for (const [index, transaction] of transactions.entries())
      expect(
        await read("financialTransaction", transaction.output.id),
      ).toMatchObject({
        allocations: expect.arrayContaining([
          expect.objectContaining({
            purchaseId: purchases[index]!.output.id,
            amount: 4,
          }),
          expect.objectContaining({
            purchaseId: purchases[3]!.output.id,
            amount: 6,
          }),
        ]),
      });
  });

  it("adds and removes shared recipe sections without duplicating or losing each recipe's composition", async () => {
    const ingredient = await findOrCreateIngredient(
      ctx.db,
      "Synthetic section ingredient",
    );
    const recipes = await Promise.all(
      ["A", "B"].map((suffix) =>
        createRecipeFixture(
          ctx.db,
          makeRecipeInput({
            name: `Synthetic section recipe ${suffix}`,
            sections: [
              {
                name: `Synthetic original ${suffix}`,
                ingredients: [ingredientRef(ingredient.shortcode)],
                instructions: [
                  { instruction: `Synthetic original step ${suffix}` },
                ],
              },
            ],
          }),
          ctx.actor,
        ),
      ),
    );
    const section = {
      name: "Synthetic shared section",
      instructions: [{ instruction: "Synthetic shared step" }],
    };
    const ids = recipes.map((recipe) => recipe.id);
    for (let attempt = 0; attempt < 2; attempt++)
      await bulk("recipe", ids, { sections: [{ op: "add", key: section }] });
    for (const [index, recipe] of recipes.entries()) {
      const item = await read("recipe", recipe.id);
      expect(item).toMatchObject({
        sections: [
          expect.objectContaining({
            name: `Synthetic original ${index === 0 ? "A" : "B"}`,
          }),
          expect.objectContaining(section),
        ],
      });
    }
    await bulk("recipe", ids, { sections: [{ op: "remove", key: section }] });
    for (const [index, recipe] of recipes.entries())
      expect(await read("recipe", recipe.id)).toMatchObject({
        sections: [
          expect.objectContaining({
            name: `Synthetic original ${index === 0 ? "A" : "B"}`,
          }),
        ],
      });
  });

  it("returns summary writes without hydrating unrequested food", async () => {
    const product = await createProductIdentityFixture(
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
        data: {
          brandId: (
            await getVendorByID(
              ctx.db,
              await findOrCreateVendor(ctx.db, "Synthetic Cited Maker"),
            )
          ).id,
        },
      },
      ["id"],
    );
    expect(result.item).toMatchObject({ id: product.id });
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
    await drainDerivedRefreshFrontier(ctx.db);
    await context().services.recipeCosting.recomputeQueued([recipe.entityId]);
    await drainRecipeRefreshJobs(ctx.db, context().services.recipeCosting);
    expect(await selectStaleRecipeIds(ctx.db, [recipe.entityId])).toEqual([]);
    await bulk("ingredient", [ingredient.shortcode], { usuallyOnHand: true });
    await drainDerivedRefreshFrontier(ctx.db);
    await drainRecipeRefreshJobs(ctx.db, context().services.recipeCosting);
    expect(await selectStaleRecipeIds(ctx.db, [recipe.entityId])).toEqual([]);
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
    const outside = await createRepoEntity(ctx, "task", {
      name: "Synthetic outside bulk scope",
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
    await drainDerivedRefreshFrontier(ctx.db);
    const matching = await executeEntitySelectionIds(context(), {
      entity: "task",
      filters: { search: "Synthetic guarded" },
      limit: 10,
    });
    expect(matching.ids.sort()).toEqual(
      [first.output.id, second.output.id].sort(),
    );
    await bulk("task", matching.ids, { status: "done" });
    for (const selected of [first, second])
      expect(await read("task", selected.output.id)).toMatchObject({
        status: "done",
      });
    expect(await read("task", outside.output.id)).toMatchObject({
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

  it("rolls back a Brand reference collision and reports the conflicting selection", async () => {
    const first = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic collision",
        brandId: await findOrCreateVendor(ctx.db, "Synthetic Alpha"),
      }),
      ctx.actor,
    );
    const second = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic collision",
        brandId: await findOrCreateVendor(ctx.db, "Synthetic Beta"),
      }),
      ctx.actor,
    );
    const bystander = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic collision bystander",
        brandId: await findOrCreateVendor(ctx.db, "Synthetic Gamma"),
      }),
      ctx.actor,
    );
    await expect(
      bulk("product", [first.id, second.id, bystander.id], {
        brandId: (
          await getVendorByID(
            ctx.db,
            await findOrCreateVendor(ctx.db, "Synthetic Shared"),
          )
        ).id,
      }),
    ).rejects.toThrow(
      `selected rows: ${[first.id, second.id, bystander.id].join(", ")}`,
    );
    expect(await read("product", first.id)).toMatchObject({
      brandName: "Synthetic Alpha",
    });
    expect(await read("product", second.id)).toMatchObject({
      brandName: "Synthetic Beta",
    });
    expect(await read("product", bystander.id)).toMatchObject({
      brandName: "Synthetic Gamma",
    });
  });

  it("adds and removes bulk list values without replacing row-specific values", async () => {
    const first = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic list first",
        tags: ["mount-a", "old"],
      }),
      ctx.actor,
    );
    const second = await createProductIdentityFixture(
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
