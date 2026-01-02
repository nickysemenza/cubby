import { count, eq } from "drizzle-orm";
import { buildTestDB } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import type { ActorContext } from "~/schemas/context";
import { unsafeIngredientId, unsafeUserId } from "~/schemas/identifiers";
import type { Database } from "~/server/db";
import { ingredient } from "~/server/db/schema";
import { insertCompactRecipe } from "~/server/repo/recipe";
import { getDb, withTransaction } from "./database-helpers";
import { findOrCreateIngredient, mergeIngredients } from "./ingredient";

const TEST_ACTOR: ActorContext = {
  userId: unsafeUserId("test-user-id"),
  source: "ui",
};

describe("ingredient", () => {
  let db: Database;
  let teardown: () => Promise<void>;

  beforeEach(async () => {
    ({ db, teardown } = await buildTestDB());
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
  it("ingredient merging works", async () => {
    await insertCompactRecipe(
      {
        name: "egg recipe",
        sections: [
          {
            instructions: ["crack egg"],
            ingredients: ["eggs"],
          },
        ],
      },
      db,
      TEST_ACTOR,
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

    await mergeIngredients(db, unsafeIngredientId(a.id), [
      unsafeIngredientId(b.id),
      unsafeIngredientId(c.id),
    ]);
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
