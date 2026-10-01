import type { ProductShortcode } from "@cubby/schemas/identifiers";
import { expenseCreateInput } from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getProductWithFood } from "../../services/product.service";
import { createExpense } from "../expense";
import { attachProductComponents } from "../product-components";
import {
  createProductFixture as createProduct,
  makeExpenseInput,
  makeProductInput,
} from "../repo.fixtures";

describe("Product ownership evidence scope", () => {
  const ctx = withTestDb();
  const food = { findFood: async () => null };
  const movement = (
    productId: ProductShortcode,
    date: string,
    cost: number,
    productQuantity?: number,
  ) =>
    createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          productId,
          date,
          cost,
          productQuantity,
          lineKind: "principal",
        }),
      ),
      ctx.actor,
    );

  it("does not turn an ancestor kit exit into a direct product disposal", async () => {
    const part = await createProduct(
      ctx.db,
      makeProductInput({ name: "Directly acquired component" }),
      ctx.actor,
    );
    const kit = await createProduct(
      ctx.db,
      makeProductInput({ name: "Component kit" }),
      ctx.actor,
    );
    await attachProductComponents(
      ctx.db,
      kit.entityId,
      [{ productId: part.entityId, quantity: 1 }],
      ctx.actor,
    );
    await movement(part.id, "2025-01-01", 100, 1);
    await movement(kit.id, "2025-02-01", -80, -1);
    const result = await getProductWithFood(ctx.db, food, part.entityId);
    expect(result.quantityLedger.expectedQuantity).toBe(0);
    expect(result.ownershipEvidence).toMatchObject({
      state: "uncertain",
      exitedAt: null,
    });
  });

  it("keeps a direct disposal uncertain after quantity-less kit reacquisition", async () => {
    const part = await createProduct(
      ctx.db,
      makeProductInput({ name: "Reacquired component" }),
      ctx.actor,
    );
    const kit = await createProduct(
      ctx.db,
      makeProductInput({ name: "Reacquisition kit" }),
      ctx.actor,
    );
    await attachProductComponents(
      ctx.db,
      kit.entityId,
      [{ productId: part.entityId, quantity: 1 }],
      ctx.actor,
    );
    await movement(part.id, "2025-01-01", 100, 1);
    await movement(part.id, "2025-02-01", -80, -1);
    await movement(kit.id, "2025-03-01", 120);
    const result = await getProductWithFood(ctx.db, food, part.entityId);
    expect(result.quantityLedger.expectedQuantity).toBe(0);
    expect(result.ownershipEvidence).toMatchObject({
      state: "uncertain",
      exitedAt: null,
    });
  });

  it("retains direct ownership and a direct fully quantified disposal", async () => {
    const part = await createProduct(
      ctx.db,
      makeProductInput({ name: "Direct ownership only" }),
      ctx.actor,
    );
    await movement(part.id, "2025-01-01", 100, 1);
    expect(
      (await getProductWithFood(ctx.db, food, part.entityId)).ownershipEvidence
        .state,
    ).toBe("owned");
    await movement(part.id, "2025-02-01", -80, -1);
    expect(
      (await getProductWithFood(ctx.db, food, part.entityId)).ownershipEvidence,
    ).toMatchObject({ state: "exited", exitedAt: "2025-02-01" });
  });
});
