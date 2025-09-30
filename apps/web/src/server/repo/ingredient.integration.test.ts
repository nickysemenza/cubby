import { beforeEach, describe, expect, it } from "vitest";
import { findOrCreateIngredient, mergeIngredients } from "./ingredient";
import { type PrismaClient } from "@prisma/client";
import { buildTestDB } from "tooling/test-setup";
import { insertCompactRecipe } from "~/server/repo/recipe";

describe("ingredient", () => {
  let prisma: PrismaClient;
  let projectId: string;

  beforeEach(async () => {
    const { prisma: db, projectId: pId, teardown } = await buildTestDB();
    prisma = db;
    projectId = pId;

    return teardown;
  });

  it("ingredient upsert with aliases", async () => {
    await findOrCreateIngredient(prisma, "alias_1", undefined, projectId);
    await findOrCreateIngredient(prisma, "test", ["alias_1"], projectId);
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
      projectId,
    );
    const a = await findOrCreateIngredient(prisma, "egg", undefined, projectId);
    const b = await findOrCreateIngredient(
      prisma,
      "eggs",
      undefined,
      projectId,
    );
    const c = await findOrCreateIngredient(
      prisma,
      "large brown eggs",
      ["large eggs"],
      projectId,
    );
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
