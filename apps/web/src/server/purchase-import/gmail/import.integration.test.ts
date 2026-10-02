import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  ledgerParty,
  orderMail,
  orderMailEvent,
  purchase,
  expense,
  inventoryEntry as inventory,
  run as runTable,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { commitPurchaseImport, preparePurchaseImport } from "../import-orders";
import { claimNextImportWork, finishRun, controlRun } from "../run-service";
import { loadOrderMailImportEvidence, startOrderMailImport } from "./import";

// A confirmation must import without a browser, retain immutable member-owned
// evidence on retries, and refuse stale, shipping-only, or foreign-member mail.
describe("saved confirmation imports", () => {
  const ctx = withTestDb();

  const seed = async (
    eventKind: "placed" | "shipped" = "placed",
    owned = true,
  ) => {
    const existingParty = owned
      ? await getDb(ctx.db).query.ledgerParty.findFirst({
          where: eq(ledgerParty.userId, ctx.actor.userId),
        })
      : null;
    const party =
      existingParty ??
      (await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Synthetic confirmation member",
        kind: "member",
        userId: owned ? ctx.actor.userId : null,
      }));
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Example Seed Shop ${crypto.randomUUID()}`,
    });
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: party.id,
        vendorId: vendor.id,
        messageId: `synthetic-confirmation-${crypto.randomUUID()}`,
        sender: "orders@seed.example.test",
        subject: "Order confirmation",
        receivedAt: new Date("2026-09-01T12:00:00Z"),
        rawChecksum: "a".repeat(64),
        content: {
          snippet: null,
          bodyHtml: null,
          bodyText:
            "Order EXAMPLE-123. One herb packet, SKU HERB-1, quantity 1, $5.00. Shipping $0.00. Grand Total $5.00 USD.",
        },
      })
      .returning();
    if (!mail) throw new Error("Missing synthetic mail");
    const [event] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: mail.id,
        event: eventKind,
        orderId: "EXAMPLE-123",
        amount: 5,
        currency: "USD",
        sourceKey: `synthetic:${mail.id}`,
      })
      .returning();
    if (!event) throw new Error("Missing synthetic event");
    return { mail, event };
  };

  it("starts and replays one browser-independent Flue run with frozen mail evidence", async () => {
    const { mail, event } = await seed();
    const input = { eventId: event.id, evidenceChecksum: mail.rawChecksum };
    const sent: PurchaseAgentEvent[] = [];
    const queue = {
      send: async (value: PurchaseAgentEvent) => {
        sent.push(value);
      },
    };
    const first = await startOrderMailImport(ctx.db, input, ctx.actor, queue);
    const again = await startOrderMailImport(ctx.db, input, ctx.actor, queue);
    expect(again.runId).toBe(first.runId);
    expect(sent).toHaveLength(1);
    const [run] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.shortcode, first.runId));
    if (!run) throw new Error("Missing confirmation run");
    expect(run.vendorAccountId).toBeNull();
    expect(run.purpose).toBe("account_sync");
    expect(await loadOrderMailImportEvidence(ctx.db, run.id)).toMatchObject({
      orderId: "EXAMPLE-123",
      evidenceChecksum: mail.rawChecksum,
      source: { kind: "mail_message", checksum: mail.rawChecksum },
    });
    await getDb(ctx.db)
      .update(orderMail)
      .set({ rawChecksum: "b".repeat(64) })
      .where(eq(orderMail.id, mail.id));
    await expect(loadOrderMailImportEvidence(ctx.db, run.id)).rejects.toThrow(
      /changed/i,
    );
  });

  it("refuses shipping notices, stale evidence, and mail owned by another member", async () => {
    const queue = { send: async () => {} };
    const shipped = await seed("shipped");
    await expect(
      startOrderMailImport(
        ctx.db,
        {
          eventId: shipped.event.id,
          evidenceChecksum: shipped.mail.rawChecksum,
        },
        ctx.actor,
        queue,
      ),
    ).rejects.toThrow(/confirmation/i);
    const placed = await seed();
    await expect(
      startOrderMailImport(
        ctx.db,
        { eventId: placed.event.id, evidenceChecksum: "b".repeat(64) },
        ctx.actor,
        queue,
      ),
    ).rejects.toThrow(/changed/i);
    const foreign = await seed("placed", false);
    await expect(
      startOrderMailImport(
        ctx.db,
        {
          eventId: foreign.event.id,
          evidenceChecksum: foreign.mail.rawChecksum,
        },
        ctx.actor,
        queue,
      ),
    ).rejects.toThrow(/member|found/i);
  });

  it("claims the saved email without Chrome and refuses finish or unrelated preparation before commit", async () => {
    const { mail, event } = await seed();
    const result = await startOrderMailImport(
      ctx.db,
      { eventId: event.id, evidenceChecksum: mail.rawChecksum },
      ctx.actor,
      { send: async () => {} },
    );
    const [run] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.shortcode, result.runId));
    if (!run) throw new Error("Missing confirmation run");
    const namespace = {
      getByName: () => {
        throw new Error("A mail import must not contact Chrome");
      },
    };
    expect(await claimNextImportWork(ctx.db, namespace, run.id)).toMatchObject({
      kind: "mail_evidence",
      orderId: "EXAMPLE-123",
    });
    await expect(
      finishRun(ctx.db, namespace, {
        runId: run.id,
        operationId: "finish-before-commit",
      }),
    ).rejects.toThrow(/confirmation|mail/i);
    await expect(
      preparePurchaseImport(
        ctx.db,
        {
          _runExecution: { runId: run.id, operationId: "foreign-evidence" },
          orders: [
            {
              stableOrderId: "unrelated",
              itemOperationId: "unrelated",
              source: {
                kind: "mail_message",
                externalKey: "foreign-mail",
                checksum: mail.rawChecksum,
              },
              evidenceChecksum: mail.rawChecksum,
              extractionRevision: "mail@1",
              extraction: {
                status: "ready",
                candidate: {
                  orderId: "EXAMPLE-123",
                  orderedAt: null,
                  merchant: "Example Seed Shop",
                  currency: "USD",
                  printedGrandTotal: 5,
                  lines: [
                    { title: "Herb packet", amount: 5, lineKind: "principal" },
                  ],
                  payments: [],
                  allShipmentsDelivered: null,
                },
              },
              lineIds: ["herb"],
              primaryDocumentImageId: null,
              screenshotImageId: null,
            },
          ],
        },
        ctx.actor,
      ),
    ).rejects.toThrow(/assigned|confirmation/i);
  });
  it("commits and replays itemized mail once, preserving totals and leaving inventory alone", async () => {
    const { mail, event } = await seed();
    const result = await startOrderMailImport(
      ctx.db,
      { eventId: event.id, evidenceChecksum: mail.rawChecksum },
      ctx.actor,
      { send: async () => {} },
    );
    const [run] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.shortcode, result.runId));
    if (!run) throw new Error("Missing confirmation run");
    const evidence = await loadOrderMailImportEvidence(ctx.db, run.id);
    if (!evidence) throw new Error("Missing assigned mail");
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic herb packet",
      manufacturer: "Synthetic Seed Shop",
    });
    const orders = [
      {
        stableOrderId: "assigned-mail",
        itemOperationId: "assigned-mail",
        source: evidence.source,
        evidenceChecksum: evidence.evidenceChecksum,
        extractionRevision: "order-mail@1",
        extraction: {
          status: "ready" as const,
          candidate: {
            orderId: evidence.orderId,
            orderedAt: "2026-09-01T12:00:00Z",
            merchant: "Example Seed Shop",
            currency: "USD",
            printedGrandTotal: 5,
            lines: [
              {
                title: "Synthetic herb packet",
                amount: 5,
                quantity: 1,
                sku: "HERB-1",
                lineKind: "principal" as const,
              },
            ],
            payments: [],
            allShipmentsDelivered: null,
          },
        },
        lineIds: ["herb"],
        primaryDocumentImageId: null,
        screenshotImageId: null,
      },
    ];
    await preparePurchaseImport(
      ctx.db,
      { _runExecution: { runId: run.id, operationId: "prepare-mail" }, orders },
      ctx.actor,
    );
    const input = {
      _runExecution: { runId: run.id, operationId: "commit-mail" },
      prepareOperationId: "prepare-mail",
      defaultTrade: "other" as const,
      resolutions: [
        {
          stableOrderId: "assigned-mail",
          stableLineId: "herb",
          resolution: {
            kind: "existing" as const,
            productId: product.shortcode,
          },
        },
      ],
    };
    const committed = await commitPurchaseImport(ctx.db, input, ctx.actor);
    expect(await commitPurchaseImport(ctx.db, input, ctx.actor)).toEqual(
      committed,
    );
    expect(committed.items[0]?.outcome).toBe("created");
    const namespace = {
      getByName: () => {
        throw new Error("Mail must not contact Chrome");
      },
    };
    const purchases = await getDb(ctx.db)
      .select()
      .from(purchase)
      .where(eq(purchase.orderId, evidence.orderId));
    expect(purchases).toHaveLength(1);
    expect(purchases[0]?.statedTotal).toBe(5);
    if (!purchases[0]) throw new Error("Missing imported Purchase");
    // Committed mail must still expose its Purchase for settlement checks,
    // including a new run whose source was already imported by its predecessor.
    const verification = {
      kind: "settlement_verification",
      purchaseId: purchases[0].shortcode,
      orderId: evidence.orderId,
    };
    expect(await claimNextImportWork(ctx.db, namespace, run.id)).toEqual(
      verification,
    );
    await finishRun(ctx.db, namespace, {
      runId: run.id,
      operationId: "finish-mail",
    });
    const successor = await controlRun(ctx.db, ctx.actor, {
      runPublicId: run.shortcode,
      action: "restart",
    });
    if (!successor.successorRunId) throw new Error("Missing replay run");
    const [replayRun] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, successor.successorRunId));
    if (!replayRun) throw new Error("Missing replay run record");
    expect(await claimNextImportWork(ctx.db, namespace, replayRun.id)).toEqual(
      verification,
    );
    const lines = await getDb(ctx.db)
      .select()
      .from(expense)
      .where(eq(expense.purchaseId, purchases[0].id));
    expect(lines).toMatchObject([
      { cost: 5, productId: product.id, productQuantity: 1 },
    ]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(inventory)
        .where(eq(inventory.productId, product.id)),
    ).toHaveLength(0);
  });

  it("copies the frozen confirmation when retrying a review run", async () => {
    const { mail, event } = await seed();
    const result = await startOrderMailImport(
      ctx.db,
      { eventId: event.id, evidenceChecksum: mail.rawChecksum },
      ctx.actor,
      { send: async () => {} },
    );
    const [run] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.shortcode, result.runId));
    if (!run) throw new Error("Missing confirmation run");
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "needs_review", endedAt: new Date() })
      .where(eq(runTable.id, run.id));
    const successor = await controlRun(ctx.db, ctx.actor, {
      runPublicId: result.runId,
      action: "retry",
    });
    if (!successor.successorRunId) throw new Error("Missing successor");
    expect(
      await loadOrderMailImportEvidence(ctx.db, successor.successorRunId),
    ).toMatchObject({
      orderId: "EXAMPLE-123",
      evidenceChecksum: mail.rawChecksum,
    });
  });
});
