import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { explainField } from "~/server/field-explanation-browser.server";
import { createExpense } from "~/server/repo/expense";
import { createInventoryEntry } from "~/server/repo/inventory";
import { createLedgerParty } from "~/server/repo/ledger-party";
import {
  createLocationFixture,
  createProductFixture,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { createTestRequestContext } from "~/server/testing/request-context";

describe("derived field explanations against canonical records", () => {
  const ctx = withTestDb();

  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );

  it("explains manual price precedence and links the records behind an expense count", async () => {
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Explanation product", price: 20 }),
      ctx.actor,
    );
    const expense = await createExpense(
      ctx.db,
      makeExpenseInput({ productId: product.id, cost: 12, productQuantity: 2 }),
      ctx.actor,
    );
    const requestContext = context();
    const record = await executeEntity(requestContext, {
      action: "get",
      entity: "product",
      id: product.id,
      missing: "error",
    });
    if (record.action !== "get") throw new Error("Expected product detail");
    expect(record.item).toMatchObject({
      pricing: { effectivePrice: 20, derivedPrice: 6 },
    });

    const price = await explainField(requestContext, {
      entityType: "product",
      entityId: product.id,
      field: "price",
      surface: "detail",
    });
    expect(price.value).toBe(20);
    expect(price.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 20 }),
        expect.objectContaining({ value: 6 }),
      ]),
    );

    const count = await explainField(requestContext, {
      entityType: "product",
      entityId: product.id,
      field: "expenseCount",
      surface: "list",
    });
    expect(count.value).toBe(1);
    expect(count.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: { entityType: "expense", entityId: expense.output.id },
        }),
      ]),
    );
  });

  it("uses the same explicit owner and evidence fingerprint as inventory detail", async () => {
    const product = await createProductFixture(
      ctx.db,
      makeProductInput(),
      ctx.actor,
    );
    const location = await createLocationFixture(
      ctx.db,
      makeLocationInput(),
      ctx.actor,
    );
    const owner = await createLedgerParty(
      ctx.db,
      { name: "Test owner", kind: "member", notes: null },
      ctx.actor,
    );
    const entry = await createInventoryEntry(
      ctx.db,
      {
        productId: product.entityId,
        locationId: location.entityId,
        amount: { value: 1, unit: "each" },
        ownershipMode: "person",
        ownerLedgerPartyId: owner.entityId,
      },
      ctx.actor,
    );
    const requestContext = context();
    const record = await executeEntity(requestContext, {
      action: "get",
      entity: "inventory",
      id: entry.id,
      missing: "error",
    });
    if (record.action !== "get") throw new Error("Expected inventory detail");
    const explanation = await explainField(requestContext, {
      entityType: "inventory",
      entityId: entry.id,
      field: "effectiveOwnership",
      surface: "detail",
    });
    expect(record.item).toMatchObject({
      effectiveOwnership: explanation.value,
    });
    expect(explanation.value).toMatchObject({
      mode: "person",
      effectiveOwner: { id: owner.output.id },
    });
    expect(explanation.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Stored ownership",
          value: {
            mode: "person",
            owner: { id: owner.output.id, name: "Test owner", kind: "member" },
          },
        }),
      ]),
    );
    expect(explanation.evidenceFingerprint).toBeTypeOf("string");
  });

  it("keeps aggregate values complete while bounding their record evidence", async () => {
    const product = await createProductFixture(
      ctx.db,
      makeProductInput(),
      ctx.actor,
    );
    for (let index = 0; index < 31; index += 1) {
      await insertWithShortcode(ctx.db, "expense", {
        name: `Count evidence ${index}`,
        productId: product.entityId,
        cost: 1,
        costType: "materials",
        trade: "other",
        date: "2024-01-15",
      });
    }
    const result = await explainField(context(), {
      entityType: "product",
      entityId: product.id,
      field: "expenseCount",
      surface: "list",
    });
    const linkedExpenses = result.sources.filter(
      (source) => source.entity?.entityType === "expense",
    );
    expect(result.value).toBe(31);
    expect(linkedExpenses.length).toBeGreaterThan(0);
    expect(linkedExpenses.length).toBeLessThan(31);
    expect(result.truncated).toBe(true);
  });
});
