import { testShortcode } from "@cubby/schemas/testing";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { inventoryEntry, location } from "~/server/db/schema";
import { createExpense } from "~/server/domains/expense/repo/crud";
import { attachPurchaseProducts } from "~/server/domains/purchase/repo/purchase-products";
import { createVendor } from "~/server/domains/vendor/repo/vendor";
import {
  createImageFixture,
  createProductFixture as createProduct,
  makeExpenseInput,
  makeProductInput,
  insertEntityAttachments,
  insertEntityFixtures,
} from "~/server/testing/repo.fixtures";

import { getEntityGraphPaths } from "./entity-graph-paths";

describe("entity graph path repository", () => {
  const ctx = withTestDb();

  it("finds parallel live evidence and hydrates only path nodes", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Path product" }),
      ctx.actor,
    );
    const cover = await createImageFixture(ctx.db, "path-cover");
    await insertEntityAttachments(ctx.db, {
      entityId: product.entityId,
      imageId: cover.id,
    });
    const vendor = await createVendor(
      ctx.db,
      {
        defaultSpendingCategoryId: null,
        spendingProfile: "unspecified",
        aliases: [],
        name: "Path vendor",
        website: null,
        orderUrlTemplate: null,
        itemizationExpectation: null,
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
    const purchase = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      orderId: "PATH-ORDER",
      displayLabel: "Path purchase",
      date: "2026-09-08",
      statedTotal: 10,
      notes: null,
    });
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

    const graph = await getEntityGraphPaths(ctx.db, {
      start: { entityKind: "product", entityId: product.id },
      destination: {
        entityKind: "purchase",
        entityId: purchase.output.id,
      },
    });
    const responseBytes = new TextEncoder().encode(
      JSON.stringify(graph),
    ).byteLength;

    expect(graph).toMatchObject({
      completion: "exhausted",
      shortestPathCertain: true,
    });
    expect(graph.nodes).toHaveLength(2);
    expect(
      graph.nodes.find((node) => node.entityKind === "product")?.image?.url,
    ).toBe(cover.url);
    expect(graph.paths).toHaveLength(2);
    expect(
      new Set(graph.paths.map((path) => path.edgeIds.join("/"))).size,
    ).toBe(2);
    expect(graph.paths.every((path) => path.edgeIds.length === 1)).toBe(true);
    expect(graph.edges.map((edge) => edge.sourceKey).sort()).toEqual([
      "expense",
      "explicit",
    ]);
    expect(responseBytes).toBeLessThan(10_000);
  });

  it("paginates a 60-neighbor frontier", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Wide path product" }),
      ctx.actor,
    );
    const locations = await insertEntityFixtures(
      ctx.db,
      location,
      "location",
      Array.from({ length: 60 }, (_, index) => ({
        shortcode: testShortcode("location", `LOC-PATH-${index}`),
        name: `Wide path location ${index}`,
        type: "area" as const,
      })),
    );
    const inventories = await insertEntityFixtures(
      ctx.db,
      inventoryEntry,
      "inventory",
      locations.map((locationRow, index) => ({
        shortcode: testShortcode("inventory", `INV-PATH-${index}`),
        productId: product.entityId,
        locationId: locationRow.id,
        amountValue: 1,
        amountUnit: "each",
      })),
    );
    const destination = inventories.at(-1);
    if (!destination) throw new Error("Wide path fixture is empty");

    const graph = await getEntityGraphPaths(ctx.db, {
      start: { entityKind: "product", entityId: product.id },
      destination: {
        entityKind: "inventory",
        entityId: destination.shortcode,
      },
    });
    const responseBytes = new TextEncoder().encode(
      JSON.stringify(graph),
    ).byteLength;

    expect(graph).toMatchObject({
      completion: "exhausted",
      shortestPathCertain: true,
      paths: [expect.objectContaining({ edgeIds: [expect.any(String)] })],
    });
    expect(graph.nodes).toHaveLength(2);
    expect(responseBytes).toBeLessThan(10_000);
  });
});
