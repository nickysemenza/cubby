import { parseEntityId } from "@cubby/schemas/identifiers";
import { testEntityId } from "@cubby/schemas/testing";
import { count, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { entityEmbedding, ingredient } from "~/server/db/schema";
import { getAuditLog } from "~/server/repo/audit-log";
import { deleteRecipes } from "~/server/repo/recipe";

import { getDb, withTransaction } from "./database-helpers";
import { findOrphanedEntityEmbeddings } from "./entity-embedding";
import {
  createIngredient,
  deleteIngredients,
  findOrCreateIngredient,
  getIngredientByID,
  mergeIngredients,
  updateIngredient,
} from "./ingredient";
import {
  createRecipeFixture as createRecipe,
  ingredientRef,
  makeRecipeInput,
} from "./repo.fixtures";
import { resolveLiveShortcode } from "./shortcode-resolver";

describe("ingredient", () => {
  const ctx = withTestDb();

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

    let releaseTx1!: () => void;
    const tx1Committed = new Promise<void>((resolve) => {
      releaseTx1 = resolve;
    });

    // tx1 runs findOrCreate, then holds the transaction open (lock held) until
    // we release it below.
    const tx1 = withTransaction(ctx.db, async (tx) => {
      const row = await findOrCreateIngredient(tx, name);
      await tx1Committed;
      return row;
    });

    await new Promise((r) => setTimeout(r, 100));

    // tx2 races the same name; its INSERT will block on tx1's lock.
    const tx2 = withTransaction(ctx.db, async (tx) =>
      findOrCreateIngredient(tx, name),
    );

    await new Promise((r) => setTimeout(r, 100));
    releaseTx1();

    const [a, b] = await Promise.all([tx1, tx2]);

    // Both callers resolve to the same surviving row, no error thrown.
    expect(a.id).toEqual(b.id);

    const [result] = await getDb(ctx.db)
      .select({ count: count() })
      .from(ingredient);
    expect(result!.count).toEqual(1);
  });

  // Removal-path invariant (root CLAUDE.md, guard-enforced): `mergeIngredients`
  // is the only removal path in the repo that HARD-deletes its absorbed rows
  // rather than soft-deleting them — which made it easy to miss that the
  // absorbed ingredients' EntityEmbedding rows still need cleanup in the same
  // transaction. Mirrors the seed/assert shape of
  // inventory/embedding-cascade-invariant.integration.test.ts.
  it("mergeIngredients cleans up the absorbed ingredients' embeddings (no orphans)", async () => {
    const keeper = await findOrCreateIngredient(ctx.db, "embed cascade keeper");
    const alias = await findOrCreateIngredient(ctx.db, "embed cascade alias");

    // Minimal 3-dim vector — the HNSW index is partial on dimensions=1536, so
    // small test vectors insert fine (same trick as the inventory test).
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
        embedding: [0, 0, 0],
      });

    await mergeIngredients(
      ctx.db,
      { keepId: keeper.shortcode, mergeIds: [alias.shortcode] },
      ctx.actor,
    );

    // The alias row is HARD-deleted, so its embedding can't be re-read by id —
    // the only observable proof of cleanup is that it no longer appears as an
    // orphan (a soft-deleted or genuinely absent embedding both pass; a LIVE
    // embedding pointing at the now-hard-deleted alias id is exactly the bug).
    const orphaned = await findOrphanedEntityEmbeddings(ctx.db);
    expect(orphaned).toEqual([]);

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

  // `dryRun` is gone: `previewMergeIngredients` (preview_entity_operation) is
  // the preview, and it reads the same edge policy the mutation writes against.
  // What replaced the dry run's exactness on this path is `merged` — the rows
  // the DELETE actually removed, not the count the caller asked for.

  // Regression: the lean workbench fetch uses a relational query with raw-SQL
  // `extras` (recipeCount/cookbookOnly correlated subqueries) — exercise it end to
  // end so a Drizzle codegen break can't slip past typecheck. Replaced the 24 MB
  // full-relation fetch that made the workbench ~40s.

  // Regression: the ingredient list is lean — `appearsInRecipes` is {id,name}
  // refs (count + first pill), NOT the full recipe bodies / recipeUsages the old
  // `relations.ingredient.full` shipped (the over-fetch).

  // Regression: `productPresenceFilter` replaced the old boolean
  // `missingProductsOnly` param — "has" and "none" must partition ingredients
  // by whether they have at least one linked product, and the count returned
  // alongside the page must match (a plain leftJoin+count() over-counts "has"
  // once an ingredient has more than one product; the fix groups by ingredient
  // id before counting).

  // Regression: the presence join must carry notDeleted(product) — an
  // ingredient whose only product is soft-deleted counts as "none", not "has".
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
      cause: { reason: "INGREDIENT_HAS_RECIPES" },
    });

    // Deleting the recipe cascade-soft-deletes its section ingredients,
    // which is what clears the live usage.
    await deleteRecipes(ctx.db, [usingRecipe.entityId], ctx.actor);

    await expect(
      deleteIngredients(ctx.db, [usedIngredientId], ctx.actor),
    ).resolves.toEqual({ deleted: 1 });
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
