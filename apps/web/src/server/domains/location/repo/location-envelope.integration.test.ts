import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { withTestDb, TEST_HOME_ID } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { createInventoryEntry } from "~/server/domains/inventory/repo/crud";
import { readPublicEntityRows } from "~/server/generic/derived/service/public-read";
import { locationContentsValuationReport } from "~/server/generic/entity-report/repo/location";
import { drainStoredDerived } from "~/server/testing/background-queue";
import {
  createLocationFixture,
  createProductIdentityFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { buildLocationTree } from "./tree";

describe("recursive Location envelopes", () => {
  const ctx = withTestDb();

  it("projects every supplied level and preserves nested inventory intent and topology", async () => {
    const root = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic tree root" }),
      ctx.actor,
    );
    const child = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic tree child", parentId: root.id }),
      ctx.actor,
    );
    const product = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic tree stock", price: 13 }),
      ctx.actor,
    );
    const leaf = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Synthetic tree leaf",
        parentId: child.id,
        type: "box",
        productId: product.id,
      }),
      ctx.actor,
    );
    const inventory = await createInventoryEntry(
      ctx.db,
      {
        productId: product.entityId,
        locationId: leaf.entityId,
        amount: { value: 2, unit: "each" },
        placement: "stock",
      },
      ctx.actor,
    );
    const raw = (await buildLocationTree(ctx.db, TEST_HOME_ID)).find(
      (row) => row.id === root.id,
    );
    if (!raw) throw new Error("Expected the synthetic root");
    const repeated = await readPublicEntityRows({
      db: ctx.db,
      entity: "location",
      projection: "detail",
      rows: Array.from({ length: 20 }, () => raw),
    });
    const publicRoot = repeated[0];
    const publicChild = publicRoot?.children?.[0];
    const publicLeaf = publicChild?.children?.[0];
    if (!publicRoot || !publicChild || !publicLeaf)
      throw new Error("Expected all supplied tree levels");
    expect([publicRoot.id, publicChild.id, publicLeaf.id]).toEqual([
      root.id,
      child.id,
      leaf.id,
    ]);
    for (const row of [publicRoot, publicChild, publicLeaf]) {
      expect(row).not.toHaveProperty("type");
      expect(row).not.toHaveProperty("valuation");
      expect(row).not.toHaveProperty("fieldResolutions");
      expect(row.fields.valuation.result.kind).toBe("missing");
    }
    expect(fieldValueOf(publicLeaf.fields.type)).toBe("box");
    expect(publicLeaf.totalItemCount).toBe(1);
    const stock = publicLeaf.inventoryItems?.[0];
    if (!stock) throw new Error("Expected the inventory quantity");
    expect(stock.id).toBe(inventory.id);
    expect(fieldValueOf(stock.fields.amount)).toEqual({
      value: 2,
      unit: "each",
    });
    expect(publicLeaf.inventoryItems?.[0]).not.toHaveProperty("amount");
    const installed = fieldValueOf(publicLeaf.fields.product);
    expect(installed?.fields.price.current.assignment).toMatchObject({
      kind: "value",
      value: 13,
    });
    expect(installed).not.toHaveProperty("price");
    const report = await locationContentsValuationReport(ctx.db, root.entityId);
    const stats = report.find((block) => block.kind === "stats");
    expect(stats?.figures[0]?.value).toBeNull();
    await drainStoredDerived(ctx.db);
    const [published] = await readPublicEntityRows({
      db: ctx.db,
      entity: "location",
      projection: "detail",
      rows: [raw],
    });
    if (!published)
      throw new Error("Expected the published Location projection");
    expect(published.fields.valuation.result).toMatchObject({
      kind: "cached",
      freshness: "fresh",
      decision: { outcome: { kind: "value" } },
    });
    expect(fieldValueOf(published.fields.valuation)?.totalValuation).toBe(26);
  });
});
