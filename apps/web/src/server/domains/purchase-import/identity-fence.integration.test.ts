import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { type ExtractedOrderCandidate } from "@cubby/schemas/purchase-import";
import { and, eq, ne } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, notDeleted, withTransaction } from "~/server/db/helpers";
import {
  entityExternalId,
  entitySource,
  externalSource,
  expense,
  importSourceClaim,
  importSourceProduct,
  inventoryEntry,
  product,
  purchase,
  vendor as vendorTable,
} from "~/server/db/schema";
import { ensureExternalSources } from "~/server/generic/entity-links/repo/entity-external-ids";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import {
  learnPurchaseProductExternalId,
  PurchaseProductExternalIdCollisionError,
} from "./external-id-learning";
import {
  mailSource,
  memberImport,
  memberImportWorld,
  prepareMemberImport,
  retainedMailFixture,
  type MemberImportOrder,
} from "./order-import.fixtures";

const checksum = (digit: string) => digit.repeat(64);

// A no-ID original erases a known order id or splits from its reviewed
// Purchase; two identical no-ID orders through Vendor aliases collapse into
// one; an unfamiliar Vendor is created twice; a Product or Vendor removed
// after prepare still receives a Purchase, Expenses, or source bindings.
describe("member prepare and commit identity fences", () => {
  const ctx = withTestDb();

  const candidate = (
    orderId: string | null,
    amount = 10,
    title = "Synthetic annual service",
  ): ExtractedOrderCandidate => ({
    orderId,
    orderedAt: "2026-10-01T12:00:00Z",
    merchant: "Synthetic service merchant",
    currency: "USD",
    printedGrandTotal: amount,
    lines: [{ title, amount, quantity: 1, lineKind: "principal" }],
    payments: [],
    allShipmentsDelivered: true,
  });
  const source = {
    kind: "receipt_photo" as const,
    externalKey: "synthetic:identity-fence",
    checksum: checksum("a"),
  };

  it("converges a fresh no-ID original on the existing Purchase without erasing its order identity", async () => {
    const { vendor } = await memberImportWorld(ctx.db, ctx.actor);
    const existing = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "ORDER-ONE",
    });
    const { committed } = await memberImport(ctx.db, ctx.actor, {
      key: "no-id-original",
      defaultTrade: "other",
      orders: [
        {
          stableOrderId: "no-id-original",
          vendorId: vendor.shortcode,
          targetPurchaseId: existing.shortcode,
          source,
          extraction: { status: "ready", candidate: candidate(null) },
        },
      ],
    });
    expect(committed.items[0]?.purchaseId).toBe(existing.shortcode);
    const rows = await getDb(ctx.db).select().from(purchase);
    expect(rows.map(({ orderId }) => orderId)).toEqual(["ORDER-ONE"]);
    expect(await getDb(ctx.db).select().from(product)).toEqual([]);
  });

  it("refuses identical no-ID orders reached through different aliases of the same Vendor", async () => {
    const { vendor } = await memberImportWorld(ctx.db, ctx.actor);
    await expect(
      prepareMemberImport(ctx.db, ctx.actor, {
        key: "no-id-aliases",
        orders: [
          {
            stableOrderId: "by-id",
            vendorId: vendor.shortcode,
            source,
            extraction: { status: "ready", candidate: candidate(null) },
          },
          {
            stableOrderId: "by-name",
            vendor: { name: vendor.name },
            source,
            extraction: { status: "ready", candidate: candidate(null) },
          },
        ],
      }),
    ).rejects.toThrow(/same Vendor and order id/);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    expect(await getDb(ctx.db).select().from(purchase)).toEqual([]);
    expect(await getDb(ctx.db).select().from(importSourceClaim)).toEqual([]);
  });

  it("creates one unfamiliar Vendor for two distinct orders and no physical service Products", async () => {
    await memberImportWorld(ctx.db, ctx.actor);
    const { committed } = await memberImport(ctx.db, ctx.actor, {
      key: "unfamiliar-vendor",
      defaultTrade: "other",
      orders: ["ORDER-ONE", "ORDER-TWO"].map((orderId, index) => ({
        stableOrderId: orderId.toLowerCase(),
        vendor: { name: "Synthetic unfamiliar merchant" },
        source,
        extraction: {
          status: "ready" as const,
          candidate: candidate(orderId, 10 + index * 10),
        },
      })),
    });
    expect(new Set(committed.items.map((item) => item.purchaseId)).size).toBe(
      2,
    );
    expect(
      await getDb(ctx.db)
        .select({ id: vendorTable.id })
        .from(vendorTable)
        .where(eq(vendorTable.name, "Synthetic unfamiliar merchant")),
    ).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(product)).toEqual([]);
  });

  async function preparedProductOrder() {
    const { vendor } = await memberImportWorld(ctx.db, ctx.actor);
    const selected = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic copper instrument" }),
      ctx.actor,
    );
    const [row] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, selected.entityId));
    const order: MemberImportOrder = {
      stableOrderId: "selected-product",
      vendorId: vendor.shortcode,
      source,
      extraction: {
        status: "ready",
        candidate: candidate(
          "SYNTHETIC-REUSE",
          24,
          "Synthetic copper instrument",
        ),
      },
      resolutions: [
        {
          kind: "existing",
          productId: parseShortcodeFor("product", row!.shortcode),
        },
      ],
    };
    const preparation = await prepareMemberImport(ctx.db, ctx.actor, {
      key: "selected-product",
      orders: [order],
      defaultTrade: "other",
    });
    return { vendor, selected, preparation };
  }

  async function expectNothingWritten() {
    expect(await getDb(ctx.db).select().from(purchase)).toEqual([]);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    expect(await getDb(ctx.db).select().from(importSourceClaim)).toEqual([]);
    expect(await getDb(ctx.db).select().from(importSourceProduct)).toEqual([]);
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
  }

  it("refuses a Product deleted after prepare before committing Purchase, expenses, or source bindings", async () => {
    const { selected, preparation } = await preparedProductOrder();
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, selected.entityId));
    await expect(preparation.commit()).rejects.toThrow(/Product/);
    await expectNothingWritten();
  });

  it("refuses a Vendor deleted after prepare before committing Purchase, expenses, or source bindings", async () => {
    const { vendor, preparation } = await preparedProductOrder();
    await getDb(ctx.db)
      .update(vendorTable)
      .set({ deletedAt: new Date() })
      .where(eq(vendorTable.id, vendor.id));
    await expect(preparation.commit()).rejects.toThrow(/deleted or merged/);
    await expectNothingWritten();
  });

  const storeName = "The Synthetic Hardware Store";

  async function senderVendor() {
    const { party } = await memberImportWorld(ctx.db, ctx.actor);
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic Hardware",
      orderEmailSenders: ["orders@hardware.example"],
    });
    const existing = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "ORDER-ONE",
    });
    return { party, vendor, existing };
  }

  const orderMail = (
    ledgerPartyId: Parameters<typeof retainedMailFixture>[1]["ledgerPartyId"],
    sender: string,
  ) =>
    retainedMailFixture(ctx.db, {
      ledgerPartyId,
      messageId: `synthetic-${sender.length}`,
      checksum: checksum("c"),
      sender,
    });

  const vendorRows = () =>
    getDb(ctx.db)
      .select({
        id: vendorTable.id,
        name: vendorTable.name,
        aliases: vendorTable.aliases,
      })
      .from(vendorTable)
      // Every case starts from memberImportWorld()'s own unrelated Vendor.
      .where(ne(vendorTable.name, "Synthetic service merchant"));

  it("converges an order Email on the Vendor its exact sender proves and learns the merchant name", async () => {
    const { party, vendor, existing } = await senderVendor();
    const mail = await orderMail(
      party.id,
      `"${storeName}" <Orders@Hardware.example>`,
    );
    const { committed } = await memberImport(ctx.db, ctx.actor, {
      key: "sender-proof",
      defaultTrade: "other",
      orders: [
        {
          stableOrderId: "sender-proof",
          vendor: { name: storeName },
          source: mailSource(mail),
          extraction: { status: "ready", candidate: candidate("ORDER-ONE") },
        },
      ],
    });
    expect(committed.items[0]?.purchaseId).toBe(existing.shortcode);
    expect(await vendorRows()).toEqual([
      { id: vendor.id, name: vendor.name, aliases: [storeName] },
    ]);
    const sources = await getDb(ctx.db)
      .select({ quote: entitySource.quote })
      .from(entitySource)
      .where(eq(entitySource.entityId, vendor.id));
    expect(sources.map(({ quote }) => quote)).toEqual([
      expect.stringContaining("orders@hardware.example"),
    ]);
  });

  it("finds a Vendor by an exact alias apart from letter case", async () => {
    const { vendor, existing } = await senderVendor();
    await getDb(ctx.db)
      .update(vendorTable)
      .set({ aliases: [storeName] })
      .where(eq(vendorTable.id, vendor.id));
    const { committed } = await memberImport(ctx.db, ctx.actor, {
      key: "alias",
      defaultTrade: "other",
      orders: [
        {
          stableOrderId: "alias",
          vendor: { name: `  ${storeName.toLowerCase()} ` },
          source,
          extraction: { status: "ready", candidate: candidate("ORDER-ONE") },
        },
      ],
    });
    expect(committed.items[0]?.purchaseId).toBe(existing.shortcode);
    expect((await vendorRows()).map(({ id }) => id)).toEqual([vendor.id]);
  });

  it("does not treat a shared sender domain as Sender proof", async () => {
    const { party, vendor } = await senderVendor();
    const mail = await orderMail(party.id, "promotions@hardware.example");
    await memberImport(ctx.db, ctx.actor, {
      key: "shared-domain",
      defaultTrade: "other",
      orders: [
        {
          stableOrderId: "shared-domain",
          vendor: { name: "Synthetic Hardware Outlet" },
          source: mailSource(mail),
          extraction: { status: "ready", candidate: candidate("ORDER-ONE") },
        },
      ],
    });
    const rows = await vendorRows();
    expect(rows).toHaveLength(2);
    expect(rows.find(({ id }) => id === vendor.id)?.aliases).toEqual([]);
  });

  it("refuses to learn a merchant name another Vendor already answers to", async () => {
    const { party, vendor } = await senderVendor();
    const other = await insertWithShortcode(ctx.db, "vendor", {
      name: storeName,
    });
    const mail = await orderMail(party.id, "orders@hardware.example");
    await expect(
      prepareMemberImport(ctx.db, ctx.actor, {
        key: "sender-name-conflict",
        orders: [
          {
            stableOrderId: "sender-name-conflict",
            vendor: { name: storeName },
            source: mailSource(mail),
            extraction: { status: "ready", candidate: candidate("ORDER-ONE") },
          },
        ],
      }),
    ).rejects.toThrow(new RegExp(other.shortcode));
    expect(
      (await vendorRows()).find(({ id }) => id === vendor.id)?.aliases,
    ).toEqual([]);
  });

  it("refuses a merchant name that is an alias of two Vendors", async () => {
    await memberImportWorld(ctx.db, ctx.actor);
    for (const name of ["Synthetic Hardware East", "Synthetic Hardware West"])
      await insertWithShortcode(ctx.db, "vendor", {
        name,
        aliases: [storeName],
      });
    await expect(
      prepareMemberImport(ctx.db, ctx.actor, {
        key: "ambiguous-alias",
        orders: [
          {
            stableOrderId: "ambiguous-alias",
            vendor: { name: storeName },
            source,
            extraction: { status: "ready", candidate: candidate("ORDER-ONE") },
          },
        ],
      }),
    ).rejects.toThrow(/VEN-.*VEN-/);
  });

  async function existingProduct(input: {
    name: string;
    manufacturer: string;
    aliases?: string[];
  }) {
    const created = await createProductFixture(
      ctx.db,
      makeProductInput(input),
      ctx.actor,
    );
    const [row] = await getDb(ctx.db)
      .select({ id: product.id, shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, created.entityId));
    if (!row) throw new Error("Product fixture was not created");
    return row;
  }

  const productOrder = (
    vendorId: MemberImportOrder["vendorId"],
    line: { title: string; sku?: string },
    resolution: NonNullable<MemberImportOrder["resolutions"]>[number],
  ): MemberImportOrder => ({
    stableOrderId: "new-product",
    vendorId,
    source,
    extraction: {
      status: "ready",
      candidate: {
        ...candidate("SYNTHETIC-NEW", 24),
        lines: [{ ...line, amount: 24, quantity: 1, lineKind: "principal" }],
      },
    },
    resolutions: [resolution],
  });

  const liveProductIds = async () =>
    (await getDb(ctx.db).select({ id: product.id }).from(product))
      .map(({ id }) => id)
      .sort();

  it.each([
    { matched: "name", title: "  synthetic COPPER instrument " },
    { matched: "alias", title: "Synthetic brass gauge" },
  ])(
    "refuses an explicit new Product that would fork an exact $matched identity",
    async ({ title }) => {
      const { vendor } = await memberImportWorld(ctx.db, ctx.actor);
      const existing = await existingProduct({
        name: "Synthetic copper instrument",
        manufacturer: "Synthetic works",
        aliases: ["Synthetic brass gauge"],
      });
      const preparation = await prepareMemberImport(ctx.db, ctx.actor, {
        key: "exact-name-fork",
        defaultTrade: "other",
        orders: [productOrder(vendor.shortcode, { title }, { kind: "new" })],
      });
      expect(
        preparation.prepared.orders[0]?.lines[0]?.candidates[0],
      ).toMatchObject({ productId: existing.shortcode, exactNameMatch: true });
      await expect(preparation.commit()).rejects.toThrow(
        new RegExp(existing.shortcode),
      );
      await expectNothingWritten();
      expect(await liveProductIds()).toEqual([existing.id]);
    },
  );

  // A photo title and catalog title can differ while describing the same variant.
  it("requires review of a strong live descriptive candidate before creating a Product", async () => {
    const { vendor } = await memberImportWorld(ctx.db, ctx.actor);
    const existing = await existingProduct({
      name: "Synthetic Works linen camp shirt — Green, M",
      manufacturer: "Synthetic Works",
    });
    const line = {
      title: "Synthetic Works embroidered linen camp shirt — Light green, M",
    };
    const preparation = await prepareMemberImport(ctx.db, ctx.actor, {
      key: "descriptive-fork",
      defaultTrade: "other",
      orders: [productOrder(vendor.shortcode, line, { kind: "new" })],
    });
    expect(preparation.prepared.orders[0]?.lines[0]?.candidates).toContainEqual(
      expect.objectContaining({
        productId: existing.shortcode,
        matchReason: expect.stringContaining("Review"),
      }),
    );
    await expect(preparation.commit()).rejects.toThrow(/distinctFrom/);
    await expectNothingWritten();
    expect(await liveProductIds()).toEqual([existing.id]);
    const reviewed = await memberImport(ctx.db, ctx.actor, {
      key: "descriptive-distinct",
      defaultTrade: "other",
      orders: [
        productOrder(vendor.shortcode, line, {
          kind: "new",
          distinctFrom: [
            {
              productId: parseShortcodeFor("product", existing.shortcode),
              url: "https://example.com/shirt",
              quote:
                "The ordered shirt has embroidery; the existing shirt is plain.",
            },
          ],
        }),
      ],
    });
    expect(reviewed.committed.items[0]?.outcome).toBe("created");
    expect(await liveProductIds()).toHaveLength(2);
  });

  async function identifierOwner() {
    const { vendor } = await memberImportWorld(ctx.db, ctx.actor);
    const owner = await existingProduct({
      name: "Synthetic steel fitting",
      manufacturer: "Synthetic works",
    });
    await withTransaction(ctx.db, async (tx) => {
      await tx.insert(externalSource).values({
        slug: "synthetic-merchant",
        label: "Synthetic merchant catalog",
        vendorId: vendor.id,
      });
      await tx.insert(entityExternalId).values({
        entityId: owner.id,
        entityKind: "product" as const,
        source: "synthetic-merchant",
        kind: "retailer_sku",
        externalId: "SYN-1001",
        isPrimary: true,
      });
    });
    return { vendor, owner };
  }

  it("refuses an explicit new Product whose line identifier another Product owns, even when marked distinct", async () => {
    const { vendor, owner } = await identifierOwner();
    const line = { title: "Synthetic fitting, relisted", sku: "SYN-1001" };
    const resolutions: Array<
      [string, NonNullable<MemberImportOrder["resolutions"]>[number]]
    > = [
      ["identifier-fork", { kind: "new" }],
      [
        "identifier-fork-distinct",
        {
          kind: "new" as const,
          distinctFrom: [
            {
              productId: parseShortcodeFor("product", owner.shortcode),
              url: "https://example.com/listing/fitting",
              quote: "Relisted under a new title.",
            },
          ],
        },
      ],
    ];
    for (const [key, resolution] of resolutions) {
      const preparation = await prepareMemberImport(ctx.db, ctx.actor, {
        key,
        defaultTrade: "other",
        orders: [productOrder(vendor.shortcode, line, resolution)],
      });
      await expect(preparation.commit()).rejects.toThrow(
        new RegExp(`${owner.shortcode}.*SYN-1001|SYN-1001.*${owner.shortcode}`),
      );
      await expectNothingWritten();
      expect(await liveProductIds()).toEqual([owner.id]);
    }
  });

  it("refuses an explicit new Product whose SKU is a barcode another Product owns", async () => {
    const { vendor } = await memberImportWorld(ctx.db, ctx.actor);
    const owner = await existingProduct({
      name: "Synthetic labeled fitting",
      manufacturer: "Synthetic works",
    });
    await withTransaction(ctx.db, async (tx) => {
      await ensureExternalSources(tx, ["gtin"]);
      await tx.insert(entityExternalId).values({
        entityId: owner.id,
        entityKind: "product" as const,
        source: "gtin",
        kind: "gtin_14",
        externalId: "00012345678905",
        isPrimary: true,
      });
    });
    const preparation = await prepareMemberImport(ctx.db, ctx.actor, {
      key: "barcode-fork",
      defaultTrade: "other",
      orders: [
        productOrder(
          vendor.shortcode,
          { title: "Fitting from a receipt", sku: "012345678905" },
          { kind: "new" },
        ),
      ],
    });
    expect(
      preparation.prepared.orders[0]?.lines[0]?.candidates[0],
    ).toMatchObject({ productId: owner.shortcode, exactIdentifierMatch: true });
    await expect(preparation.commit()).rejects.toThrow(
      new RegExp(owner.shortcode),
    );
    await expectNothingWritten();
  });

  it("creates one Product for two new lines with the same title in one order", async () => {
    const { vendor } = await memberImportWorld(ctx.db, ctx.actor);
    const order = productOrder(
      vendor.shortcode,
      { title: "Synthetic hose clamp" },
      { kind: "new" },
    );
    const lines = order.extraction.candidate!.lines;
    const { committed } = await memberImport(ctx.db, ctx.actor, {
      key: "same-title",
      defaultTrade: "other",
      orders: [
        {
          ...order,
          extraction: {
            status: "ready",
            candidate: {
              ...order.extraction.candidate!,
              printedGrandTotal: 48,
              lines: [...lines, ...lines],
            },
          },
          resolutions: [{ kind: "new" }, { kind: "new" }],
        },
      ],
    });
    expect(committed.items[0]?.purchaseId).toBeTruthy();
    expect(await liveProductIds()).toHaveLength(1);
  });

  it("creates a Product beside an exact name match only with a sourced distinct-from decision", async () => {
    const { vendor } = await memberImportWorld(ctx.db, ctx.actor);
    const existing = await existingProduct({
      name: "Synthetic copper instrument",
      manufacturer: "Synthetic works",
    });
    const quote = "Sold as a two-pack; the single unit is a separate listing.";
    const { committed } = await memberImport(ctx.db, ctx.actor, {
      key: "distinct-from",
      defaultTrade: "other",
      orders: [
        productOrder(
          vendor.shortcode,
          { title: "Synthetic Copper Instrument" },
          {
            kind: "new",
            distinctFrom: [
              {
                productId: parseShortcodeFor("product", existing.shortcode),
                url: "https://example.com/listing/two-pack",
                quote,
              },
            ],
          },
        ),
      ],
    });
    expect(committed.items[0]?.purchaseId).toBeTruthy();
    const created = (await liveProductIds()).filter((id) => id !== existing.id);
    expect(created).toHaveLength(1);
    const sources = await getDb(ctx.db)
      .select({ url: entitySource.url, quote: entitySource.quote })
      .from(entitySource)
      .where(eq(entitySource.entityId, created[0]!));
    expect(sources).toContainEqual({
      url: "https://example.com/listing/two-pack",
      quote,
    });
  });

  it("refuses a distinct Product that would reuse the identical name instead of failing on the name index", async () => {
    const { vendor } = await memberImportWorld(ctx.db, ctx.actor);
    const existing = await existingProduct({
      name: "Synthetic copper instrument",
      manufacturer: "",
    });
    const preparation = await prepareMemberImport(ctx.db, ctx.actor, {
      key: "identical-name",
      defaultTrade: "other",
      orders: [
        productOrder(
          vendor.shortcode,
          { title: "Synthetic copper instrument" },
          {
            kind: "new",
            distinctFrom: [
              {
                productId: parseShortcodeFor("product", existing.shortcode),
                url: "https://example.com/listing/variant",
                quote: "A different variant sold under the same title.",
              },
            ],
          },
        ),
      ],
    });
    await expect(preparation.commit()).rejects.toThrow(
      new RegExp(`identical name.*${existing.shortcode}`),
    );
    await expectNothingWritten();
  });
});

describe("purchase import learned product identifiers", () => {
  const ctx = withTestDb();

  it("keeps one primary and learns later retailer identifiers as secondaries", async () => {
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Example imported product" }),
      ctx.actor,
    );

    await withTransaction(ctx.db, async (tx) => {
      await learnPurchaseProductExternalId(tx, {
        productId: product.entityId,
        source: "example-vendor",
        kind: "retailer_sku",
        externalId: "SKU-ONE",
      });
      await learnPurchaseProductExternalId(tx, {
        productId: product.entityId,
        source: "example-vendor",
        kind: "retailer_sku",
        externalId: "SKU-TWO",
      });
    });

    const rows = await getDb(ctx.db)
      .select({
        externalId: entityExternalId.externalId,
        isPrimary: entityExternalId.isPrimary,
      })
      .from(entityExternalId)
      .where(
        and(
          eq(entityExternalId.entityId, product.entityId),
          eq(entityExternalId.source, "example-vendor"),
          eq(entityExternalId.kind, "retailer_sku"),
          notDeleted(entityExternalId),
        ),
      )
      .orderBy(entityExternalId.externalId);

    expect(rows).toEqual([
      { externalId: "SKU-ONE", isPrimary: true },
      { externalId: "SKU-TWO", isPrimary: false },
    ]);
  });

  it("replays an exact identifier and refuses a different product owner", async () => {
    const first = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "First product" }),
      ctx.actor,
    );
    const second = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Second product" }),
      ctx.actor,
    );

    await withTransaction(ctx.db, (tx) =>
      learnPurchaseProductExternalId(tx, {
        productId: first.entityId,
        source: "example-vendor",
        kind: "retailer_sku",
        externalId: "SHARED-SKU",
      }),
    );

    await expect(
      withTransaction(ctx.db, (tx) =>
        learnPurchaseProductExternalId(tx, {
          productId: first.entityId,
          source: "example-vendor",
          kind: "retailer_sku",
          externalId: "SHARED-SKU",
        }),
      ),
    ).resolves.toBeDefined();

    await expect(
      withTransaction(ctx.db, (tx) =>
        learnPurchaseProductExternalId(tx, {
          productId: second.entityId,
          source: "example-vendor",
          kind: "retailer_sku",
          externalId: "SHARED-SKU",
        }),
      ),
    ).rejects.toBeInstanceOf(PurchaseProductExternalIdCollisionError);
  });
});
