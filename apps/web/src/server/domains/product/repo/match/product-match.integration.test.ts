import {
  type ProductShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import { testUserId } from "@cubby/schemas/testing";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { TEST_USER_ID, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  assessmentState,
  entityAttachment,
  feedback,
  inventoryEntry,
  product as productTable,
} from "~/server/db/schema";
import { readEntityConnections } from "~/server/domains/connection/repo/entity-connections";
import { createInventoryEntry } from "~/server/domains/inventory/repo/crud";
import { createLedgerParty } from "~/server/domains/ledger-party/repo/ledger-party";
import {
  publishProductPair,
  prepareProductPairPublication,
  upsertAgentProductMatch,
  productPairKey,
} from "~/server/domains/product/repo/match/product-match-candidate";
import { listProductMatchRows } from "~/server/domains/product/repo/match/product-match-candidate";
import {
  getProductMatchQueue,
  mergeProductMatch,
  proposeProductMatch,
} from "~/server/domains/product/repo/match/product-match-review";
import { attachPurchaseProducts } from "~/server/domains/purchase/repo/purchase-products";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { createMcpServer } from "~/server/mcp/server";
import { callMcpTool } from "~/server/testing/mcp-test-utils";
import {
  createImageFixture,
  createLocationFixture,
  createProductFixture,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
  insertEntityAttachments,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import { taxonomyShortcode } from "../../../../../../tooling/product-category-fixtures";

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

  it("refuses prepared publication after a new evidence row or Product change", async () => {
    const first = await product("Synthetic fence first"),
      second = await product("Synthetic fence second");
    const input = {
      productIds: [first.entityId, second.entityId] as const,
      source: "agent" as const,
      evidence: "Synthetic proof",
      sourceUrls: [],
    };
    const publish = await prepareProductPairPublication(ctx.db, input);
    await getDb(ctx.db)
      .update(productTable)
      .set({ name: "Synthetic changed evidence" })
      .where(eq(productTable.id, first.entityId));
    await expect(publish(ctx.db)).rejects.toThrow("evidence changed");
    expect(
      (await getProductMatchQueue(ctx.db, { productId: first.id })).items,
    ).toEqual([]);
    const current = await prepareProductPairPublication(ctx.db, input);
    const image = await createImageFixture(ctx.db, "synthetic-evidence-fence");
    await insertEntityAttachments(ctx.db, [
      { entityId: first.entityId, imageId: image.id },
    ]);
    await expect(current(ctx.db)).rejects.toThrow("evidence changed");
    const fresh = await prepareProductPairPublication(ctx.db, input);
    await fresh(ctx.db);
    expect(
      (await getProductMatchQueue(ctx.db, { productId: first.id })).items,
    ).toHaveLength(1);
  });

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
    const owner = await member("Synthetic merge stock owner");
    const photo = await photoProduct("Denim jacket", { owner });
    const bought = await purchasedProduct("Denim jacket, washed", { owner });
    const [photoStock] = await getDb(ctx.db)
      .select()
      .from(inventoryEntry)
      .where(eq(inventoryEntry.productId, photo.entityId));
    if (!photoStock) throw new Error("Synthetic photo stock missing");
    await createInventoryEntry(
      ctx.db,
      {
        productId: bought.entityId,
        locationId: photoStock.locationId,
        amount: { value: 3, unit: "each" },
        ownershipMode: "inherit",
      },
      ctx.actor,
    );
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
    const command = {
      assessmentId: pair.id,
      operationId: "synthetic-merge-command",
      verdict: "correct" as const,
      intent: "apply" as const,
      expectedFingerprint: pair.fingerprint!,
      application: {
        kind: "product_merge" as const,
        keepId: bought.id,
        mergeId: photo.id,
      },
    };
    const applied = await reviewAssessment(ctx.db, kernelCtx(ctx), command);
    const appliedHistory = await getDb(ctx.db)
      .select()
      .from(feedback)
      .where(eq(feedback.assessmentId, pair.id));
    expect(await reviewAssessment(ctx.db, kernelCtx(ctx), command)).toEqual(
      applied,
    );
    await expect(
      reviewAssessment(ctx.db, kernelCtx(ctx), {
        ...command,
        application: {
          ...command.application,
          keepId: photo.id,
          mergeId: bought.id,
        },
      }),
    ).rejects.toThrow(/Immutable Feedback retry/);
    expect(
      await mergeProductMatch(
        { ...base, actorContext: base.actorContext },
        {
          keepId: bought.id,
          mergeId: photo.id,
          assessmentId: pair.id,
          expectedFingerprint: pair.fingerprint!,
        },
      ),
    ).toEqual({ ok: true });
    const receipts = await getDb(ctx.db)
      .select()
      .from(feedback)
      .where(eq(feedback.assessmentId, pair.id));
    expect(receipts).toEqual(appliedHistory);
    expect(receipts.filter((row) => row.receipt !== null)).toHaveLength(2);
    expect(
      receipts.find((row) => row.operationId.startsWith("application:merge:"))
        ?.receipt,
    ).toEqual(
      expect.objectContaining({
        kind: "product_merge",
        auditIds: expect.any(Array),
      }),
    );
    expect(
      receipts.find(
        (row) =>
          row.operationId === `command-application:${command.operationId}`,
      )?.receipt,
    ).toEqual(applied);
    const stock = await getDb(ctx.db)
      .select({
        quantity: inventoryEntry.amountValue,
        mode: inventoryEntry.ownershipMode,
        ownerId: inventoryEntry.ownerLedgerPartyId,
      })
      .from(inventoryEntry)
      .where(eq(inventoryEntry.productId, bought.entityId));
    expect(stock.reduce((total, row) => total + (row.quantity ?? 0), 0)).toBe(
      4,
    );
    expect(stock).toEqual(
      expect.arrayContaining([
        {
          quantity: 1,
          mode: "explicit",
          ownerId: await resolveOrThrow(ctx.db, "ledgerParty", owner),
        },
        { quantity: 3, mode: "inherit", ownerId: null },
      ]),
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

  it("supersedes the earlier proposal when a pair is re-proposed", async () => {
    const [photo, vendor] = await twoProducts();
    await call({
      productIds: [photo.id, vendor.id],
      evidence: "Same drawstring colour",
    });
    await call({
      productIds: [photo.id, vendor.id],
      evidence: "Same drawstring colour and cuff logo",
    });
    const states = await getDb(ctx.db)
      .select({
        active: assessmentState.active,
        status: assessmentState.status,
      })
      .from(assessmentState)
      .where(eq(assessmentState.family, "product_pair"))
      .orderBy(assessmentState.createdAt);
    expect(states).toEqual([
      { active: false, status: "superseded" },
      { active: true, status: "pending" },
    ]);
  });

  // An agent proposal is about the two records, not one snapshot of them: an
  // enrichment write keeps it reviewable, and the merge pins what the member saw.
  it("keeps an agent proposal mergeable through enrichment and a missing stored fingerprint", async () => {
    const [photo, vendor] = await twoProducts();
    const [photoId, vendorId] = await Promise.all(
      [photo.id, vendor.id].map((id) => resolveOrThrow(ctx.db, "product", id)),
    );
    const pair = await upsertAgentProductMatch(ctx.db, {
      productIds: [photoId!, vendorId!],
      evidence: "Synthetic matching cuff logo",
      sourceUrls: [],
    });
    await getDb(ctx.db)
      .update(productTable)
      .set({ aliases: ["Synthetic enriched alias"] })
      .where(eq(productTable.id, vendorId!));
    await getDb(ctx.db)
      .update(assessmentState)
      .set({ fingerprint: null })
      .where(eq(assessmentState.id, pair.id));
    const [row] = await listProductMatchRows(ctx.db, undefined, {
      reviewableOnly: true,
    });
    expect(row).toMatchObject({ id: pair.id, source: "agent" });
    expect(row?.fingerprint).toEqual(expect.any(String));
    expect(row?.fingerprint).not.toBe(pair.fingerprint);
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: pair.id,
      operationId: "synthetic-enriched-merge",
      verdict: "correct",
      intent: "apply",
      expectedFingerprint: pair.fingerprint!,
      application: {
        kind: "product_merge",
        keepId: vendor.id,
        mergeId: photo.id,
      },
    }).then(
      () => expect.fail("A stale fingerprint must not merge"),
      (error: Error) => expect(error.message).toMatch(/fingerprint changed/),
    );
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: pair.id,
      operationId: "synthetic-enriched-merge-current",
      verdict: "correct",
      intent: "apply",
      expectedFingerprint: row!.fingerprint!,
      application: {
        kind: "product_merge",
        keepId: vendor.id,
        mergeId: photo.id,
      },
    });
    expect(
      await getDb(ctx.db).query.product.findFirst({
        where: eq(productTable.id, photoId!),
        columns: { deletedAt: true },
      }),
    ).toMatchObject({ deletedAt: expect.any(Date) });
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

describe("product match review surfaces", () => {
  const ctx = withTestDb();
  const make = (name: string) =>
    createProductFixture(
      ctx.db,
      makeProductInput({ name, model: null }),
      ctx.actor,
    );
  const ordered = async (names: readonly [string, string]) =>
    (await Promise.all(names.map(make))).sort((a, b) =>
      a.entityId < b.entityId ? -1 : 1,
    );
  const publishDetected = (
    pair: readonly { entityId: Awaited<ReturnType<typeof make>>["entityId"] }[],
    input: { evidence: string; actionable: boolean; conflict: boolean },
  ) =>
    publishProductPair(ctx.db, {
      productIds: [pair[0]!.entityId, pair[1]!.entityId],
      source: "detector",
      sourceUrls: [],
      fingerprint: `synthetic-${input.evidence}`,
      ...input,
    });

  // A pair the detector cannot act on, or one with an identity conflict, is
  // still pending review; hiding it left members unable to settle it.
  it("lists conflicting and non-actionable pending pairs in Suggestions with their raw reason", async () => {
    const anchor = await make("Synthetic suggestion anchor");
    const [conflicting, weak, rejected, hidden] = await Promise.all(
      ["conflicting", "weak", "rejected", "hidden"].map((label) =>
        make(`Synthetic ${label} twin`),
      ),
    );
    await publishDetected([anchor, conflicting!], {
      evidence: "Synthetic GTIN 00000000000017 conflicts with 00000000000024",
      actionable: true,
      conflict: true,
    });
    await publishDetected([anchor, weak!], {
      evidence: "Synthetic similar titles only",
      actionable: false,
      conflict: false,
    });
    const wrong = await publishDetected([anchor, rejected!], {
      evidence: "Synthetic rejected pair",
      actionable: true,
      conflict: false,
    });
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: wrong.id,
      operationId: crypto.randomUUID(),
      verdict: "wrong",
      intent: "history",
    });
    await dismissPair(
      ctx.db,
      { productIds: [anchor.id, hidden!.id] },
      kernelCtx(ctx),
    );
    const proposals = await readEntityConnections(ctx.db, {
      entityKind: "product",
      entityId: anchor.id,
    });
    const byOther = new Map(
      proposals.map((proposal) => [
        proposal.source.entityId === anchor.id
          ? proposal.target.entityId
          : proposal.source.entityId,
        proposal,
      ]),
    );
    expect([...byOther.keys()].sort()).toEqual(
      [conflicting!.id, weak!.id].sort(),
    );
    expect(byOther.get(conflicting!.id)).toMatchObject({
      relation: "product-identity",
      integration: { kind: "product-pair-review" },
      review: { family: "product_pair" },
      evidence: {
        contradictions: [
          "Synthetic GTIN 00000000000017 conflicts with 00000000000024",
        ],
      },
    });
    expect(byOther.get(weak!.id)?.evidence).toMatchObject({
      reasons: ["Synthetic similar titles only"],
      contradictions: [],
      unknowns: [expect.stringMatching(/^Not actionable/)],
    });
  });

  it("suggests the better-identified Product as keeper when neither side was purchased", async () => {
    const [sparse, rich] = await ordered([
      "Synthetic keeper lamp A",
      "Synthetic keeper lamp B",
    ]);
    // Row order would keep the lower id; quality must override it.
    await getDb(ctx.db)
      .update(productTable)
      .set({ manufacturer: UNSPECIFIED_MANUFACTURER })
      .where(eq(productTable.id, sparse!.entityId));
    await publishDetected([sparse!, rich!], {
      evidence: "Synthetic keeper quality",
      actionable: true,
      conflict: false,
    });
    const [item] = (await getProductMatchQueue(ctx.db, {})).items;
    expect(item?.keeper.id).toBe(rich!.id);
  });

  it("breaks an equal-quality keeper tie toward the older Product", async () => {
    const [newer, older] = await ordered([
      "Synthetic keeper chair A",
      "Synthetic keeper chair B",
    ]);
    await getDb(ctx.db)
      .update(productTable)
      .set({ createdAt: new Date("2020-01-01T00:00:00.000Z") })
      .where(eq(productTable.id, older!.entityId));
    await publishDetected([newer!, older!], {
      evidence: "Synthetic keeper age",
      actionable: false,
      conflict: false,
    });
    const [item] = (await getProductMatchQueue(ctx.db, {})).items;
    expect(item?.keeper.id).toBe(older!.id);
    expect(item?.actionable).toBe(false);
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
