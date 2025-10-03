import { beforeEach, describe, expect, it } from "vitest";
import { findOrCreateIngredient, mergeIngredients } from "./ingredient";
import { type Database } from "~/server/db";
import { buildTestDB } from "tooling/test-setup";
import { insertCompactRecipe } from "~/server/repo/recipe";
import { unsafeIngredientId, type ProjectId } from "~/schemas/identifiers";
import { getDb, withTransaction } from "./database-helpers";
import { ingredient } from "~/server/db/schema";
import { eq, count } from "drizzle-orm";

describe("ingredient", () => {
  let db: Database;
  let projectId: ProjectId;
  let teardown: () => Promise<void>;

  beforeEach(async () => {
    ({ db, projectId, teardown } = await buildTestDB());
    return teardown;
  });

  it("ingredient upsert with aliases", async () => {
    await withTransaction(db, async (tx) => {
      await findOrCreateIngredient(tx, "alias_1", undefined, projectId);
      await findOrCreateIngredient(tx, "test", ["alias_1"], projectId);
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
      projectId,
    );
    const a = await findOrCreateIngredient(db, "egg", undefined, projectId);
    const b = await findOrCreateIngredient(db, "eggs", undefined, projectId);
    const c = await findOrCreateIngredient(
      db,
      "large brown eggs",
      ["large eggs"],
      projectId,
    );
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
