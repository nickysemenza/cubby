import { beforeEach, describe, expect, it } from "vitest";
import { findOrCreateIngredient, mergeIngredients } from "./ingredient";
import { type Database } from "~/server/db";
import { buildTestDB } from "tooling/test-setup";
import { insertCompactRecipe } from "~/server/repo/recipe";
import { unsafeIngredientId, type ProjectId } from "~/schemas/identifiers";

describe("ingredient", () => {
  let db: Database;
  let projectId: ProjectId;
  let teardown: () => Promise<void>;

  beforeEach(async () => {
    ({ db, projectId, teardown } = await buildTestDB());

    return teardown;
  });

  it("ingredient upsert with aliases", async () => {
    await findOrCreateIngredient(db, "alias_1", undefined, projectId);
    await findOrCreateIngredient(db, "test", ["alias_1"], projectId);
    const countAfterUpsert = await db.ingredient.count();
    expect(countAfterUpsert).toEqual(1);
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
    const countAfterUpsert = await db.ingredient.count();
    expect(countAfterUpsert).toEqual(3);

    await mergeIngredients(db, unsafeIngredientId(a.id), [
      unsafeIngredientId(b.id),
      unsafeIngredientId(c.id),
    ]);
    const countAfterMerge = await db.ingredient.count();
    expect(countAfterMerge).toEqual(1);

    const updatedIngredient = await db.ingredient.findFirstOrThrow({
      where: {
        id: a.id,
      },
    });
    expect(updatedIngredient.aliases).toContain(b.name);
    expect(updatedIngredient.aliases).toContain(c.name);
    expect(updatedIngredient.aliases).toContain("large eggs");
  });
});
