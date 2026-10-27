import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { inventoryReceivingStockOut } from "@cubby/schemas/inventory";
import { createRepoEntity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { inventoryHandlers } from "~/server/domains/inventory/operations.server";
import { createInventoryEntry } from "~/server/domains/inventory/repo/crud";
import { listProductStock } from "~/server/domains/inventory/repo/product-stock";
import { publicFieldEnvelopeRows } from "~/server/generic/derived/repo/public-read";
import { systemPrincipal } from "~/server/http/authenticate";
import {
  createLocationFixture,
  createProductIdentityFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { getReceivingContext } from "./receiving-context.service";

describe("live receiving and scan fields", () => {
  const ctx = withTestDb();
  it("publishes current stock and scan fields while preserving receipt plans and scan evidence", async () => {
    const brand = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic stock maker",
    });
    const product = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic stock context",
        brandId: brand.output.id,
      }),
      ctx.actor,
    );
    const source = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic source shelf" }),
      ctx.actor,
    );
    const target = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic scanned shelf" }),
      ctx.actor,
    );
    const entry = await createInventoryEntry(
      ctx.db,
      {
        productId: product.entityId,
        locationId: source.entityId,
        amount: { value: 3, unit: "each" },
        placement: "stock",
      },
      ctx.actor,
    );
    const request = {
      principal: systemPrincipal(buildKernelContext(ctx.db, ctx.actor.userId)),
      headers: new Headers(),
      signal: new AbortController().signal,
    };
    const raw = await getReceivingContext(ctx.db, { productId: product.id });
    const receiving = await inventoryHandlers.operations.receivingContext({
      data: { productId: product.id },
      request,
    });
    if (!receiving.ok) throw new Error(receiving.error.message);
    expect(receiving.data.suggestedPlan).toEqual(raw.suggestedPlan);
    expect(receiving.data.locationPlans).toEqual(raw.locationPlans);
    const stock = receiving.data.stock[0];
    if (!stock) throw new Error("Expected existing stock");
    expect(stock.id).toBe(entry.id);
    expect(fieldValueOf(stock.fields.amount)).toEqual({
      value: 3,
      unit: "each",
    });
    expect(fieldValueOf(stock.fields.locationId)).toBe(source.id);
    expect(stock).not.toHaveProperty("amount");
    expect(stock).not.toHaveProperty("locationId");
    const scan = await inventoryHandlers.operations.scanAtLocation({
      data: {
        locationId: target.id,
        code: { kind: "product", value: product.id },
      },
      request,
    });
    if (!scan.ok) throw new Error(scan.error.message);
    expect(scan.data.outcome).toBe("queued");
    expect(fieldValueOf(scan.data.product.fields.brandName)).toBe(
      "Synthetic stock maker",
    );
    expect(scan.data.product).not.toHaveProperty("brandName");
    expect(scan.data.product).not.toHaveProperty("hasPrice");
    const stray = scan.data.strays[0];
    if (!stray) throw new Error("Expected the live stray stock row");
    expect(stray.entryId).toBe(entry.id);
    expect(fieldValueOf(stray.fields.amount)).toEqual({
      value: 3,
      unit: "each",
    });
    expect(stray.ambiguousQuantity).toBe(true);
    expect(stray.location).toEqual({ id: source.id, name: source.name });
    expect(stray).not.toHaveProperty("amount");
    expect(
      (await listProductStock(ctx.db, product.entityId)).map(
        (row) => row.value,
      ),
    ).toEqual([3]);
    const repeated = await publicFieldEnvelopeRows({
      db: ctx.db,
      entity: "inventory",
      schema: inventoryReceivingStockOut,
      rows: Array.from({ length: 20 }, () => ({
        ...raw.stock[0],
        amount: { value: 99, unit: "each" },
      })),
    });
    expect(
      repeated.every((row) => fieldValueOf(row.fields.amount)?.value === 3),
    ).toBe(true);
  });
});
