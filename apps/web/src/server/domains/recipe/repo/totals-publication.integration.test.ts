import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { recipe, expense } from "~/server/db/schema";
import { findOrCreateIngredient } from "~/server/domains/ingredient/repo/crud";
import { markRecipesStale } from "~/server/domains/recipe/repo/totals";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { explainField } from "~/server/generic/field-explanation/operations/field-explanation.server";
import {
  drainDerivedPage,
  drainStoredDerived,
  reconcileDerivedRefreshInputs,
  derivedMarkTickets,
} from "~/server/testing/background-queue";
import {
  createRecipeFixture,
  makeRecipeInput,
  createProductIdentityFixture,
  makeProductInput,
  ingredientRef,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

// Recipe output must survive lost wakes and reject a prepared superseded page.
describe("recipe Job publication", () => {
  const ctx = withTestDb();
  const drain = () => drainStoredDerived(ctx.db);
  const invalidateRecipes = () => reconcileDerivedRefreshInputs(ctx.db);

  it("retains stale totals and explains their publication without making nutrition fresh", async () => {
    const subject = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Synthetic retained totals" }),
      ctx.actor,
    );
    await drain();
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );
    const request = {
      entityKind: "recipe" as const,
      entityId: subject.id,
      field: "costTotal",
      surface: "list" as const,
    };
    const published = await explainField(context, request);
    expect(published.envelope.result.kind).toBe("cached");
    expect(published.sources).not.toEqual([]);
    await markRecipesStale(ctx.db, [subject.entityId]);
    const stale = await explainField(context, {
      ...request,
      displayedResult: published.envelope.result,
    });
    expect(stale.envelope.result).toMatchObject({
      kind: "cached",
      freshness: "stale",
    });
    expect(fieldValueOf(stale.envelope)).toEqual(
      fieldValueOf(published.envelope),
    );
    expect(stale.sources).toEqual(published.sources);
    const row = await getDb(ctx.db).query.recipe.findFirst({
      where: eq(recipe.id, subject.entityId),
    });
    expect(row?.totalsComputedAt).toBeNull();
    expect(row?.totalsPublishedAt?.toISOString()).toEqual(
      published.envelope.result.kind === "cached"
        ? published.envelope.result.computedAt
        : null,
    );
    await drain();
    expect(
      await derivedMarkTickets(ctx.db, "recipe.totals", subject.entityId),
    ).toEqual([]);
    const superseded = await explainField(context, {
      ...request,
      displayedResult: published.envelope.result,
    });
    expect(superseded.publication?.kind).toBe("superseded");
    expect(superseded.sources).toEqual([]);
  });

  it("rejects prepared totals after a later authoritative save", async () => {
    const subject = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Synthetic fenced recipe" }),
      ctx.actor,
    );
    let tickets: number[] = [];
    await drainDerivedPage(ctx.db, {
      only: (mark) => mark.target === "recipe.totals",
      during: async () => {
        await getDb(ctx.db)
          .update(recipe)
          .set({ name: "Synthetic revised recipe" })
          .where(eq(recipe.id, subject.entityId));
        tickets = await derivedMarkTickets(
          ctx.db,
          "recipe.totals",
          subject.entityId,
        );
      },
    });
    expect(
      await derivedMarkTickets(ctx.db, "recipe.totals", subject.entityId),
    ).toEqual(tickets);
    expect(tickets).toHaveLength(1);
    await drain();
    expect(
      await derivedMarkTickets(ctx.db, "recipe.totals", subject.entityId),
    ).toEqual([]);
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
      await drain();
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
      expect(
        await derivedMarkTickets(ctx.db, "product.price", product.entityId),
      ).not.toEqual([]);
      await drain();
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
