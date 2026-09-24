import {
  type ProductShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import { expenseCreateInput } from "@cubby/schemas/project";
import { testUserId } from "@cubby/schemas/testing";
import { eq } from "drizzle-orm";
import { TEST_USER_ID, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { entityAttachment } from "~/server/db/schema";
import { callMcpTool } from "~/server/mcp/mcp-test-utils";
import { createMcpServer } from "~/server/mcp/server";
import { getDb } from "~/server/repo/database-helpers";
import { createExpense } from "~/server/repo/expense";
import { createInventoryEntry } from "~/server/repo/inventory";
import { createLedgerParty } from "~/server/repo/ledger-party";
import { mergeProducts } from "~/server/repo/product";
import { listProductMatchRows } from "~/server/repo/product-match-candidate";
import { attachPurchaseProducts } from "~/server/repo/purchase-products";
import {
  createImageFixture,
  createLocationFixture,
  createProductFixture,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { findOrCreateVendor } from "~/server/repo/vendor";
import {
  dismissProductMatchPair,
  getProductMatchQueue,
  mergeProductMatch,
  proposeProductMatch,
} from "~/server/services/product-match.service";
import { createTestRequestContext } from "~/server/testing/request-context";

import { taxonomyShortcode } from "../../../tooling/product-category-fixtures";

/** Vector index is absent in tests, so ranking runs on names, category, owner. */
const namesOnly = {
  vectorStore: {
    configured: () => false,
    upsert: async () => {},
    deleteByIds: async () => {},
    query: async () => [],
    queryById: async () => [],
  },
  semanticConfigured: () => false,
};

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
        ownershipMode: ownerLedgerPartyId ? "person" : "inherit",
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
    await createExpense(
      ctx.db,
      expenseCreateInput.parse(
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
      ),
      ctx.actor,
    );
    return created;
  };

  const queueFor = async (id: ProductShortcode) =>
    (await getProductMatchQueue(ctx.db, { productId: id }, namesOnly)).items;

  const pairOf = (item: { keeper: { id: string }; other: { id: string } }) => [
    item.keeper.id,
    item.other.id,
  ];

  it.each([
    {
      name: "pairs a stocked never-bought product with a purchased one, keeping the purchase side",
      run: async () => {
        const owner = await member("Synthetic wearer");
        const photo = await photoProduct("Gray crew t-shirt — M", { owner });
        const bought = await purchasedProduct(
          "Crew neck t-shirt, grey, medium",
          { owner },
        );
        const items = await queueFor(photo.id);
        expect(items.map(pairOf)).toEqual([[bought.id, photo.id]]);
        expect(items[0]).toMatchObject({
          source: "detector",
          keeper: {
            role: "purchase",
            purchase: { vendor: "Synthetic outfitter" },
          },
          other: { role: "photo", inventoryCount: 1 },
          warnings: [],
        });
        expect(items[0]!.signals).toEqual(
          expect.arrayContaining([
            "Shared name words: crew, gray, shirt",
            "Same owner",
          ]),
        );
      },
    },
    {
      name: "recognizes an itemized purchase recorded only by its Expense",
      run: async () => {
        const photo = await photoProduct("Gray crew shirt");
        const bought = await purchasedProduct("Heather crew tee", {
          expenseOnly: true,
        });
        await proposeProductMatch(ctx.db, {
          productIds: [photo.id, bought.id],
          evidence: "Synthetic order line matches the photographed shirt",
        });
        const items = await queueFor(photo.id);
        expect(items).toMatchObject([
          {
            source: "agent",
            keeper: {
              id: bought.id,
              role: "purchase",
              purchase: { vendor: "Synthetic outfitter" },
            },
            other: { id: photo.id, role: "photo", inventoryCount: 1 },
          },
        ]);
      },
    },
    {
      name: "does not treat an Expense-only sale as an acquisition",
      run: async () => {
        const photo = await photoProduct("Wool scarf");
        const sold = await purchasedProduct("Wool scarf, resold", {
          expenseOnly: true,
          expenseCost: -20,
        });
        await proposeProductMatch(ctx.db, {
          productIds: [photo.id, sold.id],
          evidence: "Synthetic pair for direction check",
        });
        const items = await queueFor(photo.id);
        expect(items).toHaveLength(1);
        expect([items[0]?.keeper, items[0]?.other]).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: photo.id, role: "photo" }),
            expect.objectContaining({ id: sold.id, role: "other" }),
          ]),
        );
      },
    },
    {
      name: "does not pair when the stocked side was also bought",
      run: async () => {
        const stockedAndBought = await purchasedProduct("Canvas tote bag");
        const shelf = await createLocationFixture(
          ctx.db,
          makeLocationInput({ name: "Tote shelf" }),
          ctx.actor,
        );
        await stock(stockedAndBought.entityId, shelf.entityId);
        await purchasedProduct("Canvas tote bag, natural");
        expect(await queueFor(stockedAndBought.id)).toEqual([]);
      },
    },
    {
      name: "ranks a category mismatch below a match without excluding it",
      run: async () => {
        const photo = await photoProduct("Linen apron", {
          category: "apparel",
        });
        const same = await purchasedProduct("Linen apron, olive", {
          category: "apparel",
        });
        const other = await purchasedProduct("Linen apron tool roll", {
          category: "tools",
        });
        const items = await queueFor(photo.id);
        expect(items.map((item) => item.keeper.id)).toEqual([
          same.id,
          other.id,
        ]);
        expect(items[1]!.signals).toContain("Different top-level category");
      },
    },
    {
      name: "ranks an owner mismatch below an owner match without excluding it",
      run: async () => {
        const [wearer, someoneElse] = await Promise.all([
          member("Synthetic wearer"),
          member("Synthetic sibling"),
        ]);
        const photo = await photoProduct("Wool beanie", { owner: wearer });
        const theirs = await purchasedProduct("Wool beanie (charcoal)", {
          owner: someoneElse,
        });
        const mine = await purchasedProduct("Wool beanie, charcoal", {
          owner: wearer,
        });
        const items = await queueFor(photo.id);
        expect(items.map((item) => item.keeper.id)).toEqual([
          mine.id,
          theirs.id,
        ]);
        expect(items[1]!.signals).toContain("Different owners");
      },
    },
    {
      name: "drops a dismissed pair and persists the dismissal",
      run: async () => {
        const photo = await photoProduct("Rain shell jacket");
        const bought = await purchasedProduct("Rain shell jacket, navy");
        await dismissProductMatchPair(ctx.db, {
          productIds: [photo.id, bought.id],
        });
        expect(await queueFor(photo.id)).toEqual([]);
        expect(await listProductMatchRows(ctx.db)).toMatchObject([
          { source: "detector", state: "dismissed" },
        ]);
      },
    },
    {
      name: "drops a merged pair and discards its review row",
      run: async () => {
        const photo = await photoProduct("Trail running sock");
        const bought = await purchasedProduct("Trail running sock, 3 pair");
        await proposeProductMatch(ctx.db, {
          productIds: [photo.id, bought.id],
          evidence: "Same cuff stripe on the vendor page",
        });
        await mergeProducts(
          ctx.db,
          { keepId: bought.id, mergeIds: [photo.id] },
          ctx.actor,
        );
        expect(await queueFor(bought.id)).toEqual([]);
        expect(await listProductMatchRows(ctx.db)).toEqual([]);
      },
    },
    {
      name: "ranks an agent proposal, with its evidence, above detector pairs",
      run: async () => {
        const photo = await photoProduct("Striped scarf");
        const detected = await purchasedProduct("Striped scarf, wool");
        const proposed = await purchasedProduct("Neck wrap SKU 4471");
        await proposeProductMatch(ctx.db, {
          productIds: [proposed.id, photo.id],
          evidence: "Vendor photo shows the same stripe pattern",
          sourceUrls: ["https://vendor.example/p/4471"],
        });
        const items = await queueFor(photo.id);
        expect(items.map(pairOf)).toEqual([
          [proposed.id, photo.id],
          [detected.id, photo.id],
        ]);
        expect(items[0]).toMatchObject({
          source: "agent",
          evidence: "Vendor photo shows the same stripe pattern",
          sourceUrls: ["https://vendor.example/p/4471"],
        });
      },
    },
    {
      name: "warns when both sides are stocked, since a merge sums quantities",
      run: async () => {
        const photo = await photoProduct("Leather belt");
        const bought = await purchasedProduct("Leather belt, brown");
        const shelf = await createLocationFixture(
          ctx.db,
          makeLocationInput({ name: "Received shelf" }),
          ctx.actor,
        );
        await stock(bought.entityId, shelf.entityId);
        const [item] = await queueFor(photo.id);
        expect(item?.warnings).toEqual([
          expect.stringContaining("Merging sums their quantities"),
        ]);
      },
    },
  ])("$name", async ({ run }) => {
    expect.hasAssertions();
    await run();
  });

  it("merges a match and leads the survivor's covers with the household's own photo", async () => {
    const photo = await photoProduct("Denim jacket");
    const bought = await purchasedProduct("Denim jacket, washed");
    const [catalog, label, own] = await Promise.all([
      createImageFixture(ctx.db, "catalog", { source: "catalog" }),
      createImageFixture(ctx.db, "label", { source: "own" }),
      createImageFixture(ctx.db, "own", { source: "own" }),
    ]);
    await getDb(ctx.db)
      .insert(entityAttachment)
      .values([
        { subjectEntityId: bought.entityId, imageId: catalog.id, sortOrder: 0 },
        {
          subjectEntityId: photo.entityId,
          imageId: label.id,
          sortOrder: 0,
          purpose: "label",
        },
        { subjectEntityId: photo.entityId, imageId: own.id, sortOrder: 1 },
      ]);
    const base = createTestRequestContext(ctx.db, {
      auth: { userId: testUserId(TEST_USER_ID) },
    });
    if (!base.actorContext) throw new Error("Test actor is required");

    await mergeProductMatch(
      { ...base, actorContext: base.actorContext },
      { keepId: bought.id, mergeId: photo.id },
    );

    const order = await getDb(ctx.db)
      .select({ imageId: entityAttachment.imageId })
      .from(entityAttachment)
      .where(eq(entityAttachment.subjectEntityId, bought.entityId))
      .orderBy(entityAttachment.sortOrder);
    expect(order.map((row) => row.imageId)).toEqual([
      own.id,
      catalog.id,
      label.id,
    ]);
  });
});

describe("propose_product_match tool", () => {
  const ctx = withTestDb();

  const call = (args: Parameters<typeof callMcpTool>[2]) =>
    callMcpTool(createMcpServer(), "propose_product_match", args, {
      recommendations: {
        proposeProductMatch: (input) => proposeProductMatch(ctx.db, input),
      },
    });

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
    await dismissProductMatchPair(ctx.db, {
      productIds: [photo.id, vendor.id],
    });
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
