import { parseEntityId } from "@cubby/schemas/identifiers";
import { testUserId } from "@cubby/schemas/testing";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  runFinding,
  orderMail,
  orderMailEvent,
  user,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { findOrCreateVendor } from "~/server/repo/vendor";

import {
  resolveArrivedFindingsForPurchase,
  resolveRunFinding,
} from "./findings";
import {
  importOrderHistory,
  liveExpenseCents,
  purchasesForOrder,
} from "./order-import.fixtures";

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
        targetType: "purchase",
        targetId: purchaseId,
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
        name: "Line A",
        cost: 10,
        date: "2026-01-01",
        costType: "materials",
        productId: productA.entityId,
        purchaseId: purchase.id,
      }),
      insertWithShortcode(ctx.db, "expense", {
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
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Refund findings member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "ForgeWear",
      website: "https://shop.forgewear.example/orders",
      browserDomains: ["shop.forgewear.example"],
      orderEmailSenders: ["orders@forgewear.example"],
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
    const [mail] = await database
      .insert(orderMail)
      .values({
        ledgerPartyId: fixture.party.id,
        vendorId: fixture.vendor.id,
        messageId: input.messageId,
        sender: "orders@forgewear.example",
        subject: `Your ForgeWear refund for ${input.orderId}`,
        receivedAt: new Date("2026-09-05T12:00:00.000Z"),
        rawChecksum: `raw-${input.messageId}`,
      })
      .returning({ id: orderMail.id });
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
        targetType: "purchase",
        targetId: input.purchaseId,
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
          eq(runFinding.targetId, target.id),
          eq(runFinding.kind, "refund_unbooked"),
        ),
      );
    expect(statuses.map(({ status }) => status)).toEqual([
      "applied",
      "applied",
    ]);
  });
});
