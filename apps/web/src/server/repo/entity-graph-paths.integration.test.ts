import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { testShortcode } from "@cubby/schemas/testing";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { entityAttachment, inventoryEntry, location } from "~/server/db/schema";

import { getDb } from "./database-helpers";
import { getEntityGraphPaths } from "./entity-graph-paths";
import { createExpense } from "./expense";
import { createPurchase } from "./purchase";
import { attachPurchaseProducts } from "./purchase-products";
import {
  createImageFixture,
  createProductFixture as createProduct,
  makeExpenseInput,
  makeProductInput,
} from "./repo.fixtures";
import { createVendor } from "./vendor";

describe("entity graph path repository", () => {
  const ctx = withTestDb();

  it("finds parallel live evidence in bounded batches and hydrates only path nodes", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Path product" }),
      ctx.actor,
    );
    const cover = await createImageFixture(ctx.db, "path-cover");
    await getDb(ctx.db)
      .insert(entityAttachment)
      .values({ subjectEntityId: product.entityId, imageId: cover.id });
    const vendor = await createVendor(
      ctx.db,
      {
        name: "Path vendor",
        website: null,
        orderUrlTemplate: null,
        orderEvidence: null,
        orderEmailSenders: [],
        browserDomains: [],
        returnWindowDays: null,
        agentHints: {
          ordersListUrl: null,
          pagination: null,
          orderLinkPattern: null,
          notes: [],
        },
        notes: null,
      },
      ctx.actor,
    );
    const purchase = await createPurchase(
      ctx.db,
      purchaseCreateInput.parse({
        vendorId: vendor.output.id,
        orderId: "PATH-ORDER",
        displayLabel: "Path purchase",
        date: "2026-09-08",
        statedTotal: 10,
        notes: null,
      }),
      ctx.actor,
    );
    await Promise.all([
      createExpense(
        ctx.db,
        makeExpenseInput({
          name: "Path expense",
          productId: product.id,
          purchaseId: purchase.output.id,
        }),
        ctx.actor,
      ),
      attachPurchaseProducts(
        ctx.db,
        purchase.entityId,
        [product.entityId],
        ctx.actor,
      ),
    ]);

    const measured = await countTestDbQueries(() =>
      getEntityGraphPaths(ctx.db, {
        start: { entityType: "product", entityId: product.id },
        destination: {
          entityType: "purchase",
          entityId: purchase.output.id,
        },
      }),
    );
    const responseBytes = new TextEncoder().encode(
      JSON.stringify(measured.result),
    ).byteLength;

    expect(measured.result).toMatchObject({
      completion: "exhausted",
      shortestPathCertain: true,
    });
    expect(measured.result.nodes).toHaveLength(2);
    expect(
      measured.result.nodes.find((node) => node.entityType === "product")?.image
        ?.url,
    ).toBe(cover.url);
    expect(measured.result.paths).toHaveLength(1);
    expect(
      measured.result.paths.every((path) => path.edgeIds.length === 1),
    ).toBe(true);
    expect(measured.result.edges.map((edge) => edge.sourceKey).sort()).toEqual([
      "expense",
      "explicit",
    ]);
    // Image representations stay in the shared image query, never per node.
    expect(measured.queryCount).toBe(13);
    expect(responseBytes).toBeLessThan(10_000);
  });

  it("paginates a 60-neighbor frontier without per-record reads", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Wide path product" }),
      ctx.actor,
    );
    const locations = await getDb(ctx.db)
      .insert(location)
      .values(
        Array.from({ length: 60 }, (_, index) => ({
          shortcode: testShortcode("location", `LOC-PATH-${index}`),
          name: `Wide path location ${index}`,
        })),
      )
      .returning({ id: location.id });
    const inventories = await getDb(ctx.db)
      .insert(inventoryEntry)
      .values(
        locations.map((locationRow, index) => ({
          shortcode: testShortcode("inventory", `INV-PATH-${index}`),
          productId: product.entityId,
          locationId: locationRow.id,
          amount: { value: 1, unit: "each" },
        })),
      )
      .returning({ shortcode: inventoryEntry.shortcode });
    const destination = inventories.at(-1);
    if (!destination) throw new Error("Wide path fixture is empty");

    const measured = await countTestDbQueries(() =>
      getEntityGraphPaths(ctx.db, {
        start: { entityType: "product", entityId: product.id },
        destination: {
          entityType: "inventory",
          entityId: destination.shortcode,
        },
      }),
    );
    const responseBytes = new TextEncoder().encode(
      JSON.stringify(measured.result),
    ).byteLength;

    expect(measured.result).toMatchObject({
      completion: "exhausted",
      shortestPathCertain: true,
      paths: [expect.objectContaining({ edgeIds: [expect.any(String)] })],
    });
    expect(measured.result.nodes).toHaveLength(2);
    expect(measured.queryCount).toBe(21);
    expect(responseBytes).toBeLessThan(10_000);
  });
});
