import {
  type ProductShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import { testUserId } from "@cubby/schemas/testing";
import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { TEST_USER_ID, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { entityAttachment } from "~/server/db/schema";
import { callMcpTool } from "~/server/mcp/mcp-test-utils";
import { createMcpServer } from "~/server/mcp/server";
import { reviewAssessment } from "~/server/repo/assessment-review";
import { getDb } from "~/server/repo/database-helpers";
import { createInventoryEntry } from "~/server/repo/inventory/crud";
import { createLedgerParty } from "~/server/repo/ledger-party";
import {
  publishProductPair,
  upsertAgentProductMatch,
  productPairKey,
} from "~/server/repo/product-match-candidate";
import { listProductMatchRows } from "~/server/repo/product-match-candidate";
import { attachPurchaseProducts } from "~/server/repo/purchase-products";
import {
  createImageFixture,
  createLocationFixture,
  createProductFixture,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
  insertEntityAttachments,
} from "~/server/repo/repo.fixtures";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { findOrCreateVendor } from "~/server/repo/vendor";
import { kernelCtx } from "~/server/runs/suggestion-sweep.fixtures";
import {
  getProductMatchQueue,
  mergeProductMatch,
  proposeProductMatch,
} from "~/server/services/product-match.service";
import { createTestRequestContext } from "~/server/testing/request-context";

import { taxonomyShortcode } from "../../../tooling/product-category-fixtures";

type Category = Parameters<typeof taxonomyShortcode>[0];

describe("product match queue", () => {
  const ctx = withTestDb();

  const member = async (name: string) =>
    (
      await createLedgerParty(
        ctx.db,
        { name, kind: "member", notes: null },
        ctx.actor,
      )
    ).output.id;

  const product = (name: string, category?: Category) =>
    createProductFixture(
      ctx.db,
      makeProductInput({
        name,
        model: null,
        categoryId: category ? taxonomyShortcode(category) : null,
      }),
      ctx.actor,
    );

  it("requires stored pair evidence for a directed photo-review comparison", async () => {
    const source = await product("Synthetic directed source"),
      candidate = await product("Synthetic directed candidate");
    expect(
      (
        await getProductMatchQueue(ctx.db, {
          productId: source.id,
          candidateId: candidate.id,
        })
      ).items,
    ).toEqual([]);
    await upsertAgentProductMatch(ctx.db, {
      productIds: [source.entityId, candidate.entityId],
      evidence: "Synthetic member investigation",
      sourceUrls: [],
    });
    expect(
      (
        await getProductMatchQueue(ctx.db, {
          productId: source.id,
          candidateId: candidate.id,
        })
      ).items,
    ).toHaveLength(1);
  });

  /** Stocked, never bought: what a wardrobe photo import creates. */
  const photoProduct = async (
    name: string,
    opts: { owner?: string; category?: Category } = {},
  ) => {
    const [created, location] = await Promise.all([
      product(name, opts.category),
      createLocationFixture(
        ctx.db,
        makeLocationInput({ name: `${name} shelf` }),
        ctx.actor,
      ),
    ]);
    await stock(created.entityId, location.entityId, opts.owner);
    return created;
  };

  const stock = async (
    productId: Awaited<ReturnType<typeof product>>["entityId"],
    locationId: Awaited<ReturnType<typeof createLocationFixture>>["entityId"],
    owner?: string,
  ) => {
    const ownerLedgerPartyId = owner
      ? await resolveOrThrow(ctx.db, "ledgerParty", owner)
      : null;
    return await createInventoryEntry(
      ctx.db,
      {
        productId,
        locationId,
        amount: { value: 1, unit: "each" },
        ownershipMode: ownerLedgerPartyId ? "explicit" : "inherit",
        ownerLedgerPartyId,
      },
      ctx.actor,
    );
  };

  /** On an order, with the owner as the line's beneficiary. */
  const purchasedProduct = async (
    name: string,
    opts: {
      owner?: string;
      category?: Category;
      expenseOnly?: boolean;
      expenseCost?: number;
    } = {},
  ) => {
    const created = await product(name, opts.category);
    const vendorId = await findOrCreateVendor(ctx.db, "Synthetic outfitter");
    const order = await insertWithShortcode(ctx.db, "purchase", {
      vendorId,
      date: "2026-09-01",
      displayLabel: `${name} order`,
    });
    if (!opts.expenseOnly)
      await attachPurchaseProducts(
        ctx.db,
        order.id,
        [created.entityId],
        ctx.actor,
      );
    await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        name: `${name} line`,
        cost: opts.expenseCost ?? 100,
        date: "2026-09-01",
        purchaseId: parseShortcodeFor("purchase", order.shortcode),
        productId: created.id,
        beneficiaries: opts.owner
          ? [
              {
                partyId: parseShortcodeFor("ledgerParty", opts.owner),
                weight: 1,
              },
            ]
          : [],
      }),
    );
    return created;
  };

  const queueFor = async (id: ProductShortcode) =>
    (await getProductMatchQueue(ctx.db, { productId: id })).items;

  it("reads a stored pair across intake paths, keeps purchase history, and never discovers on read", async () => {
    const owner = await member("Synthetic stored pair owner");
    const photo = await photoProduct("Synthetic stored photo item", { owner });
    const bought = await purchasedProduct("Synthetic stored purchase item", {
      owner,
    });
    expect(await queueFor(photo.id)).toEqual([]);
    await publishProductPair(ctx.db, {
      productIds: [photo.entityId, bought.entityId],
      source: "detector",
      evidence: "Synthetic retained identity",
      sourceUrls: [],
    });
    const [item] = await queueFor(photo.id);
    expect(item?.keeper.id).toBe(bought.id);
    expect(item?.other).toMatchObject({
      id: photo.id,
      role: "photo",
      inventoryCount: 1,
    });
    expect(item?.keeper.owner?.id).toBe(owner);
    expect(item?.variant.color.relation).toBe("unknown");
    expect((await listProductMatchRows(ctx.db)).length).toBe(1);
    await dismissPair(
      ctx.db,
      { productIds: [photo.id, bought.id] },
      kernelCtx(ctx),
    );
    expect(await queueFor(photo.id)).toEqual([]);
    expect(await listProductMatchRows(ctx.db)).toMatchObject([
      { state: "dismissed" },
    ]);
  });

  it("merges a match and leads the survivor's covers with the household's own photo", async () => {
    const photo = await photoProduct("Denim jacket");
    const bought = await purchasedProduct("Denim jacket, washed");
    const [catalog, label, own] = await Promise.all([
      createImageFixture(ctx.db, "catalog", { source: "catalog" }),
      createImageFixture(ctx.db, "label", { source: "own" }),
      createImageFixture(ctx.db, "own", { source: "own" }),
    ]);
    await insertEntityAttachments(ctx.db, [
      { entityId: bought.entityId, imageId: catalog.id, sortOrder: 0 },
      {
        entityId: photo.entityId,
        imageId: label.id,
        sortOrder: 0,
        purpose: "label",
      },
      { entityId: photo.entityId, imageId: own.id, sortOrder: 1 },
    ]);
    const base = createTestRequestContext(ctx.db, {
      auth: { userId: testUserId(TEST_USER_ID) },
    });
    if (!base.actorContext) throw new Error("Test actor is required");

    const pair = await upsertAgentProductMatch(ctx.db, {
      productIds: [bought.entityId, photo.entityId],
      evidence: "Synthetic reviewed identity",
      sourceUrls: [],
    });
    await mergeProductMatch(
      { ...base, actorContext: base.actorContext },
      {
        keepId: bought.id,
        mergeId: photo.id,
        assessmentId: pair.id,
        expectedFingerprint: pair.fingerprint!,
      },
    );

    const order = await getDb(ctx.db)
      .select({ imageId: entityAttachment.imageId })
      .from(entityAttachment)
      .where(eq(entityAttachment.entityId, bought.entityId))
      .orderBy(entityAttachment.sortOrder);
    expect(order.map((row) => row.imageId)).toEqual([
      own.id,
      catalog.id,
      label.id,
    ]);
  });
});

describe("product_enrichment.propose_match", () => {
  const ctx = withTestDb();

  const call = (args: Parameters<typeof callMcpTool>[2]) =>
    callMcpTool(
      createMcpServer(),
      "product_enrichment",
      { action: "propose_match", ...args },
      {
        db: ctx.db,
      },
    );

  const twoProducts = async () =>
    await Promise.all([
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Photo hoodie", model: null }),
        ctx.actor,
      ),
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Vendor hoodie", model: null }),
        ctx.actor,
      ),
    ]);

  it.each([
    {
      name: "the same product twice",
      productIds: (a: string) => [a, a],
      error: "two different products",
    },
    {
      name: "a non-product code",
      productIds: (a: string) => [a, "LOC-2ABC"],
      error: "PRD",
    },
    {
      name: "an unknown product",
      productIds: (a: string) => [a, "PRD-ZZZZ"],
      error: "not found",
    },
  ])("rejects $name", async ({ productIds, error }) => {
    const [photo] = await twoProducts();
    const result = await call({
      productIds: productIds(photo.id),
      evidence: "Looks the same",
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(error);
    expect(await listProductMatchRows(ctx.db)).toEqual([]);
  });

  it("is idempotent across order and replaces the evidence on re-propose", async () => {
    const [photo, vendor] = await twoProducts();
    const first = await call({
      productIds: [photo.id, vendor.id],
      evidence: "Same drawstring colour",
    });
    const again = await call({
      productIds: [vendor.id, photo.id],
      evidence: "Same drawstring colour and cuff logo",
      sourceUrls: ["https://vendor.example/hoodie"],
    });
    expect(first.structuredContent).toMatchObject({
      created: true,
      state: "open",
    });
    expect(again.structuredContent).toMatchObject({
      created: false,
      state: "open",
      evidence: "Same drawstring colour and cuff logo",
      sourceUrls: ["https://vendor.example/hoodie"],
    });
    expect(await listProductMatchRows(ctx.db)).toHaveLength(1);
  });

  it("keeps a dismissed pair dismissed when re-proposed", async () => {
    const [photo, vendor] = await twoProducts();
    await dismissPair(
      ctx.db,
      {
        productIds: [photo.id, vendor.id],
      },
      kernelCtx(ctx),
    );
    const result = await call({
      productIds: [photo.id, vendor.id],
      evidence: "Still think these match",
    });
    expect(result.structuredContent).toMatchObject({
      source: "agent",
      state: "dismissed",
    });
  });
});

async function dismissPair(
  db: Parameters<typeof proposeProductMatch>[0],
  input: { productIds: readonly [ProductShortcode, ProductShortcode] },
  context: Parameters<typeof reviewAssessment>[1],
) {
  const ids = await Promise.all(
    input.productIds.map((id) => resolveOrThrow(db, "product", id)),
  );
  const pair = await upsertAgentProductMatch(db, {
    productIds: [ids[0]!, ids[1]!],
    evidence: "Synthetic hide preference",
    sourceUrls: [],
  });
  return reviewAssessment(db, context, {
    assessmentId: pair.id,
    operationId: crypto.randomUUID(),
    verdict: "dismissed",
    suppression: {
      scope: "product_pair",
      candidateKey: productPairKey(ids[0]!, ids[1]!),
      fingerprint: null,
    },
  });
}
