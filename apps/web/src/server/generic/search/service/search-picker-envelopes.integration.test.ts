import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { createRepoEntity } from "tooling/factories/repo";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { buildKernelContext } from "tooling/scenarios/context";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { locationHandlers } from "~/server/domains/location/operations.server";
import { productHandlers } from "~/server/domains/product/operations/product.server";
import { purchaseHandlers } from "~/server/domains/purchase/operations/purchase.server";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { searchHandlers } from "~/server/generic/search/operations/search.server";
import { refreshSearchDocument } from "~/server/generic/search/repo/search-document";
import { systemPrincipal } from "~/server/http/authenticate";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

let queue: ReturnType<typeof captureBackgroundQueue>;
beforeEach(() => {
  queue = captureBackgroundQueue();
});
afterEach(() => queue.restore());

describe("canonical selected search and picker fields", () => {
  const ctx = withTestDb();
  const request = () => ({
    principal: systemPrincipal(buildKernelContext(ctx.db, ctx.actor.userId)),
    headers: new Headers(),
    signal: new AbortController().signal,
  });

  it("keeps selected Product current price and metadata through search, resolve and purchase candidates without row reads", async () => {
    const brand = await findOrCreateVendor(ctx.db, "Synthetic picker maker");
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic calibrated wrench",
        price: 13,
        brandId: brand,
        categoryId: taxonomyShortcode("tools"),
      }),
      ctx.actor,
    );
    const brandCode = product.brandId;
    if (brandCode === null)
      throw new Error("Expected the synthetic Product brand");
    await refreshSearchDocument(ctx.db, "product", product.entityId);
    const found = await productHandlers.operations.search({
      data: {
        filters: { nameFilter: product.name },
        pagination: { pageIndex: 0, pageSize: 20 },
      },
      request: request(),
    });
    expect(found.ok).toBe(true);
    if (!found.ok) throw new Error(found.error.message);
    const item = found.data.items.find((row) => row.id === product.id);
    if (!item) throw new Error("Synthetic Product picker result missing");
    expect(fieldValueOf(item.fields.brandId)).toBe(brandCode);
    expect(fieldValueOf(item.fields.brandName)).toBe("Synthetic picker maker");
    expect(fieldValueOf(item.fields.price)).toBe(13);
    for (const key of ["brandId", "brandName", "price"])
      expect(item).not.toHaveProperty(key);

    const resolve = (count: number) =>
      countTestDbQueries(() =>
        productHandlers.operations.resolveNames({
          data: {
            lines: Array.from({ length: count }, () => ({
              name: product.name,
            })),
          },
          request: request(),
        }),
      );
    const one = await resolve(1);
    const repeated = await resolve(20);
    expect(repeated.queryCount).toBe(one.queryCount);
    expect(repeated.result.ok).toBe(true);
    if (!repeated.result.ok) throw new Error(repeated.result.error.message);
    expect(repeated.result.data).toHaveLength(20);
    for (const result of repeated.result.data) {
      expect(result.exact).toBe(true);
      expect(result.candidates.map((candidate) => candidate.id)).toEqual([
        product.id,
      ]);
      const candidate = result.candidates[0];
      if (!candidate) throw new Error("Synthetic exact candidate missing");
      expect(fieldValueOf(candidate.fields.price)).toBe(13);
      expect(candidate).not.toHaveProperty("price");
    }
    const purchase = await createRepoEntity(ctx, "purchase", {
      vendorId: brandCode,
    });
    const candidates = await purchaseHandlers.operations.linkProductCandidates({
      data: { purchaseId: purchase.output.id, search: product.name },
      request: request(),
    });
    expect(candidates.ok).toBe(true);
    if (!candidates.ok) throw new Error(candidates.error.message);
    const candidate = candidates.data.candidates.find(
      (row) => row.id === product.id,
    );
    if (!candidate) throw new Error("Synthetic purchase candidate missing");
    expect(candidate.fields.price).toEqual(item.fields.price);
    expect(candidate.fields.brandName).toEqual(item.fields.brandName);
    expect(candidate).not.toHaveProperty("price");
    expect(candidate).not.toHaveProperty("brandName");
  });

  it("batches current Location picker rungs and Inventory placement fields while preserving breadcrumbs and groups", async () => {
    const parent = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic picker room", type: "room" }),
      ctx.actor,
    );
    const child = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Synthetic picker bin",
        type: "box",
        parentId: parent.id,
      }),
      ctx.actor,
    );
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic grouped caliper" }),
      ctx.actor,
    );
    const first = await createInventoryFixture(
      ctx.db,
      {
        productId: product.id,
        locationId: child.id,
        amount: { value: 2, unit: "each" },
      },
      ctx.actor,
    );
    const second = await createInventoryFixture(
      ctx.db,
      {
        productId: product.id,
        locationId: parent.id,
        amount: { value: 3, unit: "each" },
      },
      ctx.actor,
    );
    const picker = await locationHandlers.operations.search({
      data: {
        filters: { nameFilter: "Synthetic picker bin" },
        sort: { orderBy: "name", direction: "asc" },
        pagination: { pageIndex: 0, pageSize: 20 },
      },
      request: request(),
    });
    expect(picker.ok).toBe(true);
    if (!picker.ok) throw new Error(picker.error.message);
    const selected = picker.data.data.find((row) => row.id === child.id);
    if (!selected) throw new Error("Synthetic Location picker result missing");
    expect(fieldValueOf(selected.fields.type)).toBe("box");
    expect(selected).not.toHaveProperty("type");
    const ancestor = selected.ancestors.find((row) => row.id === parent.id);
    if (!ancestor) throw new Error("Synthetic parent missing from breadcrumb");
    expect(fieldValueOf(ancestor.fields.type)).toBe("room");
    expect(ancestor).not.toHaveProperty("type");
    await refreshSearchDocument(ctx.db, "product", product.entityId);
    const grouped = await searchHandlers.operations.grouped({
      data: { query: product.name, limit: 10 },
      request: request(),
    });
    expect(grouped.ok).toBe(true);
    if (!grouped.ok) throw new Error(grouped.error.message);
    const group = grouped.data.find(
      (row) => row.kind === "product" && row.primary.id === product.id,
    );
    if (!group || group.kind !== "product")
      throw new Error("Synthetic Product search group missing");
    expect(group.placements).toHaveLength(2);
    const expected = new Map([
      [first.id, { location: child.id, value: 2 }],
      [second.id, { location: parent.id, value: 3 }],
    ]);
    for (const placement of group.placements) {
      const original = expected.get(placement.id);
      if (!original) throw new Error("Unexpected placement membership");
      expect(fieldValueOf(placement.fields.locationId)).toBe(original.location);
      expect(fieldValueOf(placement.fields.amount)).toEqual({
        value: original.value,
        unit: "each",
      });
      expect(placement).not.toHaveProperty("locationId");
      expect(placement).not.toHaveProperty("amount");
      expect(placement.locationPath).toContain("Synthetic picker room");
    }
  });
});
