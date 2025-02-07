import { beforeEach, describe, expect, it } from "vitest";
import { findOrCreateIngredient } from "./ingredients";
import { type PrismaClient } from "@prisma/client";
import { buildTestDB } from "tooling/test-setup";

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
});
