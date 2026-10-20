import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  recipe,
  expense,
  derivedRefreshCursor,
  derivedRefreshWork,
  derivedRefreshRevision,
} from "~/server/db/schema";
import { findOrCreateIngredient } from "~/server/domains/ingredient/repo/crud";
import { processDerivedRefreshPage } from "~/server/domains/run/service/derived-refresh";
import {
  currentInputRevision,
  DerivedInputsChanged,
} from "~/server/generic/derived-refresh/repo/freshness";
import { reconcileDerivedRefreshPage } from "~/server/generic/derived-refresh/repo/reconcile";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  createRecipeFixture,
  makeRecipeInput,
  createProductFixture,
  makeProductInput,
  ingredientRef,
} from "~/server/testing/repo.fixtures";

import {
  commitRecipeTotals,
  markRecipesStale,
  getRecipeTotalsState,
} from "./totals";

// A delayed invalidation must not erase a cache computed from the same or newer inputs.
describe("recipe totals publication ordering", () => {
  const ctx = withTestDb();
  let queue: ReturnType<typeof captureBackgroundQueue>;
  beforeEach(() => {
    queue = captureBackgroundQueue();
  });
  afterEach(() => queue.restore());
  const drain = async () => {
    for (let page = 0; page < 500; page++) {
      const result = await processDerivedRefreshPage(ctx.db);
      expect(result.errors).toEqual([]);
      queue.tasks.length = 0;
      if (result.done) return;
    }
    throw new Error("Synthetic recipe work did not terminate");
  };

  it("keeps healthy recipe totals visible after an unrelated embedding failure", async () => {
    const subject = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Synthetic healthy totals" }),
      ctx.actor,
    );
    const other = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic unrelated embedding failure" }),
      ctx.actor,
    );
    await drain();
    await getDb(ctx.db)
      .update(derivedRefreshWork)
      .set({ state: "failed", hasFailures: true })
      .where(eq(derivedRefreshWork.entityId, other.entityId));
    expect(
      (await getRecipeTotalsState(ctx.db, subject.entityId))?.totalsComputedAt,
    ).toBeInstanceOf(Date);
  });

  it("treats recipe revision contention as a retry without a semantic failure", async () => {
    const subject = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Synthetic recipe contention" }),
      ctx.actor,
    );
    const revision = await currentInputRevision(ctx.db);
    await getDb(ctx.db)
      .update(derivedRefreshRevision)
      .set({ revision: revision + 1 })
      .where(eq(derivedRefreshRevision.key, "all"));
    await expect(
      commitRecipeTotals(ctx.db, {
        updates: [],
        freshOnlyIds: [subject.entityId],
        changedIds: [],
        processedIds: [subject.entityId],
        inputRevision: revision,
      }),
    ).rejects.toBeInstanceOf(DerivedInputsChanged);
  });

  it.each(["price edit", "removal", "endpoint reassignment"])(
    "repairs populated recipe totals after a SQL-only Expense %s",
    async (change) => {
      const ingredient = await findOrCreateIngredient(
        ctx.db,
        "Synthetic repair ingredient",
      );
      const product = await createProductFixture(
        ctx.db,
        makeProductInput({
          name: "Synthetic expense-priced product",
          ingredientId: ingredient.id,
          price: null,
        }),
        ctx.actor,
      );
      const other = await createProductFixture(
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
      const repair = async () => {
        for (let cycle = 0; cycle < 2; cycle++) {
          await getDb(ctx.db)
            .update(derivedRefreshCursor)
            .set({ availableAt: new Date(0) });
          let done = false;
          for (let page = 0; page < 1000; page++)
            if ((await reconcileDerivedRefreshPage(ctx.db)).done) {
              done = true;
              break;
            }
          expect(done).toBe(true);
          await drain();
        }
      };
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

  it("keeps a newer cache stamp when an older refresh frontier arrives", async () => {
    const subject = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Synthetic cache ordering" }),
      ctx.actor,
    );
    const revision = await currentInputRevision(ctx.db);
    await commitRecipeTotals(ctx.db, {
      updates: [],
      freshOnlyIds: [subject.entityId],
      changedIds: [],
      processedIds: [subject.entityId],
      inputRevision: revision,
    });
    const [before] = await getDb(ctx.db)
      .select({ stamp: recipe.totalsComputedAt })
      .from(recipe)
      .where(eq(recipe.id, subject.entityId));
    expect(before?.stamp).not.toBeNull();
    await withTransactionDatabase(ctx.db, (tx) =>
      markRecipesStale(tx, [subject.entityId], revision),
    );
    const [after] = await getDb(ctx.db)
      .select({ stamp: recipe.totalsComputedAt })
      .from(recipe)
      .where(eq(recipe.id, subject.entityId));
    expect(after?.stamp).toEqual(before?.stamp);
  });

  it("finishes recipe computation without delivering another queue message", async () => {
    const subject = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Synthetic durable cache" }),
      ctx.actor,
    );
    queue.tasks.length = 0;
    let complete = false;
    for (let page = 0; page < 100; page++) {
      const result = await processDerivedRefreshPage(ctx.db);
      expect(result.errors).toEqual([]);
      if (result.done) {
        complete = true;
        break;
      }
      queue.tasks.length = 0;
    }
    expect(complete).toBe(true);
    const [stored] = await getDb(ctx.db)
      .select({ totals: recipe.totals, stamp: recipe.totalsComputedAt })
      .from(recipe)
      .where(eq(recipe.id, subject.entityId));
    expect(stored?.stamp).not.toBeNull();
    expect(stored?.totals).not.toBeNull();
  });

  it("repairs a missing cache even when authoritative input snapshots are unchanged", async () => {
    const subject = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Synthetic cache repair" }),
      ctx.actor,
    );
    const repair = async () => {
      await getDb(ctx.db)
        .update(derivedRefreshCursor)
        .set({ availableAt: new Date(0) });
      for (let page = 0; page < 500; page++) {
        if ((await reconcileDerivedRefreshPage(ctx.db)).done) {
          await drain();
          return;
        }
      }
      throw new Error("Synthetic recipe repair did not terminate");
    };
    await drain();
    await repair();
    await repair();
    await getDb(ctx.db)
      .update(recipe)
      .set({ totals: null, totalsComputedAt: null })
      .where(eq(recipe.id, subject.entityId));
    await repair();
    const [stored] = await getDb(ctx.db)
      .select({ totals: recipe.totals, stamp: recipe.totalsComputedAt })
      .from(recipe)
      .where(eq(recipe.id, subject.entityId));
    expect(stored?.totals).not.toBeNull();
    expect(stored?.stamp).not.toBeNull();
  });
});
