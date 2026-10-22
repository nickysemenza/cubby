import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { recipe, expense, job } from "~/server/db/schema";
import { findOrCreateIngredient } from "~/server/domains/ingredient/repo/crud";
import {
  enqueueJob,
  claimJob,
  publishJobPage,
} from "~/server/generic/jobs/repo/jobs";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import {
  createRecipeFixture,
  makeRecipeInput,
  createProductIdentityFixture,
  makeProductInput,
  ingredientRef,
} from "~/server/testing/repo.fixtures";
import { refreshFamilyHandler } from "~/server/workflows/background-tasks/refresh-families";

// Recipe output must survive lost wakes and reject a prepared superseded page.
describe("recipe Job publication", () => {
  const ctx = withTestDb();
  const drain = async () => {
    for (let page = 0; page < 1000; page++) {
      const [execution] = await getDb(ctx.db)
        .select()
        .from(job)
        .where(eq(job.key, "refresh:recipes"));
      if (!execution || execution.state === "completed") return;
      if (execution.state === "failed")
        throw new Error(execution.error ?? "Synthetic recipe Job failed");
      await advanceJob(ctx.db, execution.id, {
        "refresh.family": refreshFamilyHandler,
      });
    }
    throw new Error("Synthetic recipe Job did not finish");
  };
  const invalidateRecipes = async () => {
    await enqueueJob(ctx.db, {
      key: "refresh:recipes",
      kind: "refresh.family",
      input: { family: "recipes" },
      invalidate: true,
    });
    await drain();
  };

  it("rejects a prepared recipe page after a later authoritative save", async () => {
    const execution = await enqueueJob(ctx.db, {
      key: "refresh:recipes",
      kind: "refresh.family",
      input: { family: "recipes" },
    });
    const claim = await claimJob(ctx.db, execution.id);
    if (!claim) throw new Error("Missing synthetic recipe claim");
    await enqueueJob(ctx.db, {
      key: execution.key,
      kind: execution.kind,
      input: execution.input,
      invalidate: true,
    });
    let published = false;
    expect(
      await publishJobPage(ctx.db, claim, { done: true }, async () => {
        published = true;
      }),
    ).toBe(false);
    expect(published).toBe(false);
  });

  it.each(["price edit", "removal", "endpoint reassignment"])(
    "repairs populated recipe totals after a SQL-only Expense %s",
    async (change) => {
      const ingredient = await findOrCreateIngredient(
        ctx.db,
        "Synthetic repair ingredient",
      );
      const product = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({
          name: "Synthetic expense-priced product",
          ingredientId: ingredient.id,
          price: null,
        }),
        ctx.actor,
      );
      const other = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Synthetic reassigned product", price: null }),
        ctx.actor,
      );
      const charge = await createRepoEntity(ctx, "expense", {
        name: "Synthetic recipe price evidence",
        cost: 10,
        date: "2026-01-01",
        trade: "other",
        productId: product.id,
        lineKind: "principal",
        productQuantity: 1,
      });
      const subject = await createRecipeFixture(
        ctx.db,
        makeRecipeInput({
          name: "Synthetic expense-priced recipe",
          sections: [
            {
              ingredients: [
                ingredientRef(ingredient.shortcode, {
                  amounts: [{ value: 1, unit: "each" }],
                }),
              ],
            },
          ],
        }),
        ctx.actor,
      );
      const stored = async () =>
        (
          await getDb(ctx.db).query.recipe.findFirst({
            where: eq(recipe.id, subject.entityId),
          })
        )?.totals;
      const repair = invalidateRecipes;
      await drain();
      await repair();
      const before = await stored();
      expect(before).toMatchObject({ cost: { lower: 10 } });
      const fields =
        change === "price edit"
          ? { cost: 20 }
          : change === "removal"
            ? { deletedAt: new Date() }
            : { productId: other.entityId };
      await getDb(ctx.db)
        .update(expense)
        .set(fields)
        .where(eq(expense.id, charge.entityId));
      await repair();
      expect(await stored()).not.toEqual(before);
    },
    30_000,
  );

  it("repairs a missing cache without another queue delivery or input edit", async () => {
    const subject = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Synthetic recipe cache" }),
      ctx.actor,
    );
    await invalidateRecipes();
    await getDb(ctx.db)
      .update(recipe)
      .set({ totals: null, totalsComputedAt: null })
      .where(eq(recipe.id, subject.entityId));
    await invalidateRecipes();
    const [stored] = await getDb(ctx.db)
      .select()
      .from(recipe)
      .where(eq(recipe.id, subject.entityId));
    expect(stored?.totals).not.toBeNull();
    expect(stored?.totalsComputedAt).toBeInstanceOf(Date);
  });
});
