import type { ActorContext } from "@cubby/schemas/context";
import { count, eq } from "drizzle-orm";
import { buildTestDB } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "~/server/db";
import { ingredient } from "~/server/db/schema";
import { upsertImportRecipe } from "~/server/repo/recipe";
import { getDb, withTransaction } from "./database-helpers";
import { findOrCreateIngredient, mergeIngredients } from "./ingredient";
import { makeImportRecipe } from "./repo.fixtures";

describe("ingredient", () => {
  let db: Database;
  let actor: ActorContext;
  let teardown: () => Promise<void>;

  beforeEach(async () => {
    ({ db, actor, teardown } = await buildTestDB());
    return teardown;
  });

  it("ingredient upsert with aliases", async () => {
    await withTransaction(db, async (tx) => {
      await findOrCreateIngredient(tx, "alias_1");
      await findOrCreateIngredient(tx, "test", ["alias_1"]);
    });
    const [result] = await getDb(db)
      .select({ count: count() })
      .from(ingredient);
    expect(result!.count).toEqual(1);
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

    let releaseTx1!: () => void;
    const tx1Committed = new Promise<void>((resolve) => {
      releaseTx1 = resolve;
    });

    // tx1 runs findOrCreate, then holds the transaction open (lock held) until
    // we release it below.
    const tx1 = withTransaction(db, async (tx) => {
      const row = await findOrCreateIngredient(tx, name);
      await tx1Committed;
      return row;
    });

    // Let tx1 reach (and hold) its uncommitted INSERT before tx2 starts.
    await new Promise((r) => setTimeout(r, 100));

    // tx2 races the same name; its INSERT will block on tx1's lock.
    const tx2 = withTransaction(db, async (tx) =>
      findOrCreateIngredient(tx, name),
    );

    // Give tx2 time to reach its blocked INSERT, then commit tx1 to unblock it.
    await new Promise((r) => setTimeout(r, 100));
    releaseTx1();

    const [a, b] = await Promise.all([tx1, tx2]);

    // Both callers resolve to the same surviving row, no error thrown.
    expect(a.id).toEqual(b.id);

    // Exactly one row exists.
    const [result] = await getDb(db)
      .select({ count: count() })
      .from(ingredient);
    expect(result!.count).toEqual(1);
  });
  it("ingredient merging works", async () => {
    await upsertImportRecipe(
      makeImportRecipe({
        meta: { title: "egg recipe" },
        sections: [
          {
            instructions: ["crack egg"],
            ingredients: ["eggs"],
          },
        ],
      }),
      db,
      actor,
    );
    const a = await findOrCreateIngredient(db, "egg");
    const b = await findOrCreateIngredient(db, "eggs");
    const c = await findOrCreateIngredient(db, "large brown eggs", [
      "large eggs",
    ]);
    const [resultAfterUpsert] = await getDb(db)
      .select({ count: count() })
      .from(ingredient);
    expect(resultAfterUpsert!.count).toEqual(3);

    await mergeIngredients(db, a.id, [b.id, c.id]);
    const [resultAfterMerge] = await getDb(db)
      .select({ count: count() })
      .from(ingredient);
    expect(resultAfterMerge!.count).toEqual(1);

    const updatedIngredient = await getDb(db).query.ingredient.findFirst({
      where: eq(ingredient.id, a.id),
    });
    expect(updatedIngredient).toBeDefined();
    expect(updatedIngredient!.aliases).toContain(b.name);
    expect(updatedIngredient!.aliases).toContain(c.name);
    expect(updatedIngredient!.aliases).toContain("large eggs");
  });
});
