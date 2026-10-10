import { userId } from "@cubby/schemas/identifiers";
import type { ExtractedOrderCandidate } from "@cubby/schemas/purchase-import";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  expense,
  importPreparedOrder,
  importSourceClaim,
  importSourceOrder,
  mailboxMessage,
  orderMail,
  orderMailCandidateDecision,
  orderMailEvent,
  product,
  purchase,
  runFinding,
  user,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { commitPurchaseImport } from "./import-orders";
import { admitMailImport } from "./mail-import-run";
import {
  mailSource,
  memberImport,
  retainedMailFixture,
  type MemberImportOrder,
} from "./order-import.fixtures";

// A consolidated message must expose each order separately. Raw source keys,
// Emails another Run admitted, and newer raw bytes must not change scope.
describe("retained mail source associations", () => {
  const ctx = withTestDb();

  async function retainMail(
    ledgerPartyId: typeof orderMail.$inferInsert.ledgerPartyId,
    messageId: string,
    checksum: string,
  ) {
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId,
        mailboxId: "synthetic-mailbox",
        messageId,
        sender: "receipts@example.test",
        subject: "Several workshop orders",
        receivedAt: new Date("2026-09-01T18:00:00Z"),
        rawChecksum: checksum,
        content: {
          snippet: null,
          bodyText: "Two workshop orders",
          bodyHtml: null,
        },
      })
      .returning();
    if (!mail) throw new Error("Synthetic retained mail did not persist");
    return mail;
  }

  it("authorizes several orders from retained mail without accepting an unassigned source or altered bytes", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Source association member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Source association vendor",
    });
    const purchases = [
      await insertWithShortcode(ctx.db, "purchase", {
        vendorId: vendor.id,
        orderId: "EXAMPLE-201",
        date: "2026-09-01",
      }),
      await insertWithShortcode(ctx.db, "purchase", {
        vendorId: vendor.id,
        orderId: "EXAMPLE-202",
        date: "2026-09-02",
      }),
    ];
    const mail = await retainMail(party.id, "consolidated", "c".repeat(64));
    const other = await retainMail(party.id, "other", "e".repeat(64));
    const admitted = await admitMailImport(ctx.db, {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      messageIds: [mail.id],
    });
    await admitMailImport(ctx.db, {
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
      messageIds: [other.id],
    });
    const runId = admitted[0]?.row.id;
    if (!runId) throw new Error("Synthetic Mail import was not admitted");
    const { preparePurchaseImport } = await import("./import-orders");
    const orders = purchases.map((purchase, index) => ({
      stableOrderId: `source-order-${index}`,
      itemOperationId: `prepare-item-${index}`,
      vendorId: vendor.shortcode,
      source: {
        kind: "mail_message" as const,
        externalKey: `gmail:${mail.mailboxId}:${mail.messageId}`,
        checksum: mail.rawChecksum,
      },
      evidenceChecksum: mail.rawChecksum,
      extractionRevision: "synthetic-v1",
      extraction: {
        status: "ready" as const,
        candidate: {
          orderId: purchase.orderId,
          orderedAt: "2026-09-01T18:00:00Z",
          merchant: "Source association vendor",
          currency: "USD",
          printedGrandTotal: null,
          lines: [],
          payments: [],
          allShipmentsDelivered: false,
        },
      },
      lineIds: [],
      primaryDocumentImageId: null,
      screenshotImageId: null,
    }));
    for (const [source, refusal] of [
      [
        {
          ...orders[0]!.source,
          externalKey: "gmail:synthetic-mailbox:unassigned",
        },
        "retained Email unchanged",
      ],
      [
        { ...orders[0]!.source, checksum: "d".repeat(64) },
        "retained Email unchanged",
      ],
      [
        {
          kind: "mail_message" as const,
          externalKey: `gmail:${other.mailboxId}:${other.messageId}`,
          checksum: other.rawChecksum,
        },
        "did not admit that Email",
      ],
    ] as const) {
      await expect(
        preparePurchaseImport(
          ctx.db,
          {
            _runExecution: { runId, operationId: "prepare:unauthorized" },
            orders: [
              { ...orders[0]!, source, evidenceChecksum: source.checksum },
            ],
          },
          ctx.actor,
        ),
      ).rejects.toThrow(refusal);
    }
    const prepared = await preparePurchaseImport(
      ctx.db,
      {
        _runExecution: { runId, operationId: "prepare:consolidated" },
        orders,
      },
      ctx.actor,
    );
    expect(prepared.orders).toHaveLength(2);
  });

  const workshop = (
    orderId: string,
    amount: number,
    title = "Workshop admission",
  ): ExtractedOrderCandidate => ({
    orderId,
    orderedAt: "2026-09-01T18:00:00Z",
    merchant: "Source association vendor",
    currency: "USD",
    printedGrandTotal: amount,
    lines: [{ title, amount, lineKind: "principal" }],
    payments: [],
    allShipmentsDelivered: false,
  });

  async function member() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Source association member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Source association vendor",
    });
    return { party, vendor };
  }

  it("retains two orders from one source and replays both without duplicate Expenses", async () => {
    const { vendor } = await member();
    const source = {
      kind: "receipt_photo" as const,
      externalKey: "synthetic:consolidated",
      checksum: "c".repeat(64),
    };
    const orders: MemberImportOrder[] = [
      ["EXAMPLE-101", 24, "Workshop admission"] as const,
      ["EXAMPLE-102", 18, "Second workshop"] as const,
    ].map(([orderId, amount, title]) => ({
      stableOrderId: orderId.toLowerCase(),
      vendorId: vendor.shortcode,
      source,
      extraction: {
        status: "ready",
        candidate: workshop(orderId, amount, title),
      },
    }));
    const first = await memberImport(ctx.db, ctx.actor, {
      key: "consolidated",
      orders,
      defaultTrade: "other",
    });
    // Commit items follow storage order, not preparation order.
    const byOrder = (items: typeof first.committed.items) =>
      Object.fromEntries(items.map((item) => [item.stableOrderId, item]));
    const written = byOrder(first.committed.items);
    expect(written["example-101"]?.purchaseId).not.toBe(
      written["example-102"]?.purchaseId,
    );
    // A later member import of the unchanged source replays each order.
    const again = await memberImport(ctx.db, ctx.actor, {
      key: "consolidated-again",
      orders,
      defaultTrade: "other",
    });
    expect(byOrder(again.committed.items)).toMatchObject({
      "example-101": {
        outcome: "replayed",
        purchaseId: written["example-101"]?.purchaseId,
      },
      "example-102": {
        outcome: "replayed",
        purchaseId: written["example-102"]?.purchaseId,
      },
    });
    const rows = await getDb(ctx.db)
      .select({ orderId: purchase.orderId })
      .from(purchase)
      .where(eq(purchase.vendorId, vendor.id));
    expect(rows.map((row) => row.orderId).sort()).toEqual([
      "EXAMPLE-101",
      "EXAMPLE-102",
    ]);
    const costs = await getDb(ctx.db)
      .select({ cost: expense.cost })
      .from(expense);
    expect(costs.map(({ cost }) => cost).sort()).toEqual([18, 24]);
    expect(await getDb(ctx.db).select().from(importSourceOrder)).toHaveLength(
      2,
    );
  });

  it("excludes another member's prepared extraction sharing a source key and checksum", async () => {
    const { vendor } = await member();
    const source = {
      kind: "receipt_photo" as const,
      externalKey: "synthetic-shared-source-key",
      checksum: "e".repeat(64),
    };
    const owned = workshop("EXAMPLE-OWNED", 24, "Small blue device");
    const otherUserId = userId.parse("synthetic-other-source-user");
    await getDb(ctx.db).insert(user).values({
      id: otherUserId,
      name: "Other synthetic owner",
      email: "other-source@example.test",
    });
    const other = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Other synthetic source owner",
      kind: "member",
      userId: otherUserId,
    });
    const foreignRun = await insertWithShortcode(ctx.db, "run", {
      purpose: "file_import",
      trigger: "manual",
      status: "running",
      ledgerPartyId: other.id,
      actorUserId: otherUserId,
      actorName: "Other synthetic owner",
      actorEmail: "other-source@example.test",
      actorLedgerPartyShortcode: other.shortcode,
      actorLedgerPartyName: other.name,
      actorLedgerPartyKind: "member",
    });
    await getDb(ctx.db)
      .insert(importPreparedOrder)
      .values({
        runId: foreignRun.id,
        vendorId: vendor.id,
        prepareOperationId: "synthetic-foreign-preparation",
        itemOperationId: "synthetic-foreign-order",
        stableOrderId: "EXAMPLE-OWNED",
        sourceKind: source.kind,
        sourceExternalKey: source.externalKey,
        sourceChecksum: source.checksum,
        evidenceChecksum: source.checksum,
        extractionRevision: "synthetic-v1",
        extraction: {
          status: "ready",
          candidate: workshop(
            "EXAMPLE-OWNED",
            24,
            "Different large red device",
          ),
        },
        targetFingerprint: "f".repeat(64),
        evidenceFingerprint: "f".repeat(64),
      });
    // Another member's preparation is not this member's to commit.
    await expect(
      commitPurchaseImport(
        ctx.db,
        {
          _runExecution: {
            run: foreignRun.shortcode,
            operationId: "commit:foreign",
          },
          prepareOperationId: "synthetic-foreign-preparation",
          defaultTrade: "other",
          resolutions: [],
        },
        ctx.actor,
      ),
    ).rejects.toThrow(/not owned by this member/);
    await memberImport(ctx.db, ctx.actor, {
      key: "owned-source",
      orders: [
        {
          stableOrderId: "EXAMPLE-OWNED",
          vendorId: vendor.shortcode,
          source,
          extraction: { status: "ready", candidate: owned },
        },
      ],
      defaultTrade: "other",
    });
    expect(
      await getDb(ctx.db).select({ name: expense.name }).from(expense),
    ).toEqual([{ name: "Small blue device" }]);
  });

  it("imports two service orders from one original once, with totals, source lineage, and no fabricated Product or receiving finding", async () => {
    const { party, vendor } = await member();
    const mail = await retainedMailFixture(ctx.db, {
      ledgerPartyId: party.id,
      messageId: "two-services",
      checksum: "a".repeat(64),
    });
    const { committed, commitInput } = await memberImport(ctx.db, ctx.actor, {
      key: "two-services",
      orders: ["ORDER-ONE", "ORDER-TWO"].map((orderId, index) => ({
        stableOrderId: orderId.toLowerCase(),
        vendorId: vendor.shortcode,
        source: mailSource(mail),
        extraction: {
          status: "ready" as const,
          candidate: workshop(
            orderId,
            10 + index * 10,
            "Synthetic annual service",
          ),
        },
      })),
      defaultTrade: "other",
    });
    expect(committed.items).toHaveLength(2);
    expect(await commitPurchaseImport(ctx.db, commitInput, ctx.actor)).toEqual(
      committed,
    );
    const costs = await getDb(ctx.db)
      .select({ cost: expense.cost })
      .from(expense);
    expect(costs.reduce((sum, { cost }) => sum + (cost ?? Number.NaN), 0)).toBe(
      30,
    );
    expect(await getDb(ctx.db).select().from(product)).toEqual([]);
    expect(await getDb(ctx.db).select().from(importSourceClaim)).toHaveLength(
      1,
    );
    expect(await getDb(ctx.db).select().from(importSourceOrder)).toHaveLength(
      2,
    );
    expect(await getDb(ctx.db).select().from(orderMailEvent)).toHaveLength(2);
    expect(
      await getDb(ctx.db).select().from(orderMailCandidateDecision),
    ).toHaveLength(2);
    expect(
      (await getDb(ctx.db).select().from(runFinding)).filter(
        (finding) => finding.kind === "arrived",
      ),
    ).toEqual([]);
    expect((await getDb(ctx.db).select().from(mailboxMessage))[0]?.status).toBe(
      "completed",
    );
    // The member's import Run ended with its commit.
    await expect(
      commitPurchaseImport(
        ctx.db,
        {
          ...commitInput,
          _runExecution: {
            ...commitInput._runExecution,
            operationId: "commit:two-services-late",
          },
        },
        ctx.actor,
      ),
    ).rejects.toThrow(/fenced/);
  });
});
