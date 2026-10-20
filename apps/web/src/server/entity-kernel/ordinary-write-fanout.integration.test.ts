import { entitySchema } from "@cubby/schemas/entity";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { testUserId } from "@cubby/schemas/testing";
import { sql } from "drizzle-orm";
import { buildKernelContext } from "tooling/scenarios/context";
import {
  countTestDbQueries,
  TEST_USER_ID,
  withTestDb,
} from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { findOrCreateIngredient } from "~/server/domains/ingredient/repo/crud";
import { createWish } from "~/server/domains/wish/repo";
import { executeEntity } from "~/server/entity-kernel";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  createProductFixture,
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
    await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic linked ingredient product",
        ingredientId: ingredient.id,
      }),
      ctx.actor,
    );
    const measured = await countTestDbQueries(() =>
      executeEntity(buildKernelContext(ctx.db, testUserId(TEST_USER_ID)), {
        action: "update",
        entity: "ingredient",
        id: parseShortcodeFor("ingredient", ingredient.shortcode),
        data: { naKinds: [] },
      }),
    );
    expect(measured.tables).not.toContain("Product");
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
    const candidate = await createProductFixture(
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
    await getDb(ctx.db).execute(sql`
      WITH candidates AS (
        INSERT INTO "Product" (shortcode,name,manufacturer,"categoryId")
        SELECT left(original.shortcode,3) || '-SYN-CANDIDATE-' || n, 'Synthetic candidate ' || n, 'Synthetic maker', original."categoryId"
        FROM "Product" original CROSS JOIN generate_series(1,1000) n WHERE original.id=${candidate.entityId}::uuid RETURNING id
      ) INSERT INTO "EntityLink" (kind,"fromKind","fromEntityId","toKind","toEntityId")
        SELECT 'wishCandidate',${entitySchema.enum.wish},${wish.entityId}::uuid,${entitySchema.enum.product},id FROM candidates`);
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
