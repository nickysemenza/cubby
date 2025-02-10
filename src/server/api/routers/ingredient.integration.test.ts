import { beforeEach, describe, expect, it } from "vitest";
import { findOrCreateIngredient, mergeIngredients } from "./ingredients";
import { type PrismaClient } from "@prisma/client";
import { buildTestDB } from "tooling/test-setup";
import { insertCompactRecipe } from "./recipe";

let prisma: PrismaClient;

// todo: point at test DB in CI
describe("ingredient", () => {
  beforeEach(async () => {
    // Get a isolated test database
    const res = await buildTestDB();
    prisma = res.prisma;
    return res.teardown;
  });

  it("ingredient upsert with aliases", async () => {
    await findOrCreateIngredient(prisma, "alias_1");
    await findOrCreateIngredient(prisma, "test", ["alias_1"]);
    const countAfterUpsert = await prisma.ingredient.count();
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
      prisma,
    );
    const a = await findOrCreateIngredient(prisma, "egg");
    const b = await findOrCreateIngredient(prisma, "eggs");
    const c = await findOrCreateIngredient(prisma, "large brown eggs", [
      "large eggs",
    ]);
    const countAfterUpsert = await prisma.ingredient.count();
    expect(countAfterUpsert).toEqual(3);

    await mergeIngredients(prisma, a.id, [b.id, c.id]);
    const countAfterMerge = await prisma.ingredient.count();
    expect(countAfterMerge).toEqual(1);

    const updatedIngredient = await prisma.ingredient.findFirstOrThrow({
      where: {
        id: a.id,
      },
    });
    expect(updatedIngredient.aliases).toContain(b.name);
    expect(updatedIngredient.aliases).toContain(c.name);
    expect(updatedIngredient.aliases).toContain("large eggs");
  });
});
