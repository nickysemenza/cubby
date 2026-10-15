import { parseEntityId } from "@cubby/schemas/identifiers";
import type { ImportWriterInput } from "@cubby/schemas/purchase-import";
import { testUserId } from "@cubby/schemas/testing";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  product as productTable,
  runFinding,
  orderMailEvent,
  user,
} from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/service/ensure-run";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import {
  resolveArrivedFindingsForPurchase,
  resolveRunFinding,
} from "./findings";
import {
  retainedMailFixture,
  memberImportWorld,
} from "./order-import.fixtures";
import {
  importOrderHistory,
  liveExpenseCents,
  purchasesForOrder,
} from "./order-import.fixtures";
import { arrivalAsksToReceive, importVendorOrder } from "./writer";

describe("resolveArrivedFindingsForPurchase", () => {
  const ctx = withTestDb();

  /** Mirrors the "arrived" finding `writer.ts` files once every shipment is delivered. */
  const fileArrivedFinding = async (
    ledgerPartyId: string,
    purchaseId: string,
    fingerprint: string,
  ) => {
    const [row] = await getDb(ctx.db)
      .insert(runFinding)
      .values({
        ledgerPartyId: parseEntityId("ledgerParty", ledgerPartyId),
        entityKind: "purchase",
        entityId: purchaseId,
        kind: "arrived",
        summary:
          "All shipments are marked delivered. Review and receive this purchase.",
        proposedFix: { kind: "receive_purchase", purchaseId },
        evidenceFingerprint: fingerprint,
      })
      .returning({ id: runFinding.id });
    if (!row) throw new Error("test setup: finding not inserted");
    return row.id;
  };

  const readFinding = async (id: string) => {
    const [row] = await getDb(ctx.db)
      .select({
        status: runFinding.status,
        resolvedByUserId: runFinding.resolvedByUserId,
        resolvedAt: runFinding.resolvedAt,
      })
      .from(runFinding)
      .where(eq(runFinding.id, id));
    if (!row) throw new Error(`test assertion: finding ${id} not found`);
    return row;
  };

  it("resolves an arrived finding only once every product line is received, and leaves another member's finding alone", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Findings Test Buyer",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendorId = await findOrCreateVendor(ctx.db, "Findings Test Vendor");
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId,
      date: "2026-01-01",
      displayLabel: "Two-line delivered order",
    });
    const [productA, productB] = await Promise.all([
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Arrived Finding Product A" }),
        ctx.actor,
      ),
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Arrived Finding Product B" }),
        ctx.actor,
      ),
    ]);
    await Promise.all([
      insertWithShortcode(ctx.db, "expense", {
        lineKind: "principal",
        name: "Line A",
        cost: 10,
        date: "2026-01-01",
        costType: "materials",
        productId: productA.entityId,
        purchaseId: purchase.id,
      }),
      insertWithShortcode(ctx.db, "expense", {
        lineKind: "principal",
        name: "Line B",
        cost: 20,
        date: "2026-01-01",
        costType: "materials",
        productId: productB.entityId,
        purchaseId: purchase.id,
      }),
    ]);

    const findingId = await fileArrivedFinding(
      party.id,
      purchase.id,
      "own-finding",
    );

    // Another member's own finding on the same purchase must never be
    // touched by resolving this actor's finding — scoped by ledgerParty
    // ownership, mirroring `resolveRunFinding`.
    const otherUserId = testUserId("findings-other-member");
    await getDb(ctx.db).insert(user).values({
      id: otherUserId,
      name: "Other Household Member",
      email: "other-findings-member@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const otherParty = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Other Findings Member",
      kind: "member",
      userId: otherUserId,
    });
    const otherFindingId = await fileArrivedFinding(
      otherParty.id,
      purchase.id,
      "other-finding",
    );

    // Neither product line is received yet: nothing resolves.
    await expect(
      resolveArrivedFindingsForPurchase(
        ctx.db,
        { purchaseId: purchase.id },
        ctx.actor,
      ),
    ).resolves.toEqual({ resolved: 0 });
    expect((await readFinding(findingId)).status).toBe("open");

    const location = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Findings Test Shelf" }),
      ctx.actor,
    );

    // Receive line A only: the purchase is still partially outstanding, so
    // the finding must stay open.
    await createInventoryFixture(
      ctx.db,
      {
        productId: productA.id,
        locationId: location.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
    await expect(
      resolveArrivedFindingsForPurchase(
        ctx.db,
        { purchaseId: purchase.id },
        ctx.actor,
      ),
    ).resolves.toEqual({ resolved: 0 });
    expect((await readFinding(findingId)).status).toBe("open");

    // Receive line B: every product-bearing line now has inventory, so the
    // finding resolves.
    await createInventoryFixture(
      ctx.db,
      {
        productId: productB.id,
        locationId: location.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
    await expect(
      resolveArrivedFindingsForPurchase(
        ctx.db,
        { purchaseId: purchase.id },
        ctx.actor,
      ),
    ).resolves.toEqual({ resolved: 1 });

    const resolved = await readFinding(findingId);
    expect(resolved.status).toBe("applied");
    expect(resolved.resolvedByUserId).toBe(ctx.actor.userId);
    expect(resolved.resolvedAt).not.toBeNull();

    // The other member's finding on the same purchase was never in scope.
    expect((await readFinding(otherFindingId)).status).toBe("open");
  });

  // An untracked line is never received, so requiring it would leave the
  // finding open forever.
  it("resolves once every stock-tracked or undecided line is received, ignoring untracked lines", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Findings Untracked Buyer",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendorId = await findOrCreateVendor(ctx.db, "Findings Mixed Vendor");
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId,
      date: "2026-01-01",
      displayLabel: "Mixed delivered order",
    });
    const groceries = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Findings synthetic groceries",
      stockTracked: false,
    });
    const [tracked, untracked] = await Promise.all([
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Arrived tracked tool", stockTracked: true }),
        ctx.actor,
      ),
      createProductFixture(
        ctx.db,
        makeProductInput({
          name: "Arrived untracked snack",
          categoryId: groceries.shortcode,
        }),
        ctx.actor,
      ),
    ]);
    for (const [name, product] of [
      ["Tracked line", tracked],
      ["Untracked line", untracked],
    ] as const)
      await insertWithShortcode(ctx.db, "expense", {
        lineKind: "principal",
        name,
        cost: 10,
        date: "2026-01-01",
        costType: "materials",
        productId: product.entityId,
        purchaseId: purchase.id,
      });
    const findingId = await fileArrivedFinding(
      party.id,
      purchase.id,
      "mixed-finding",
    );
    const location = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Findings Mixed Shelf" }),
      ctx.actor,
    );
    await createInventoryFixture(
      ctx.db,
      {
        productId: tracked.id,
        locationId: location.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
    await expect(
      resolveArrivedFindingsForPurchase(
        ctx.db,
        { purchaseId: purchase.id },
        ctx.actor,
      ),
    ).resolves.toEqual({ resolved: 1 });
    expect((await readFinding(findingId)).status).toBe("applied");
  });
  // A member deciding the goods are not tracked after the prompt was filed
  // must not strand it open forever; a Purchase with no Product line at all
  // still never resolves vacuously.
  it("resolves when every product line has become untracked, but not when there is no product line", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Findings Decided Buyer",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendorId = await findOrCreateVendor(
      ctx.db,
      "Findings Decided Vendor",
    );
    const [decided, empty] = await Promise.all(
      ["Later decided order", "Order with no product line"].map(
        (displayLabel) =>
          insertWithShortcode(ctx.db, "purchase", {
            vendorId,
            date: "2026-01-01",
            displayLabel,
          }),
      ),
    );
    const snack = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Arrived later untracked snack" }),
      ctx.actor,
    );
    await insertWithShortcode(ctx.db, "expense", {
      lineKind: "principal",
      name: "Snack line",
      cost: 10,
      date: "2026-01-01",
      costType: "materials",
      productId: snack.entityId,
      purchaseId: decided!.id,
    });
    const decidedFinding = await fileArrivedFinding(
      party.id,
      decided!.id,
      "decided-finding",
    );
    const emptyFinding = await fileArrivedFinding(
      party.id,
      empty!.id,
      "empty-finding",
    );
    await getDb(ctx.db)
      .update(productTable)
      .set({ stockTracked: false })
      .where(eq(productTable.id, snack.entityId));

    for (const [purchaseId, resolved] of [
      [decided!.id, 1],
      [empty!.id, 0],
    ] as const)
      await expect(
        resolveArrivedFindingsForPurchase(ctx.db, { purchaseId }, ctx.actor),
      ).resolves.toEqual({ resolved });
    expect((await readFinding(decidedFinding)).status).toBe("applied");
    expect((await readFinding(emptyFinding)).status).toBe("open");
  });
});

/**
 * Failure modes: a delivered order of only untracked goods still asks to be
 * received; a Product's own `true` inside an untracked category is ignored;
 * an unresolved line (no Product yet) is silently dropped from the prompt.
 */
describe("arrived finding follows stock tracking", () => {
  const ctx = withTestDb();

  type Line = { title: string } & (
    | { product: { id: string } }
    | { unresolved: true }
  );

  async function importDelivered(key: string, lines: Line[]) {
    const { party, vendor } = await memberImportWorld(ctx.db, ctx.actor, {
      vendor: { name: `Synthetic delivered vendor ${key}` },
    });
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "file_import",
      trigger: "manual",
      status: "running",
    });
    const input: ImportWriterInput = {
      runId,
      ledgerPartyId: party.id,
      vendorId: vendor.id,
      vendorAccountId: null,
      defaultTrade: "other",
      source: {
        kind: "receipt_photo",
        externalKey: `synthetic:delivered-${key}`,
        checksum: Buffer.from(key).toString("hex").padEnd(64, "0").slice(0, 64),
      },
      extraction: {
        status: "ready",
        candidate: {
          orderId: `EXAMPLE-DELIVERED-${key}`,
          orderedAt: "2026-09-01T18:00:00Z",
          merchant: vendor.name,
          currency: "USD",
          printedGrandTotal: lines.length * 5,
          lines: lines.map((line) => ({
            title: line.title,
            amount: 5,
            quantity: 1,
            lineKind: "principal" as const,
          })),
          payments: [],
          allShipmentsDelivered: true,
        },
      },
      productResolutions: lines.map((line, lineIndex) =>
        "product" in line
          ? { kind: "existing", lineIndex, productId: line.product.id }
          : {
              kind: "unresolved",
              lineIndex,
              reason: "Two synthetic variants conflict.",
            },
      ),
      primaryDocumentImageId: null,
      screenshotImageId: null,
    };
    const imported = await importVendorOrder(ctx.db, input, ctx.actor.userId);
    if (!imported.purchaseId) throw new Error("Synthetic Purchase missing");
    const findings = await getDb(ctx.db)
      .select({ kind: runFinding.kind })
      .from(runFinding)
      .where(
        and(
          eq(runFinding.entityId, imported.purchaseId),
          eq(runFinding.kind, "arrived"),
        ),
      );
    return findings.length > 0;
  }

  async function world() {
    const untracked = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Synthetic groceries",
      stockTracked: false,
    });
    const untrackedChild = await insertWithShortcode(
      ctx.db,
      "productCategory",
      { name: "Synthetic produce", parentId: untracked.id },
    );
    const tracked = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Synthetic hand tools",
      stockTracked: true,
    });
    const product = (
      name: string,
      categoryId: string,
      stockTracked: boolean | null = null,
    ) =>
      insertWithShortcode(ctx.db, "product", {
        name,
        manufacturer: "Example maker",
        categoryId: parseEntityId("productCategory", categoryId),
        stockTracked,
      });
    return {
      flour: await product("Synthetic flour", untracked.id),
      apples: await product("Synthetic apples", untrackedChild.id),
      chisel: await product("Synthetic chisel", tracked.id),
      grinder: await product("Synthetic grain grinder", untracked.id, true),
    };
  }

  it("files no arrived finding when every line is effectively untracked", async () => {
    const { flour, apples } = await world();
    expect(
      await importDelivered("untracked", [
        { title: "Synthetic flour", product: flour },
        { title: "Synthetic apples", product: apples },
      ]),
    ).toBe(false);
  });

  it("asks to receive when one line is tracked", async () => {
    const { flour, chisel } = await world();
    expect(
      await importDelivered("one-tracked", [
        { title: "Synthetic flour", product: flour },
        { title: "Synthetic chisel", product: chisel },
      ]),
    ).toBe(true);
  });

  it("asks to receive when a line is still unresolved", async () => {
    const { flour } = await world();
    expect(
      await importDelivered("unresolved", [
        { title: "Synthetic flour", product: flour },
        { title: "Synthetic mystery item", unresolved: true },
      ]),
    ).toBe(true);
  });

  // A reviewed aggregate replacement defers creating a promoted line's
  // Product, so the line has no Product yet; applying the replacement later
  // never re-evaluates the prompt, so the pending promotion must ask now.
  it("asks to receive a pending promotion that has no Product yet", async () => {
    const { flour } = await world();
    const vendorId = await findOrCreateVendor(
      ctx.db,
      "Pending promotion vendor",
    );
    const pending = await insertWithShortcode(ctx.db, "purchase", {
      vendorId,
      date: "2026-09-01",
      displayLabel: "Aggregate awaiting replacement",
    });
    const decision = {
      productId: null,
      promote: false,
      variantDoubt: false,
      probability: 1,
      unresolvedReason: null,
      lineKind: "principal" as const,
      kitKind: "single" as const,
      reversalKind: null,
    };
    const asks = (promote: boolean) =>
      getDb(ctx.db).transaction((tx) =>
        arrivalAsksToReceive(tx, {
          purchaseId: pending.id,
          identityDecisions: [
            { ...decision, productId: flour.id },
            { ...decision, promote },
          ],
          productLines: [],
        }),
      );
    expect(await asks(false)).toBe(false);
    expect(await asks(true)).toBe(true);
  });

  it("asks to receive a Product tracked by its own decision inside an untracked category", async () => {
    const { apples, grinder } = await world();
    expect(
      await importDelivered("override", [
        { title: "Synthetic apples", product: apples },
        { title: "Synthetic grain grinder", product: grinder },
      ]),
    ).toBe(true);
  });
});

/**
 * Failure modes: a second refund of the same amount on one order is treated
 * as a replay of the first and dropped; an order-history negative line and a
 * mail refund for the same money are both booked; a later history refresh
 * re-adds refunds that findings already booked.
 */
describe("create_refund findings", () => {
  const ctx = withTestDb();

  async function seed() {
    const { party, vendor } = await memberImportWorld(ctx.db, ctx.actor, {
      vendor: {
        name: "ForgeWear",
        website: "https://shop.forgewear.example/orders",
        browserDomains: ["shop.forgewear.example"],
        orderEmailSenders: ["orders@forgewear.example"],
      },
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "ForgeWear refunds account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    return { party, vendor, account };
  }

  /** Mirrors the mail, event, and finding `gmail/process.ts` files for a refund mail. */
  async function fileRefundMail(
    fixture: Awaited<ReturnType<typeof seed>>,
    input: { purchaseId: string; orderId: string; messageId: string },
  ) {
    const database = getDb(ctx.db);
    const mail = await retainedMailFixture(ctx.db, {
      ledgerPartyId: fixture.party.id,
      vendorId: fixture.vendor.id,
      mailboxId: "synthetic-refund-mailbox",
      messageId: input.messageId,
      sender: "orders@forgewear.example",
      subject: `Your ForgeWear refund for ${input.orderId}`,
      receivedAt: new Date("2026-09-05T12:00:00.000Z"),
      checksum: `raw-${input.messageId}`,
    });
    if (!mail) throw new Error("test setup: order mail not inserted");
    const sourceKey = `classified:raw-${input.messageId}`;
    await database.insert(orderMailEvent).values({
      orderMailId: mail.id,
      event: "refunded",
      orderId: input.orderId,
      amount: 10,
      currency: "USD",
      occurredAt: new Date("2026-09-05T12:00:00.000Z"),
      sourceKey,
    });
    const [finding] = await database
      .insert(runFinding)
      .values({
        ledgerPartyId: fixture.party.id,
        entityKind: "purchase",
        entityId: input.purchaseId,
        kind: "refund_unbooked",
        summary:
          "Vendor mail reports a refund that is not yet booked in the expense ledger.",
        proposedFix: {
          kind: "create_refund",
          purchaseId: input.purchaseId,
          amount: -10,
          title: `Refund for order ${input.orderId}`,
        },
        evidenceFingerprint: sourceKey,
      })
      .returning({ id: runFinding.id });
    if (!finding) throw new Error("test setup: refund finding not inserted");
    return finding.id;
  }

  const apply = (id: string) =>
    resolveRunFinding(ctx.db, { id, action: "apply" }, ctx.actor);

  it("books two equal partial refunds and a later history refresh does not re-add them", async () => {
    const fixture = await seed();
    const history = {
      ledgerPartyId: fixture.party.id,
      vendorAccountId: fixture.account.id,
      orderId: "FW-SYN-4001",
      orderedAt: "2026-09-01T12:00:00.000Z",
    };
    await importOrderHistory(ctx.db, ctx.actor, {
      ...history,
      lines: [
        { title: "Canvas work apron", amount: 30 },
        { title: "Leather gloves", amount: 20 },
      ],
      revision: "a",
    });
    const [target] = await purchasesForOrder(ctx.db, "FW-SYN-4001");
    if (!target)
      throw new Error("test setup: history import wrote no Purchase");

    const first = await fileRefundMail(fixture, {
      purchaseId: target.id,
      orderId: "FW-SYN-4001",
      messageId: "msg-refund-4001-a",
    });
    const second = await fileRefundMail(fixture, {
      purchaseId: target.id,
      orderId: "FW-SYN-4001",
      messageId: "msg-refund-4001-b",
    });
    await apply(first);
    await apply(second);
    expect(await liveExpenseCents(ctx.db, target.id)).toEqual([
      -1000, -1000, 2000, 3000,
    ]);

    // The order page now lists both refunds; its refresh must not book them again.
    await importOrderHistory(ctx.db, ctx.actor, {
      ...history,
      lines: [
        { title: "Canvas work apron", amount: 30 },
        { title: "Leather gloves", amount: 20 },
        { title: "Refund", amount: -10, lineKind: "other_adjustment" },
        { title: "Refund", amount: -10, lineKind: "other_adjustment" },
      ],
      revision: "b",
    });
    expect(await purchasesForOrder(ctx.db, "FW-SYN-4001")).toHaveLength(1);
    expect(await liveExpenseCents(ctx.db, target.id)).toEqual([
      -1000, -1000, 2000, 3000,
    ]);
  });

  it("treats a history-booked refund as the first of two equal refunds", async () => {
    const fixture = await seed();
    await importOrderHistory(ctx.db, ctx.actor, {
      ledgerPartyId: fixture.party.id,
      vendorAccountId: fixture.account.id,
      orderId: "FW-SYN-4002",
      orderedAt: "2026-09-01T12:00:00.000Z",
      lines: [
        { title: "Canvas work apron", amount: 30 },
        { title: "Leather gloves", amount: 20 },
        { title: "Refund", amount: -10, lineKind: "other_adjustment" },
      ],
      revision: "c",
    });
    const [target] = await purchasesForOrder(ctx.db, "FW-SYN-4002");
    if (!target)
      throw new Error("test setup: history import wrote no Purchase");
    expect(await liveExpenseCents(ctx.db, target.id)).toEqual([
      -1000, 2000, 3000,
    ]);

    // The mail for the refund history already shows adds nothing.
    await apply(
      await fileRefundMail(fixture, {
        purchaseId: target.id,
        orderId: "FW-SYN-4002",
        messageId: "msg-refund-4002-a",
      }),
    );
    expect(await liveExpenseCents(ctx.db, target.id)).toEqual([
      -1000, 2000, 3000,
    ]);

    // A second refund mail of the same amount is new money back.
    await apply(
      await fileRefundMail(fixture, {
        purchaseId: target.id,
        orderId: "FW-SYN-4002",
        messageId: "msg-refund-4002-b",
      }),
    );
    expect(await liveExpenseCents(ctx.db, target.id)).toEqual([
      -1000, -1000, 2000, 3000,
    ]);
    const statuses = await getDb(ctx.db)
      .select({ status: runFinding.status })
      .from(runFinding)
      .where(
        and(
          eq(runFinding.entityId, target.id),
          eq(runFinding.kind, "refund_unbooked"),
        ),
      );
    expect(statuses.map(({ status }) => status)).toEqual([
      "applied",
      "applied",
    ]);
  });
});
