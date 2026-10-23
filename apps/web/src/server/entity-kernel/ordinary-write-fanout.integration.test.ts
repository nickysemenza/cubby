import { entitySchema } from "@cubby/schemas/entity";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { testUserId } from "@cubby/schemas/testing";
import { eq } from "drizzle-orm";
import { buildKernelContext } from "tooling/scenarios/context";
import {
  countTestDbQueries,
  TEST_USER_ID,
  withTestDb,
} from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  entityLink,
  ingredient as ingredientTable,
  product,
} from "~/server/db/schema";
import { findOrCreateIngredient } from "~/server/domains/ingredient/repo/crud";
import { createWish } from "~/server/domains/wish/repo";
import { executeEntity } from "~/server/entity-kernel";
import { executeEntityMutationRead } from "~/server/entity-kernel/execute";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  createProductIdentityFixture,
  insertEntityFixtures,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import {
  createRecipeFixture,
  makeRecipeInput,
} from "~/server/testing/repo.fixtures";

describe("ordinary scalar write fanout", () => {
  const ctx = withTestDb();
  let queue: ReturnType<typeof captureBackgroundQueue>;
  beforeEach(() => {
    queue = captureBackgroundQueue();
  });
  afterEach(() => queue.restore());
  it("captures an Ingredient applicability edit without reading linked Products", async () => {
    const ingredient = await findOrCreateIngredient(
      ctx.db,
      "Synthetic conversion input",
    );
    await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic linked ingredient product",
        ingredientId: ingredient.id,
      }),
      ctx.actor,
    );
    const measured = await countTestDbQueries(() =>
      executeEntityMutationRead(
        buildKernelContext(ctx.db, testUserId(TEST_USER_ID)),
        {
          action: "update",
          entity: "ingredient",
          id: parseShortcodeFor("ingredient", ingredient.shortcode),
          data: { naKinds: ["volume"] },
        },
        ["id"],
      ),
    );
    expect(measured.tables).not.toContain("Product");
    expect(measured.result.item).toMatchObject({ id: ingredient.shortcode });
    expect(
      await getDb(ctx.db)
        .select({ naKinds: ingredientTable.naKinds })
        .from(ingredientTable)
        .where(eq(ingredientTable.id, ingredient.id)),
    ).toEqual([{ naKinds: ["volume"] }]);
  });
  it("does not load Recipe composition for an ordinary note edit", async () => {
    const recipe = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({
        name: "Synthetic bounded recipe",
        sections: [{ name: "Synthetic retained section" }],
      }),
      ctx.actor,
    );
    const result = await countTestDbQueries(() =>
      executeEntity(buildKernelContext(ctx.db, testUserId(TEST_USER_ID)), {
        action: "update",
        entity: "recipe",
        id: recipe.id,
        data: { notes: "Synthetic saved recipe note" },
      }),
    );
    expect(
      result.tables.filter((table) =>
        ["RecipeSection", "RecipeSectionIngredient"].includes(table),
      ),
    ).toEqual([]);
  });
  it("does not hydrate untouched candidates for a Wish rename", async () => {
    const candidate = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic candidate" }),
      ctx.actor,
    );
    const wish = await createWish(
      ctx.db,
      {
        name: "Synthetic wish",
        notes: null,
        candidateProductIds: [candidate.id],
      },
      ctx.actor,
    );
    const original = await getDb(ctx.db).query.product.findFirst({
      where: eq(product.id, candidate.entityId),
    });
    if (!original) throw new Error("Expected candidate Product");
    const candidates = await insertEntityFixtures(
      ctx.db,
      product,
      "product",
      Array.from({ length: 1000 }, (_, index) => ({
        shortcode: `PRD-SYN-CANDIDATE-${index + 1}`,
        name: `Synthetic candidate ${index + 1}`,
        brandId: original.brandId,
        categoryId: original.categoryId,
      })),
    );
    await getDb(ctx.db)
      .insert(entityLink)
      .values(
        candidates.map(
          (candidate) =>
            ({
              kind: "wishCandidate",
              fromKind: entitySchema.enum.wish,
              fromEntityId: wish.entityId,
              toKind: entitySchema.enum.product,
              toEntityId: candidate.id,
            }) satisfies typeof entityLink.$inferInsert,
        ),
      );
    const context = buildKernelContext(ctx.db, testUserId(TEST_USER_ID));
    const rename = await countTestDbQueries(() =>
      executeEntity(context, {
        action: "update",
        entity: "wish",
        id: wish.output.id,
        data: { name: "Synthetic renamed wish" },
      }),
    );
    expect(rename.tables).not.toContain("EntityLink");
  });
});
