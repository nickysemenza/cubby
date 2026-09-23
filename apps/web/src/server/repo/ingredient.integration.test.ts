import { parseEntityId } from "@cubby/schemas/identifiers";
import { testEntityId, testShortcode } from "@cubby/schemas/testing";
import { count, eq } from "drizzle-orm";
import { raceUniqueInsert, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { Database } from "~/server/db";
import {
  entityEmbedding,
  auditLog,
  ingredient,
  inventoryEntry,
  plant,
  product,
} from "~/server/db/schema";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { getAuditLog } from "~/server/repo/audit-log";
import { deleteRecipes } from "~/server/repo/recipe";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";
import { executeWorkflow, workflow } from "~/server/workflow-runtime";
import { precomputeEnrichmentProposalsWorkflow } from "~/server/workflows/ai.server";
import {
  mergeWorkflow,
  resolveOrCreateWorkflow,
} from "~/server/workflows/ingredient.server";

import { getDb, withTransaction } from "./database-helpers";
import { patchEntityRows } from "./entity-patch";
import {
  createIngredient,
  enrichmentWorkbenchIngredients,
  getIngredientsByIDsLean,
  deleteIngredients,
  findOrCreateIngredient,
  getIngredientByID,
  mergeIngredients,
  ingredientList,
  updateIngredient,
  updateIngredientsUsuallyOnHand,
} from "./ingredient";
import {
  createRecipeFixture as createRecipe,
  createPlantFixture,
  createProductFixture,
  ingredientRef,
  makeRecipeInput,
  makeProductInput,
} from "./repo.fixtures";
import { resolveLiveShortcode } from "./shortcode-resolver";

describe("ingredient", () => {
  const ctx = withTestDb();

  it("loads workbench gaps without enriching soft-deleted linked products", async () => {
    const item = await createIngredient(
      ctx.db,
      { name: "Workbench fixture" },
      ctx.actor,
    );
    await createRecipe(
      ctx.db,
      makeRecipeInput({
        name: "Workbench recipe",
        sections: [
          {
            name: "Main",
            instructions: [],
            ingredients: [ingredientRef(item.id)],
          },
        ],
      }),
      ctx.actor,
    );
    const live = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Live fixture", ingredientId: item.id }),
      ctx.actor,
    );
    const removed = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Removed fixture", ingredientId: item.id }),
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, removed.entityId));
    const rows = await enrichmentWorkbenchIngredients(ctx.db);
    expect(
      rows
        .find((row) => row.id === item.id)
        ?.product.map((linked) => linked.id),
    ).toEqual([live.id]);
    const id = parseEntityId(
      "ingredient",
      (await resolveLiveShortcode(ctx.db, item.id, "ingredient"))!,
    );
    const detail = await getIngredientByID(ctx.db, id);
    expect(detail?.product.map((linked) => linked.id)).toEqual([live.id]);
    const lean = await getIngredientsByIDsLean(ctx.db, [id]);
    expect(lean[0]?.product.map((linked) => linked.id)).toEqual([live.id]);
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, live.entityId));
    const gaps = await enrichmentWorkbenchIngredients(ctx.db);
    expect(gaps.find((row) => row.id === item.id)?.product).toEqual([]);
  });

  it("updates and merges ingredients that own a soft-deleted product", async () => {
    // The reader-side regression above did not cover the two operations that
    // actually broke in production: `updateIngredient` threw and rolled the write
    // back (it serializes the response INSIDE its transaction), while
    // `mergeIngredients` committed and then threw (it serializes after commit),
    // so a merge appeared to fail while having applied. Both went through
    // `enrichProductRowsWithDataQuality`, which only holds entries for live
    // products.
    const keeper = await createIngredient(
      ctx.db,
      { name: "Keeper with dead product" },
      ctx.actor,
    );
    const keeperId = parseEntityId(
      "ingredient",
      (await resolveLiveShortcode(ctx.db, keeper.id, "ingredient"))!,
    );
    const live = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Live linked", ingredientId: keeper.id }),
      ctx.actor,
    );
    const dead = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Dead linked", ingredientId: keeper.id }),
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, dead.entityId));

    // Update must succeed AND persist — a throw here discards the write.
    const updated = await updateIngredient(
      ctx.db,
      keeperId,
      { aliases: ["dead product alias"] },
      ctx.actor,
    );
    expect(updated.product.map((linked) => linked.id)).toEqual([live.id]);
    expect(updated.aliases).toEqual(["dead product alias"]);
    expect((await getIngredientByID(ctx.db, keeperId))?.aliases).toEqual([
      "dead product alias",
    ]);

    // Merge repoints DEAD products onto the survivor on purpose
    // (`liveOnly: false` in merge.ts), so this is the real production repro:
    // the survivor ends up owning a soft-deleted product and must still
    // serialize.
    const absorbed = await createIngredient(
      ctx.db,
      { name: "Absorbed with dead product" },
      ctx.actor,
    );
    const absorbedDead = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Dead linked on absorbed",
        ingredientId: absorbed.id,
      }),
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, absorbedDead.entityId));

    await mergeIngredients(
      ctx.db,
      // `createIngredient` returns the public shortcode as `id`; merge takes
      // shortcodes.
      { keepId: keeper.id, mergeIds: [absorbed.id] },
      ctx.actor,
    );
    const merged = await getIngredientByID(ctx.db, keeperId);
    expect(merged?.product.map((linked) => linked.id)).toEqual([live.id]);
    expect(merged?.aliases).toContain("Absorbed with dead product");
  });

  /**
   * `Plant.ingredientId` is a real FK onto the alias, and the merge ends in a
   * HARD delete — left unpointed, the merge would abort with a raw FK
   * violation instead of the declared `repoint`.
   */
  it("mergeIngredients repoints a linked plant's ingredientId onto the survivor", async () => {
    const keeper = await createIngredient(
      ctx.db,
      { name: "Merge keeper crop" },
      ctx.actor,
    );
    const keeperId = parseEntityId(
      "ingredient",
      (await resolveLiveShortcode(ctx.db, keeper.id, "ingredient"))!,
    );
    const alias = await createIngredient(
      ctx.db,
      { name: "Merge alias crop" },
      ctx.actor,
    );
    const grown = await createPlantFixture(
      ctx.db,
      { name: "Merge alias plant", ingredientId: alias.id },
      ctx.actor,
    );
    const grownId = parseEntityId(
      "plant",
      (await resolveLiveShortcode(ctx.db, grown.id, "plant"))!,
    );

    await mergeIngredients(
      ctx.db,
      { keepId: keeper.id, mergeIds: [alias.id] },
      ctx.actor,
    );

    expect(
      await getDb(ctx.db).query.plant.findFirst({
        where: eq(plant.id, grownId),
        columns: { ingredientId: true },
      }),
    ).toEqual({ ingredientId: keeperId });
  });

  it("streams declared enrichment windows with public ids and skips unresolved subjects", async () => {
    const items = [];
    for (let index = 0; index < 7; index++) {
      const created = await createIngredient(
        ctx.db,
        { name: `Enrichment fixture ${index}` },
        ctx.actor,
      );
      items.push({
        id: created.id,
        name: `Enrichment fixture ${index}`,
        wantUsda: false,
        wantMerge: false,
      });
    }
    const context = requireActor(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const events = [];
    for await (const event of precomputeEnrichmentProposalsWorkflow(context, {
      items: [
        ...items,
        {
          id: testShortcode("ingredient", "ING-ZZZZ"),
          name: "Missing enrichment subject",
          wantUsda: false,
          wantMerge: false,
        },
      ],
    }))
      events.push(event);
    expect(events[0]).toEqual({ type: "progress", done: 0, total: 7 });
    expect(events.slice(1, -1)).toEqual(
      items.map((item, index) => ({
        type: "progress",
        done: index + 1,
        total: 7,
        item: {
          id: item.id,
          usda: { food: null, confidence: "low", reasoning: "" },
          merge: null,
        },
      })),
    );
    expect(events.at(-1)).toEqual({ type: "done", result: { processed: 7 } });
  });

  it("resolves aliases through the workflow and keeps automatic creations off the staple list", async () => {
    const existing = await createIngredient(
      ctx.db,
      {
        name: "Workflow salt",
        aliases: ["Workflow seasoning"],
        usuallyOnHand: true,
      },
      ctx.actor,
    );
    const rows = await resolveOrCreateWorkflow(ctx.db, {
      names: ["Workflow seasoning", "Workflow pepper", " workflow pepper "],
    });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ id: existing.id, created: false });
    expect(rows[1]).toMatchObject({ created: true });
    expect(rows[2]?.id).toBe(rows[1]?.id);
    const id = rows[1]?.entityId;
    expect(id).toBeDefined();
    if (!id) throw new Error("Expected newly resolved ingredient");
    expect(
      (await getIngredientByID(ctx.db, parseEntityId("ingredient", id)))
        .usuallyOnHand,
    ).toBe(false);
  });

  it("rolls back a shared scalar patch with its audit and preserves omitted values", async () => {
    const row = await findOrCreateIngredient(ctx.db, "scalar patch fixture");
    const definition = {
      entity: "ingredient",
      table: ingredient,
      fields: ["usuallyOnHand"],
    } as const;
    const audits = () =>
      getDb(ctx.db)
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, row.id));
    const before = await audits();
    await expect(
      withTransaction(ctx.db, async (tx) => {
        await patchEntityRows(tx, ctx.actor, definition, [row.id], {
          usuallyOnHand: true,
        });
        throw new Error("abort outer operation");
      }),
    ).rejects.toThrow("abort outer operation");
    expect((await getIngredientByID(ctx.db, row.id)).usuallyOnHand).toBe(false);
    expect(await audits()).toEqual(before);

    expect(
      await patchEntityRows(ctx.db, ctx.actor, definition, [row.id], {
        usuallyOnHand: undefined,
      }),
    ).toEqual([]);
    expect(
      await patchEntityRows(ctx.db, ctx.actor, definition, [row.id], {
        usuallyOnHand: false,
      }),
    ).toEqual([]);
    expect(await audits()).toEqual(before);
    await expect(
      patchEntityRows(ctx.db, ctx.actor, definition, [row.id], {
        name: "not permitted",
      }),
    ).rejects.toThrow("Undeclared ingredient patch field");
    expect((await getIngredientByID(ctx.db, row.id)).name).toBe(
      "scalar patch fixture",
    );
  });

  it("finishes required effects after a repository-owned commit before reporting cancellation", async () => {
    const row = await findOrCreateIngredient(ctx.db, "committed call fixture");
    const controller = new AbortController();
    const observed: boolean[] = [];
    const definition = workflow<Database, typeof row.id>("ownedTransaction")
      .commit("mark", async ({ context }, { input }) => {
        const result = await updateIngredientsUsuallyOnHand(
          context,
          [input],
          { usuallyOnHand: true },
          ctx.actor,
        );
        controller.abort();
        return result;
      })
      .effect("observe", async ({ context, signal, scope }, { input }) => {
        expect(signal.aborted).toBe(false);
        expect(scope).toBe("afterCommit");
        observed.push((await getIngredientByID(context, input)).usuallyOnHand);
      })
      .output(({ mark }) => mark);
    await expect(
      executeWorkflow(definition, {
        context: ctx.db,
        input: row.id,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      name: "WorkflowCancelledError",
      committed: true,
      effectsPending: false,
    });
    expect(observed).toEqual([true]);
    expect((await getIngredientByID(ctx.db, row.id)).usuallyOnHand).toBe(true);
  });

  it("persists pantry assumptions separately from aliases, merges, and inventory", async () => {
    const plain = await createIngredient(
      ctx.db,
      { name: "pantry plain", aliases: [] },
      ctx.actor,
    );
    const staple = await createIngredient(
      ctx.db,
      {
        name: "pantry staple",
        aliases: ["pantry staple alias"],
        usuallyOnHand: true,
      },
      ctx.actor,
    );
    const distinct = await createIngredient(
      ctx.db,
      { name: "pantry distinct", aliases: [] },
      ctx.actor,
    );
    expect(plain.usuallyOnHand).toBe(false);
    expect(staple.usuallyOnHand).toBe(true);
    expect(distinct.usuallyOnHand).toBe(false);

    const plainId = parseEntityId(
      "ingredient",
      (await resolveLiveShortcode(ctx.db, plain.id, "ingredient"))!,
    );
    const stapleId = parseEntityId(
      "ingredient",
      (await resolveLiveShortcode(ctx.db, staple.id, "ingredient"))!,
    );
    const distinctId = parseEntityId(
      "ingredient",
      (await resolveLiveShortcode(ctx.db, distinct.id, "ingredient"))!,
    );

    // An update that omits the setting preserves it.
    await updateIngredient(
      ctx.db,
      stapleId,
      { name: "pantry staple renamed" },
      ctx.actor,
    );
    expect((await getIngredientByID(ctx.db, stapleId)).usuallyOnHand).toBe(
      true,
    );

    const beforeInventory = await getDb(ctx.db).select().from(inventoryEntry);
    await updateIngredientsUsuallyOnHand(
      ctx.db,
      [plainId, distinctId],
      { usuallyOnHand: true },
      ctx.actor,
    );
    const afterInventory = await getDb(ctx.db).select().from(inventoryEntry);
    expect(afterInventory).toEqual(beforeInventory);

    const filtered = await ingredientList(ctx.db, { usuallyOnHand: true }, [], {
      pageIndex: 0,
      pageSize: 50,
    });
    expect(filtered.data.map((row) => row.id)).toEqual(
      expect.arrayContaining([plain.id, staple.id, distinct.id]),
    );

    const keeper = await createIngredient(
      ctx.db,
      { name: "pantry keeper", aliases: [], usuallyOnHand: true },
      ctx.actor,
    );
    const loser = await createIngredient(
      ctx.db,
      { name: "pantry loser", aliases: [], usuallyOnHand: false },
      ctx.actor,
    );
    await mergeWorkflow(
      entityKernelContextSchema.parse(createTestRequestContext(ctx.db)),
      { keepId: keeper.id, mergeIds: [loser.id] },
    );
    const keeperId = parseEntityId(
      "ingredient",
      (await resolveLiveShortcode(ctx.db, keeper.id, "ingredient"))!,
    );
    expect((await getIngredientByID(ctx.db, keeperId)).usuallyOnHand).toBe(
      true,
    );
  });

  it("concurrent findOrCreate of the same new ingredient yields one row, no 500", async () => {
    // Cross-request race, deterministically forced. Two separate transactions
    // both create the SAME new ingredient:
    //   tx1: SELECT (miss) -> INSERT (uncommitted, holds the row lock)
    //   tx2: SELECT (miss, READ COMMITTED can't see tx1's row) -> INSERT BLOCKS
    //   tx1 commits -> tx2's INSERT unblocks
    // Before the fix tx2's INSERT raised a unique violation that aborted the txn
    // (-> 500). With ON CONFLICT DO NOTHING it raises nothing, returns no row,
    // and the re-SELECT finds tx1's committed row.
    const name = "racy salt";

    // tx1 runs findOrCreate, then holds the transaction open (lock held) until
    // raceUniqueInsert confirms tx2 is blocked on it.
    // tx2 races the same name; its INSERT blocks on tx1's lock.
    const { winner: a, loser: b } = await raceUniqueInsert(ctx, {
      winner: ({ releaseSignal, markWinnerReady }) =>
        withTransaction(ctx.db, async (tx) => {
          const row = await findOrCreateIngredient(tx, name);
          markWinnerReady();
          await releaseSignal;
          return row;
        }),
      loser: () =>
        withTransaction(ctx.db, async (tx) => findOrCreateIngredient(tx, name)),
    });

    // Both callers resolve to the same surviving row, no error thrown.
    expect(a.id).toEqual(b.id);

    const [result] = await getDb(ctx.db)
      .select({ count: count() })
      .from(ingredient);
    expect(result!.count).toEqual(1);
  });

  // Removal-path invariant (root AGENTS.md, guard-enforced): `mergeIngredients`
  // is the only removal path in the repo that HARD-deletes its absorbed rows
  // rather than soft-deleting them — which made it easy to miss that the
  // absorbed ingredients' EntityEmbedding rows still need cleanup in the same
  // transaction. Mirrors the seed/assert shape of
  // inventory/embedding-cascade-invariant.integration.test.ts.
  it("mergeIngredients cleans up the absorbed ingredients' embeddings (no orphans)", async () => {
    const keeper = await findOrCreateIngredient(ctx.db, "embed cascade keeper");
    const alias = await findOrCreateIngredient(ctx.db, "embed cascade alias");

    await getDb(ctx.db)
      .insert(entityEmbedding)
      .values({
        entityType: "ingredient",
        entityId: alias.id,
        embeddingText: `ingredient ${alias.id}`,
        embeddingHash: `hash-${alias.id}`,
        provider: "test",
        model: "test",
        dimensions: 3,
      });

    await mergeIngredients(
      ctx.db,
      { keepId: keeper.shortcode, mergeIds: [alias.shortcode] },
      ctx.actor,
    );

    // The alias row is HARD-deleted, so its embedding can't be re-read by id —
    // the only observable proof of cleanup is that its embedding row was
    // soft-deleted in the same transaction, asserted directly against the
    // table rather than through a detector.
    const embeddingRow = await getDb(ctx.db).query.entityEmbedding.findFirst({
      where: eq(entityEmbedding.entityId, alias.id),
    });
    expect(embeddingRow?.deletedAt).not.toBeNull();
  });

  it("merge fails loud on an unknown alias id (no silent no-op)", async () => {
    const a = await findOrCreateIngredient(ctx.db, "keeper");
    const bogus = testEntityId(
      "ingredient",
      "00000000-0000-0000-0000-000000000000",
    );

    await expect(
      mergeIngredients(
        ctx.db,
        { keepId: a.shortcode, mergeIds: [bogus] },
        ctx.actor,
      ),
    ).rejects.toThrow(/not found/i);

    const keeper = await getDb(ctx.db).query.ingredient.findFirst({
      where: eq(ingredient.id, a.id),
    });
    expect(keeper).toBeDefined();
    expect(keeper!.aliases).toHaveLength(0);
  });
});

describe("deleteIngredients", () => {
  const ctx = withTestDb();

  it("rejects an ingredient still used in a live recipe, succeeds once the recipe is deleted", async () => {
    const usedIngredient = await createIngredient(
      ctx.db,
      { name: "Recipe-Blocked Ingredient", aliases: [] },
      ctx.actor,
    );
    const usedIngredientId = parseEntityId(
      "ingredient",
      (await resolveLiveShortcode(ctx.db, usedIngredient.id, "ingredient"))!,
    );
    const usingRecipe = await createRecipe(
      ctx.db,
      makeRecipeInput({
        name: "Uses Recipe-Blocked Ingredient",
        sections: [
          {
            name: "Main",
            instructions: [{ instruction: "Mix" }],
            ingredients: [ingredientRef(usedIngredient.id)],
          },
        ],
      }),
      ctx.actor,
    );

    await expect(
      deleteIngredients(ctx.db, [usedIngredientId], ctx.actor),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      reason: "INGREDIENT_HAS_RECIPES",
    });

    // Deleting the recipe cascade-soft-deletes its section ingredients,
    // which is what clears the live usage.
    await deleteRecipes(ctx.db, [usingRecipe.entityId], ctx.actor);

    await expect(
      deleteIngredients(ctx.db, [usedIngredientId], ctx.actor),
    ).resolves.toEqual({ deleted: 1 });
  });

  /**
   * `Plant.ingredientId` is informational-only (INGREDIENT_DELETE_EDGE_POLICY
   * declares it `detach`), so deleting the ingredient must clear the link
   * rather than block or leave a dangling FK.
   */
  it("clears a linked plant's ingredientId when the ingredient is deleted", async () => {
    const crop = await createIngredient(
      ctx.db,
      { name: "Linked crop", aliases: [] },
      ctx.actor,
    );
    const cropId = parseEntityId(
      "ingredient",
      (await resolveLiveShortcode(ctx.db, crop.id, "ingredient"))!,
    );
    const grown = await createPlantFixture(
      ctx.db,
      { name: "Linked crop plant", ingredientId: crop.id },
      ctx.actor,
    );
    const grownId = parseEntityId(
      "plant",
      (await resolveLiveShortcode(ctx.db, grown.id, "plant"))!,
    );

    await expect(
      deleteIngredients(ctx.db, [cropId], ctx.actor),
    ).resolves.toEqual({ deleted: 1 });

    expect(
      await getDb(ctx.db).query.plant.findFirst({
        where: eq(plant.id, grownId),
        columns: { ingredientId: true },
      }),
    ).toEqual({ ingredientId: null });
  });
});

/**
 * `createEntityCrud`'s `update` is transactional and JOINS a caller's open
 * transaction (`withTransactionOn`) rather than opening its own. Ingredient is
 * the second of the two entities built on the factory (expense is the other, and
 * `expense.integration.test.ts` pins the same properties from the charge side),
 * so these assert the generic contract once, here.
 */
describe("ingredient repository — transactional update", () => {
  const ctx = withTestDb();

  it("a throw after the UPDATE leaves no column change and no audit row", async () => {
    const original = "throw-after-update original";
    const created = await createIngredient(
      ctx.db,
      { name: original, aliases: [] },
      ctx.actor,
    );
    const createdId = parseEntityId(
      "ingredient",
      (await resolveLiveShortcode(ctx.db, created.id, "ingredient"))!,
    );

    await expect(
      withTransaction(ctx.db, async (tx) => {
        // Succeeds: the UPDATE lands and the audit entry is written…
        const updated = await updateIngredient(
          tx,
          createdId,
          { name: "throw-after-update renamed" },
          ctx.actor,
        );
        expect(updated.name).toBe("throw-after-update renamed");
        // …and then the caller fails, which must undo BOTH. Before `update` was
        // transactional the column write and its audit row were already
        // committed by the time the caller threw.
        throw new Error("caller failed after the update");
      }),
    ).rejects.toThrow("caller failed after the update");

    expect((await getIngredientByID(ctx.db, createdId)).name).toBe(original);

    const audit = await getAuditLog(ctx.db, {
      entityType: "ingredient",
      entityId: createdId,
      limit: 20,
    });
    expect(audit.entries.filter((e) => e.action === "update")).toEqual([]);
  });
});
