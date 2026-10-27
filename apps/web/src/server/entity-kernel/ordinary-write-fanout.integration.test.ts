import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { testUserId } from "@cubby/schemas/testing";
import { eq } from "drizzle-orm";
import { buildKernelContext } from "tooling/scenarios/context";
import { TEST_USER_ID, withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { ingredient as ingredientTable } from "~/server/db/schema";
import { findOrCreateIngredient } from "~/server/domains/ingredient/repo/crud";
import { executeEntityMutationRead } from "~/server/entity-kernel/execute";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

describe("ordinary scalar write fanout", () => {
  const ctx = withTestDb();
  let queue: ReturnType<typeof captureBackgroundQueue>;
  beforeEach(() => {
    queue = captureBackgroundQueue();
  });
  afterEach(() => queue.restore());
  it("captures an Ingredient applicability edit", async () => {
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
    const updated = await executeEntityMutationRead(
      buildKernelContext(ctx.db, testUserId(TEST_USER_ID)),
      {
        action: "update",
        entity: "ingredient",
        id: parseShortcodeFor("ingredient", ingredient.shortcode),
        data: { naKinds: ["volume"] },
      },
      ["id"],
    );
    expect(updated.item).toMatchObject({ id: ingredient.shortcode });
    expect(
      await getDb(ctx.db)
        .select({ naKinds: ingredientTable.naKinds })
        .from(ingredientTable)
        .where(eq(ingredientTable.id, ingredient.id)),
    ).toEqual([{ naKinds: ["volume"] }]);
  });
});
