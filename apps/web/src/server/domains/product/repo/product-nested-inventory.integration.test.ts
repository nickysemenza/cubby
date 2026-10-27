import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { productInventoryEntriesByIdOut } from "@cubby/schemas/product";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { createInventoryEntry } from "~/server/domains/inventory/repo/crud";
import { getProductInventoryEntriesWorkflow } from "~/server/domains/product/operations/product.server";
import { readPublicEntityRows } from "~/server/generic/derived/service/public-read";
import { requireActor } from "~/server/http/request-context";
import {
  createLocationFixture,
  createProductIdentityFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import { getProductWithFood } from "./write/product-writes";

describe("Product nested live Inventory reads", () => {
  const ctx = withTestDb();

  it("batches authoritative amounts and terminates compact holding Locations while preserving stock and installed evidence", async () => {
    const product = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic nested inventory product",
        price: 7,
      }),
      ctx.actor,
    );
    const stock = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic stock shelf" }),
      ctx.actor,
    );
    const installed = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic installed room" }),
      ctx.actor,
    );
    const stockEntry = await createInventoryEntry(
      ctx.db,
      {
        productId: product.entityId,
        locationId: stock.entityId,
        amount: { value: 2, unit: "each" },
        placement: "stock",
      },
      ctx.actor,
    );
    const installedEntry = await createInventoryEntry(
      ctx.db,
      {
        productId: product.entityId,
        locationId: installed.entityId,
        amount: { value: 3, unit: "each" },
        placement: "installed",
      },
      ctx.actor,
    );
    const baseline = await readPublicEntityRows({
      db: ctx.db,
      entity: "inventory",
      projection: "detail",
      rows: [stockEntry, installedEntry],
    });
    const inventoryById = new Map(baseline.map((entry) => [entry.id, entry]));
    const raw = await getProductWithFood(
      ctx.db,
      { findFood: async () => null },
      product.entityId,
    );
    const read = (count: number) =>
      countTestDbQueries(() =>
        readPublicEntityRows({
          db: ctx.db,
          entity: "product",
          projection: "detail",
          rows: Array.from({ length: count }, (_, index) => ({
            ...raw,
            inventoryEntry: raw.inventoryEntry.map((entry) => ({
              ...entry,
              amount: { value: 99, unit: "each" },
              valuation: 999,
              location: {
                ...entry.location,
                name: `Synthetic holding snapshot ${index}`,
              },
            })),
          })),
        }),
      );
    const single = await read(1);
    const repeated = await read(20);
    expect(repeated.queryCount).toBe(single.queryCount);
    for (const [index, row] of repeated.result.entries()) {
      expect(row.inventoryEntry.map((entry) => entry.id)).toEqual(
        raw.inventoryEntry.map((entry) => entry.id),
      );
      for (const [entryIndex, entry] of row.inventoryEntry.entries()) {
        expect(fieldValueOf(entry.fields.amount)).toEqual(
          raw.inventoryEntry[entryIndex]?.amount,
        );
        expect(entry.fields.amount.current.assignment).toMatchObject({
          kind: "value",
          value: raw.inventoryEntry[entryIndex]?.amount,
        });
        expect(entry.placement).toBe(raw.inventoryEntry[entryIndex]?.placement);
        expect(entry.verifiedAt).toEqual(
          raw.inventoryEntry[entryIndex]?.verifiedAt,
        );
        expect(entry.fields.valuation.result).toEqual(
          inventoryById.get(entry.id)?.fields.valuation.result,
        );
        expect(entry).not.toHaveProperty("amount");
        expect(entry).not.toHaveProperty("valuation");
        expect(entry).not.toHaveProperty("product");
        expect(Object.keys(entry.location).sort()).toEqual(["id", "name"]);
        expect(entry.location.name).toBe(`Synthetic holding snapshot ${index}`);
      }
    }
    const context = requireActor(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );
    const capability = productInventoryEntriesByIdOut.parse(
      await getProductInventoryEntriesWorkflow(context, {
        ids: [product.id],
      }),
    );
    const entries = capability[product.id];
    expect(entries?.map((entry) => entry.id).sort()).toEqual(
      raw.inventoryEntry.map((entry) => entry.id).sort(),
    );
    for (const entry of entries ?? []) {
      expect(fieldValueOf(entry.fields.amount)).toEqual(
        fieldValueOf(inventoryById.get(entry.id)!.fields.amount),
      );
    }
    for (const entry of entries ?? []) {
      expect(entry).not.toHaveProperty("amount");
      expect(entry).not.toHaveProperty("valuation");
      expect(Object.keys(entry.location).sort()).toEqual(["id", "name"]);
    }
  });
});
