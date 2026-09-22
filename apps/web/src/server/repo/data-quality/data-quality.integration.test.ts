import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { expenseCreateInput } from "@cubby/schemas/project";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { createExpense } from "~/server/repo/expense";
import { productList } from "~/server/repo/product";
import { purchaseList } from "~/server/repo/purchase";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

import { clearDataException, setDataException } from "./exceptions";
import { loadDataQualities } from "./hydrate";

const page = { pageIndex: 0, pageSize: 50 };

/**
 * The list filters, the score sort and the hydrated `dataQuality` all derive
 * from the one registry binding per check. This asserts they agree on real
 * rows — the historical regression class was SQL predicates and JS
 * predicates drifting apart (a `dataGap` filter that disagreed with the
 * badge it filters).
 */
describe("data quality: list filters, sort and hydration agree", () => {
  const ctx = withTestDb();

  const seedProducts = async () => {
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "DQ shelf" }),
      TEST_ACTOR,
    );
    // Stocked, unnamed maker: manufacturer + external id + category + image
    // + price all missing, so the weakest score.
    const weak = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "DQ weak", manufacturer: "(unspecified)" }),
      TEST_ACTOR,
    );
    // Stocked with a maker and a price: still missing external id, category,
    // image — a middling score.
    const middling = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "DQ middling", manufacturer: "Acme", price: 4 }),
      TEST_ACTOR,
    );
    // Neither stocked nor purchased: no check is expected, so complete at 100.
    const outOfScope = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "DQ out of scope",
        manufacturer: "(unspecified)",
      }),
      TEST_ACTOR,
    );
    for (const item of [weak, middling]) {
      await createInventoryFixture(
        ctx.db,
        {
          productId: item.id,
          locationId: shelf.id,
          amount: { value: 1, unit: "each" },
          placement: "stock",
        },
        TEST_ACTOR,
      );
    }
    return { weak, middling, outOfScope };
  };

  it("filters by status and gap exactly as the hydrated object reports", async () => {
    const { weak, middling, outOfScope } = await seedProducts();
    const ids = [weak.entityId, middling.entityId, outOfScope.entityId];
    const hydrated = await loadDataQualities(ctx.db, "product", ids);

    expect(hydrated.get(weak.entityId)?.status).toBe("needs_data");
    expect(hydrated.get(middling.entityId)?.status).toBe("needs_data");
    expect(hydrated.get(outOfScope.entityId)).toMatchObject({
      status: "complete",
      score: 100,
      gaps: [],
    });
    expect(hydrated.get(weak.entityId)?.gaps.map((gap) => gap.check)).toContain(
      "product_manufacturer",
    );
    expect(
      hydrated.get(middling.entityId)?.gaps.map((gap) => gap.check),
    ).not.toContain("product_manufacturer");

    const listed = async (filters: Parameters<typeof productList>[1]) =>
      new Set(
        (await productList(ctx.db, filters, [], page)).data.map(
          (row) => row.id,
        ),
      );

    const needsData = await listed({ dataStatus: "needs_data" });
    expect(needsData.has(weak.id)).toBe(true);
    expect(needsData.has(middling.id)).toBe(true);
    expect(needsData.has(outOfScope.id)).toBe(false);

    const complete = await listed({ dataStatus: "complete" });
    expect(complete.has(outOfScope.id)).toBe(true);
    expect(complete.has(weak.id)).toBe(false);

    const noMaker = await listed({ dataGap: ["product_manufacturer"] });
    expect(noMaker.has(weak.id)).toBe(true);
    expect(noMaker.has(middling.id)).toBe(false);
    expect(noMaker.has(outOfScope.id)).toBe(false);
  });

  it("sorts by the same score the hydrated object carries", async () => {
    const { weak, middling, outOfScope } = await seedProducts();
    const hydrated = await loadDataQualities(ctx.db, "product", [
      weak.entityId,
      middling.entityId,
      outOfScope.entityId,
    ]);
    const weakScore = hydrated.get(weak.entityId)!.score;
    const middlingScore = hydrated.get(middling.entityId)!.score;
    expect(weakScore).toBeLessThan(middlingScore);
    expect(middlingScore).toBeLessThan(100);

    const { data } = await productList(
      ctx.db,
      { nameFilter: "DQ " },
      [{ orderBy: "dataQuality", direction: "asc" }],
      page,
    );
    expect(data.map((row) => row.id)).toEqual([
      weak.id,
      middling.id,
      outOfScope.id,
    ]);
    expect(data.map((row) => row.dataQuality.score)).toEqual([
      weakScore,
      middlingScore,
      100,
    ]);
  });

  it("counts an active exception as satisfied until its evidence changes", async () => {
    const { weak } = await seedProducts();
    const before = (
      await loadDataQualities(ctx.db, "product", [weak.entityId])
    ).get(weak.entityId)!;

    const excepted = await setDataException(
      ctx.db,
      {
        entityId: weak.id,
        check: "product_manufacturer",
        reason: "not_applicable",
        note: "An unbranded bag; the maker never catalogued it.",
      },
      TEST_ACTOR,
    );
    expect(excepted.exceptions).toContainEqual(
      expect.objectContaining({
        check: "product_manufacturer",
        state: "active",
      }),
    );
    expect(excepted.gaps.map((gap) => gap.check)).not.toContain(
      "product_manufacturer",
    );
    expect(excepted.score).toBeGreaterThan(before.score);
    const noMaker = new Set(
      (
        await productList(
          ctx.db,
          { dataGap: ["product_manufacturer"] },
          [],
          page,
        )
      ).data.map((row) => row.id),
    );
    expect(noMaker.has(weak.id)).toBe(false);

    const cleared = await clearDataException(
      ctx.db,
      { entityId: weak.id, check: "product_manufacturer" },
      TEST_ACTOR,
    );
    expect(cleared.exceptions).toEqual([]);
    expect(cleared.score).toBe(before.score);
  });

  it("rolls a linked product's gap up onto the purchase's dataGap filter", async () => {
    const { weak } = await seedProducts();
    const line = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "DQ line",
          productId: weak.id,
          vendor: "DQ vendor",
          orderId: "DQ-1",
        }),
      ),
      TEST_ACTOR,
    );
    const purchaseId = line.output.purchaseId;
    if (!purchaseId) throw new Error("Fixture has no Purchase");

    const rolledUp = (
      await purchaseList(ctx.db, { dataGap: ["product_image"] }, [], page)
    ).data;
    expect(rolledUp.map((row) => row.id)).toContain(purchaseId);
    const quality = rolledUp.find((row) => row.id === purchaseId)?.dataQuality;
    expect(quality?.relatedGaps).toContainEqual(
      expect.objectContaining({
        check: "product_image",
        targetType: "product",
        targetId: parseShortcodeFor("product", weak.id),
      }),
    );
    // The purchase's own score ignores the related product's gaps.
    expect(quality?.gaps.map((gap) => gap.check)).not.toContain(
      "product_image",
    );
  });
});
