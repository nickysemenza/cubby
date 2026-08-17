import { expenseCreateInput } from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { getDb } from "../database-helpers";
import { createExpense } from "../expense";
import {
  createProductFixture as createProduct,
  makeExpenseInput,
  makeProductInput,
} from "../repo.fixtures";
import { loadProductOwnershipTimelines } from "./ownership";

describe("loadProductOwnershipTimelines", () => {
  const ctx = withTestDb();
  const TODAY = "2026-08-17";

  it("keeps partial exits open and preserves full-disposal/rebuy gaps", async () => {
    const partial = await createProduct(
      ctx.db,
      makeProductInput({ name: "Partial ownership tool" }),
      ctx.actor,
    );
    const rebought = await createProduct(
      ctx.db,
      makeProductInput({ name: "Rebought ownership tool" }),
      ctx.actor,
    );
    const uncertain = await createProduct(
      ctx.db,
      makeProductInput({ name: "Uncertain ownership tool" }),
      ctx.actor,
    );

    const movement = (
      productId: (typeof partial)["id"],
      date: string,
      cost: number,
      productQuantity?: number,
    ) =>
      createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({
            name: `movement ${date}`,
            productId,
            date,
            cost,
            productQuantity,
            lineKind: "principal",
          }),
        ),
        ctx.actor,
      );

    await movement(partial.id, "2021-01-01", 200, 2);
    await movement(partial.id, "2022-01-01", -80, -1);

    await movement(rebought.id, "2021-01-01", 100, 1);
    await movement(rebought.id, "2022-01-01", -80, -1);
    await movement(rebought.id, "2023-01-01", 120, 1);

    await movement(uncertain.id, "2020-01-01", 100, 1);
    await movement(uncertain.id, "2021-01-01", -50);
    await movement(uncertain.id, "2022-01-01", 100, 1);

    const ownership = await loadProductOwnershipTimelines(
      getDb(ctx.db),
      [partial.entityId, rebought.entityId, uncertain.entityId],
      { today: TODAY },
    );

    expect(ownership.get(partial.entityId)).toEqual({
      acquiredAt: "2021-01-01",
      intervals: [{ start: "2021-01-01", end: TODAY }],
      confidenceLostAt: null,
    });
    expect(ownership.get(rebought.entityId)).toEqual({
      acquiredAt: "2021-01-01",
      intervals: [
        { start: "2021-01-01", end: "2022-01-01" },
        { start: "2023-01-01", end: TODAY },
      ],
      confidenceLostAt: null,
    });
    expect(ownership.get(uncertain.entityId)).toEqual({
      acquiredAt: "2020-01-01",
      intervals: [{ start: "2020-01-01", end: "2021-01-01" }],
      confidenceLostAt: "2021-01-01",
    });
  });
});
