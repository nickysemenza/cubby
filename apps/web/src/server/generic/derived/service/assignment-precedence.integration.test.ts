import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import { fieldValueOf, fieldEnvelopeFor } from "@cubby/schemas/field-envelope";
import { sql } from "drizzle-orm";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import {
  createExpense,
  updateExpense,
} from "~/server/domains/expense/repo/crud";
import { updateProduct } from "~/server/domains/product/repo/crud";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { listOperations } from "~/server/entity-kernel/list-operations";
import {
  claimDerivedMarks,
  prepareDerivedPage,
  publishDerivedPage,
} from "~/server/generic/derived/repo/drain";
import { loadStoredDerived } from "~/server/generic/derived/repo/read";
import { explainField } from "~/server/generic/field-explanation/operations/field-explanation.server";
import { drainStoredDerived } from "~/server/testing/background-queue";
import {
  createProductIdentityFixture,
  makeProductInput,
  makeExpenseInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";
import { derivedComputes } from "~/server/workflows/derived-computes";

describe("assignment and stored projection precedence", () => {
  const ctx = withTestDb();
  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );

  it("keeps get, list, sort and filters aligned through an edit and reset during recomputation", async () => {
    const first = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic first price", price: 13 }),
      ctx.actor,
    );
    const second = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic second price", price: 7 }),
      ctx.actor,
    );
    await drainStoredDerived(ctx.db);
    await updateProduct(ctx.db, first.entityId, { price: 15 }, ctx.actor);
    const marks = (await claimDerivedMarks(ctx.db)).filter(
      (mark) => mark.target === "product.price" && mark.ref === first.entityId,
    );
    expect(marks).toHaveLength(1);
    const oldComputation = await prepareDerivedPage(
      ctx.db,
      derivedComputes,
      marks,
    );
    expect([...oldComputation.failed]).toEqual([]);
    await updateProduct(ctx.db, first.entityId, { price: 2 }, ctx.actor);
    await publishDerivedPage(ctx.db, oldComputation);

    const stored = (
      await loadStoredDerived(ctx.db, "product", [first.entityId], ["price"])
    )
      .get(first.entityId)
      ?.get("price");
    expect(stored).toMatchObject({
      value: 13,
      stale: true,
      decision: { provenance: { kind: "own" } },
    });
    const detail = entityFieldEnvelopeSchemas.product.detail.parse(
      (
        await executeEntity(context(), {
          action: "get",
          missing: "error",
          entity: "product",
          id: first.id,
        })
      ).item,
    );
    expect(detail.fields.price).toMatchObject({
      current: { assignment: { kind: "value", value: 2 } },
      result: {
        kind: "live",
        decision: {
          outcome: { kind: "value", value: 2 },
          provenance: { kind: "own" },
        },
      },
    });
    expect(detail.fields.cost).toMatchObject({
      current: {
        assignment: null,
        controls: { kind: "readonly", reason: "computed" },
      },
      result: {
        kind: "live",
        decision: {
          outcome: { kind: "value", value: { kind: "item", amount: 2 } },
          provenance: { kind: "own" },
        },
      },
      work: detail.fields.price.work,
    });
    expect(fieldValueOf(detail.fields.unitPriceDetailLabel)).toBe("$2.00/ea");
    const sorted = await executeEntity(context(), {
      action: "list",
      entity: "product",
      filters: { ids: [first.id, second.id] },
      sort: [{ orderBy: "price", direction: "asc" }],
      pagination: { pageIndex: 0, pageSize: 10 },
    });
    expect(sorted.items.map((row) => row.id)).toEqual([first.id, second.id]);
    expect(sorted.meta.sums).toMatchObject({ price: 9 });
    expect(
      sorted.items.map((row) =>
        fieldValueOf(
          entityFieldEnvelopeSchemas.product.list.parse(row).fields.price,
        ),
      ),
    ).toEqual([2, 7]);

    await updateProduct(ctx.db, first.entityId, { price: null }, ctx.actor);
    const reset = entityFieldEnvelopeSchemas.product.detail.parse(
      (
        await executeEntity(context(), {
          action: "get",
          missing: "error",
          entity: "product",
          id: first.id,
        })
      ).item,
    );
    expect(reset.fields.price.current.assignment).toEqual({ kind: "inherit" });
    expect(reset.fields.price.result).toEqual({ kind: "missing" });
    expect(reset.fields.price.work).toEqual({ kind: "pending" });
    expect(reset.fields.cost.result).toEqual({ kind: "missing" });
    expect(reset.fields.cost.work).toEqual(reset.fields.price.work);
    expect(reset.fields.unitPriceDetailLabel.result).toEqual({
      kind: "missing",
    });
    expect(reset.fields.unitPriceDetailLabel.work).toEqual(
      reset.fields.price.work,
    );
    const resetTotals = await executeEntity(context(), {
      action: "list",
      entity: "product",
      filters: { ids: [first.id, second.id] },
      pagination: { pageIndex: 0, pageSize: 10 },
    });
    expect(resetTotals.meta).toMatchObject({
      incompleteSums: ["price"],
      totalLabels: { price: "Incomplete · $7.00 known" },
    });
    expect(resetTotals.meta.sums).not.toHaveProperty("price");
    const priced = await executeEntity(context(), {
      action: "list",
      entity: "product",
      filters: { ids: [first.id, second.id], pricePresenceFilter: "has" },
      pagination: { pageIndex: 0, pageSize: 10 },
    });
    expect(priced.items.map((row) => row.id)).toEqual([second.id]);
    const unpriced = await executeEntity(context(), {
      action: "list",
      entity: "product",
      filters: { ids: [first.id, second.id], pricePresenceFilter: "none" },
      pagination: { pageIndex: 0, pageSize: 10 },
    });
    expect(unpriced.items).toEqual([]);
    expect(unpriced.meta.unresolvedCount).toBe(1);
    const facets = await listOperations("product").facets(context(), {
      filters: { ids: [first.id, second.id] },
      facetIds: ["priced"],
    });
    expect(facets.facets).toContainEqual(
      expect.objectContaining({
        id: "priced",
        kind: "values",
        options: [{ value: "has", count: 1 }],
        unresolvedCount: 1,
      }),
    );
    const viewCounts = await listOperations("product").viewCounts(context(), {
      views: [
        {
          id: "unpriced",
          filters: {
            ids: [first.id, second.id],
            pricePresenceFilter: "none",
          },
        },
      ],
    });
    expect(viewCounts.views).toEqual([
      { id: "unpriced", count: 0, unresolvedCount: 1 },
    ]);
    const unresolved = await executeEntity(context(), {
      action: "list",
      entity: "product",
      resultMembership: "unresolved",
      filters: { ids: [first.id, second.id], pricePresenceFilter: "none" },
      pagination: { pageIndex: 0, pageSize: 10 },
    });
    expect(unresolved.items.map((row) => row.id)).toEqual([first.id]);
    await drainStoredDerived(ctx.db);
    const completedEmpty = await executeEntity(context(), {
      action: "list",
      entity: "product",
      filters: { ids: [first.id, second.id], pricePresenceFilter: "none" },
      pagination: { pageIndex: 0, pageSize: 10 },
    });
    expect(completedEmpty.items.map((row) => row.id)).toEqual([first.id]);
    expect(completedEmpty.meta.unresolvedCount).toBe(0);
    const service = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic uncomputed service",
        categoryId: taxonomyShortcode("services"),
        price: null,
      }),
      ctx.actor,
    );
    const serviceWithoutPrice = await executeEntity(context(), {
      action: "list",
      entity: "product",
      filters: { ids: [service.id], pricePresenceFilter: "none" },
      pagination: { pageIndex: 0, pageSize: 10 },
    });
    expect(serviceWithoutPrice.items.map((row) => row.id)).toEqual([
      service.id,
    ]);
    expect(serviceWithoutPrice.meta.unresolvedCount).toBe(0);
  });

  it("keeps unit prices on the selected valuation while expense recomputation is pending", async () => {
    const product = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic cached unit price", price: null }),
      ctx.actor,
    );
    const expense = await createExpense(
      ctx.db,
      makeExpenseInput({ productId: product.id, cost: 26, productQuantity: 2 }),
      ctx.actor,
    );
    await drainStoredDerived(ctx.db);
    await updateExpense(ctx.db, expense.output.id, { cost: 30 }, ctx.actor);
    const detail = entityFieldEnvelopeSchemas.product.detail.parse(
      (
        await executeEntity(context(), {
          action: "get",
          entity: "product",
          id: product.id,
          missing: "error",
        })
      ).item,
    );
    expect(detail.fields.price.result).toMatchObject({
      kind: "cached",
      freshness: "stale",
    });
    expect(fieldValueOf(detail.fields.price)).toBe(13);
    expect(fieldValueOf(detail.fields.cost)).toEqual({
      kind: "item",
      amount: 13,
    });
    expect(fieldValueOf(detail.fields.unitPriceDetailLabel)).toBe("$13.00/ea");
    expect(detail.fields.unitPriceDetailLabel.result).toMatchObject({
      kind: "live",
      decision: { provenance: { kind: "computed" } },
    });
    const listed = await executeEntity(context(), {
      action: "list",
      entity: "product",
      filters: { ids: [product.id] },
      pagination: { pageIndex: 0, pageSize: 10 },
    });
    const row = entityFieldEnvelopeSchemas.product.list.parse(listed.items[0]);
    expect(fieldValueOf(row.fields.unitPrice)?.natural).toEqual({
      price: 13,
      unit: "each",
    });
    expect(row.fields.unitPrice.work).toEqual(row.fields.price.work);
    const explanation = await explainField(context(), {
      entityKind: "product",
      entityId: product.id,
      field: "unitPrice",
      surface: "detail",
    });
    expect(fieldValueOf(explanation.envelope)).toBe("$13.00/ea");
    expect(explanation.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Selected valuation price",
          value: 13,
        }),
        expect.objectContaining({
          label: "Complete unit conversion graph",
          value: expect.arrayContaining([
            expect.objectContaining({
              a: { value: 1, unit: "each" },
              b: { value: 13, unit: "dollar" },
            }),
          ]),
        }),
      ]),
    );
    await getDb(ctx.db).execute(sql`UPDATE "DerivedDirty"
      SET "lastError" = 'Synthetic unit-price input refresh failure', "readyAt" = now() + interval '1 hour'
      WHERE target = 'product.price' AND ref = ${product.entityId}`);
    const failed = entityFieldEnvelopeSchemas.product.detail.parse(
      (
        await executeEntity(context(), {
          action: "get",
          entity: "product",
          id: product.id,
          missing: "error",
        })
      ).item,
    );
    expect(fieldValueOf(failed.fields.unitPriceDetailLabel)).toBe("$13.00/ea");
    expect(failed.fields.unitPriceDetailLabel.work).toMatchObject({
      kind: "failed",
      error: "Synthetic unit-price input refresh failure",
    });
    expect(failed.fields.unitPriceDetailLabel.work).toEqual(
      failed.fields.price.work,
    );
    await updateProduct(
      ctx.db,
      product.entityId,
      {
        unitMappings: [
          {
            a: { value: 1, unit: "each" },
            b: { value: 100, unit: "g" },
            source: "manual",
          },
        ],
      },
      ctx.actor,
    );
    const converted = await executeEntity(context(), {
      action: "list",
      entity: "product",
      filters: { ids: [product.id] },
      pagination: { pageIndex: 0, pageSize: 10 },
    });
    const weighted = entityFieldEnvelopeSchemas.product.list.parse(
      converted.items[0],
    );
    expect(fieldValueOf(weighted.fields.price)).toBe(13);
    expect(fieldValueOf(weighted.fields.unitPrice)?.perGram).toBeCloseTo(
      0.13,
      9,
    );
    expect(weighted.fields.unitPrice.result).toMatchObject({
      kind: "live",
      decision: { provenance: { kind: "computed" } },
    });
    const selected = await listOperations("product").listFields(
      context(),
      {
        filters: { ids: [product.id] },
        pagination: { pageIndex: 0, pageSize: 10 },
      },
      ["unitPrice"],
    );
    const selectedUnit = fieldEnvelopeFor(selected.items[0], "unitPrice");
    if (!selectedUnit)
      throw new Error("Selected unit-price envelope is missing");
    expect(
      z.object({ perGram: z.number() }).parse(fieldValueOf(selectedUnit))
        .perGram,
    ).toBeCloseTo(0.13, 9);
    expect(selected.items[0]).not.toHaveProperty("fields.price");
    expect(selected.items[0]).not.toHaveProperty("unitMappings");
    expect(selected.items[0]).not.toHaveProperty("food");
  });
});
