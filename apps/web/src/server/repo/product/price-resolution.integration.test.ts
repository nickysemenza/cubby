import { fieldResolutionSchema } from "@cubby/schemas/field-resolution";
import { expenseCreateInput } from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { createExpense } from "~/server/repo/expense";
import {
  createProductFixture,
  makeExpenseInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import { getProductByShortcode, productList } from ".";
import { listProductsRead } from "./crud";

const priceRead = z.object({
  price: z.number().nullable(),
  pricing: z.object({
    effectivePrice: z.number().nullable(),
    derivedPrice: z.number().nullable(),
  }),
  fieldResolutions: z.object({ price: fieldResolutionSchema }),
});

// Failure modes: equal explicit values lose assignment intent; edit baselines
// receive a derived value; reset changes Expense money; detail/list disagree;
// missing history invents a price or a single aggregate-source record.
describe("Product valuation price resolution on canonical reads", () => {
  const ctx = withTestDb();

  it("preserves stored overrides, expense-derived fallback and explicit reset without changing ledger cost", async () => {
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic resolution clamp",
        price: 8,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "Synthetic quantified clamp purchase",
          cost: 20,
          productId: product.id,
          productQuantity: 4,
        }),
      ),
      ctx.actor,
    );
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const read = async () => {
      const detail = priceRead.parse(
        await getProductByShortcode(ctx.db, product.id),
      );
      const list = await productList(ctx.db, {}, [], {
        pageIndex: 0,
        pageSize: 50,
      });
      const row = list.data.find((candidate) => candidate.id === product.id);
      expect(priceRead.parse(row)).toEqual(detail);
      expect(row?.expenseTotal).toBe(20);
      const deferred = await listProductsRead(
        ctx.db,
        { ids: [product.id] },
        [],
        { pageIndex: 0, pageSize: 50 },
        undefined,
        "page",
        undefined,
        { kind: "enrichment", groups: ["derived"] },
      );
      expect(deferred.data).toHaveLength(1);
      expect(priceRead.parse(deferred.data[0])).toEqual(detail);
      return detail;
    };
    const override = await read();
    expect(override.price).toBe(8);
    expect(override.fieldResolutions.price).toEqual({
      mode: "explicit",
      storedValue: 8,
      value: 8,
      fallbackValue: 5,
      source: "manual valuation price",
      sourceEntity: null,
      matchesFallback: false,
      canReset: true,
    });
    await executeEntity(context, {
      action: "update",
      entity: "product",
      id: product.id,
      data: { price: 5 },
    });
    expect((await read()).fieldResolutions.price).toMatchObject({
      mode: "explicit",
      storedValue: 5,
      value: 5,
      fallbackValue: 5,
      matchesFallback: true,
      canReset: true,
    });
    await executeEntity(context, {
      action: "update",
      entity: "product",
      id: product.id,
      data: { price: null },
    });
    const inherited = await read();
    expect(inherited.price).toBeNull();
    expect(inherited.fieldResolutions.price).toEqual({
      mode: "inherit",
      storedValue: null,
      value: 5,
      fallbackValue: 5,
      source: "expense-derived unit price",
      sourceEntity: null,
      matchesFallback: false,
      canReset: false,
    });
    const missing = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic unpriced clamp", price: null }),
      ctx.actor,
    );
    expect(
      priceRead.parse(await getProductByShortcode(ctx.db, missing.id))
        .fieldResolutions.price,
    ).toEqual({
      mode: "inherit",
      storedValue: null,
      value: null,
      fallbackValue: null,
      source: "no valuation price",
      sourceEntity: null,
      matchesFallback: false,
      canReset: false,
    });
    await executeEntity(context, {
      action: "update",
      entity: "product",
      id: missing.id,
      data: { price: 7 },
    });
    expect(
      priceRead.parse(await getProductByShortcode(ctx.db, missing.id))
        .fieldResolutions.price,
    ).toMatchObject({
      mode: "explicit",
      storedValue: 7,
      value: 7,
      fallbackValue: null,
      matchesFallback: false,
      canReset: true,
    });
    await executeEntity(context, {
      action: "update",
      entity: "product",
      id: missing.id,
      data: { price: null },
    });
    expect(
      priceRead.parse(await getProductByShortcode(ctx.db, missing.id))
        .fieldResolutions.price.value,
    ).toBeNull();
  });
});
