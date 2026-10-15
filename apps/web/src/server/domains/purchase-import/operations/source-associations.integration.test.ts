import { userId } from "@cubby/schemas/identifiers";
import {
  commitPurchaseImportInput,
  type ExtractedOrderCandidate,
} from "@cubby/schemas/purchase-import";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import type { DecisionPort } from "~/server/ai/decision-model";
import { getDb } from "~/server/db/helpers";
import {
  expense,
  importPreparedOrder,
  importPreparedLine,
  importSourceClaim,
  importSourceOrder,
  email as emailTable,
  orderMail,
  assessmentEmailLink as orderMailCandidateDecision,
  orderMailEvent,
  product,
  purchase,
  runFinding,
  user,
} from "~/server/db/schema";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { admitMailImport } from "../repo/mail-import-run";
import { commitPurchaseImport, preparePurchaseImport } from "./import-orders";
import {
  mailSource,
  memberImport,
  retainedMailFixture,
  type MemberImportOrder,
  memberImportWorld,
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
    const mail = await retainedMailFixture(ctx.db, {
      ledgerPartyId,
      mailboxId: "synthetic-mailbox",
      messageId,
      sender: "receipts@example.test",
      subject: "Several workshop orders",
      receivedAt: new Date("2026-09-01T18:00:00Z"),
      checksum: checksum,
      content: {
        snippet: null,
        bodyText: "Two workshop orders",
        bodyHtml: null,
      },
    });
    if (!mail) throw new Error("Synthetic retained mail did not persist");
    return mail;
  }

  it("authorizes several orders from retained mail without accepting an unassigned source or altered bytes", async () => {
    const { party, vendor } = await memberImportWorld(ctx.db, ctx.actor, {
      vendor: {
        name: "Source association vendor",
      },
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
      // A non-mail kind must not sidestep the admitted-Email check.
      [
        {
          kind: "vendor_export" as const,
          externalKey: "synthetic:unadmitted-export",
          checksum: "f".repeat(64),
        },
        "imports only the Emails it admitted",
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

  const member = () =>
    memberImportWorld(ctx.db, ctx.actor, {
      vendor: { name: "Source association vendor" },
    });

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

  it.each([
    { uncertainRole: "none", total: 14 },
    { uncertainRole: "c3", total: 14 },
    { uncertainRole: "c3", total: null },
  ])(
    "prepares pending receipt roles once, retains source extraction, and publishes the product roster (%s)",
    async ({ uncertainRole, total }) => {
      const { vendor } = await member();
      const source = {
        kind: "receipt_photo" as const,
        externalKey: "synthetic:receipt-role-prepare",
        checksum: "b".repeat(64),
      };
      const rolePort: DecisionPort = vi.fn<DecisionPort>(async (input) => {
        const evidence = JSON.parse(input.state) as { name: string };
        const selected =
          evidence.name === "Workshop item" ? "c0" : uncertainRole;
        const criteria = Object.keys(input.questions.selection.criteria);
        const confidence = 0.99;
        const residual = (1 - confidence) / (criteria.length - 1);
        return {
          answers: {
            selection: {
              type: "choice" as const,
              choice: selected,
              confidence,
              probabilities: Object.fromEntries(
                criteria.map((choice) => [
                  choice,
                  choice === selected ? confidence : residual,
                ]),
              ),
            },
          },
        };
      });
      const sourceExtraction = {
        status: "ready" as const,
        candidate: {
          orderId: "EXAMPLE-ROLE-1",
          orderedAt: "2026-09-01T18:00:00Z",
          merchant: "Source association vendor",
          currency: "USD",
          printedGrandTotal: total,
          lines: [
            {
              title: "Workshop item",
              amount: 10,
              lineKind: "unclassified" as const,
            },
            {
              title: "Unclear row",
              amount: 3,
              lineKind: "unclassified" as const,
            },
            { title: "Delivery", amount: 1, lineKind: "shipping" as const },
          ],
          payments: [],
          allShipmentsDelivered: false,
        },
      };
      const prepared = await preparePurchaseImport(
        ctx.db,
        {
          _runExecution: { operationId: "prepare:role-classification" },
          orders: [
            {
              stableOrderId: "role-classification-order",
              itemOperationId: "role-classification-item",
              vendorId: vendor.shortcode,
              source,
              evidenceChecksum: source.checksum,
              extractionRevision: "synthetic-v1",
              extraction: sourceExtraction,
              lineIds: ["line-principal", "line-uncertain", "line-source"],
              primaryDocumentImageId: null,
              screenshotImageId: null,
            },
          ],
        },
        ctx.actor,
        rolePort,
      );
      expect(
        prepared.orders[0]?.lines.map((line) => line.requiresProductResolution),
      ).toEqual([true, false, false]);
      expect(rolePort).toHaveBeenCalledTimes(2);
      const storedOrder = await getDb(ctx.db)
        .select({
          id: importPreparedOrder.id,
          extraction: importPreparedOrder.extraction,
        })
        .from(importPreparedOrder)
        .where(
          eq(importPreparedOrder.stableOrderId, "role-classification-order"),
        );
      expect(storedOrder[0]?.extraction).toEqual(sourceExtraction);
      const storedLines = await getDb(ctx.db)
        .select({
          position: importPreparedLine.position,
          line: importPreparedLine.line,
        })
        .from(importPreparedLine)
        .where(eq(importPreparedLine.preparedOrderId, storedOrder[0]!.id))
        .orderBy(importPreparedLine.position);
      expect(
        storedLines.map(({ line }) => (line as { lineKind: string }).lineKind),
      ).toEqual(["principal", "unclassified", "shipping"]);

      const committed = await commitPurchaseImport(
        ctx.db,
        commitPurchaseImportInput.parse({
          _runExecution: {
            run: prepared.runId,
            operationId: "commit:role-classification",
          },
          prepareOperationId: "prepare:role-classification",
          resolutions: [
            {
              stableOrderId: "role-classification-order",
              stableLineId: "line-principal",
              resolution: { kind: "expense_only" },
            },
          ],
        }),
        ctx.actor,
      );
      expect(committed.items).toHaveLength(1);
      expect(rolePort).toHaveBeenCalledTimes(2);
    },
  );

  it("does not publish a prepared order when the role Decision fails", async () => {
    const { vendor } = await member();
    const source = {
      kind: "receipt_photo" as const,
      externalKey: "synthetic:receipt-role-outage",
      checksum: "a".repeat(64),
    };
    const decisionPort: DecisionPort = vi.fn<DecisionPort>(async () => {
      throw new Error("Synthetic role Decision outage");
    });
    await expect(
      preparePurchaseImport(
        ctx.db,
        {
          _runExecution: { operationId: "prepare:role-outage" },
          orders: [
            {
              stableOrderId: "role-outage-order",
              itemOperationId: "role-outage-item",
              vendorId: vendor.shortcode,
              source,
              evidenceChecksum: source.checksum,
              extractionRevision: "synthetic-v1",
              extraction: {
                status: "ready",
                candidate: {
                  ...workshop("EXAMPLE-ROLE-2", 8),
                  lines: [
                    {
                      title: "Pending role",
                      amount: 8,
                      lineKind: "unclassified",
                    },
                  ],
                },
              },
              lineIds: ["line-1"],
              primaryDocumentImageId: null,
              screenshotImageId: null,
            },
          ],
        },
        ctx.actor,
        decisionPort,
      ),
    ).rejects.toThrow("Synthetic role Decision outage");
    expect(decisionPort).toHaveBeenCalledOnce();
    expect(
      await getDb(ctx.db)
        .select({ id: importPreparedOrder.id })
        .from(importPreparedOrder)
        .where(eq(importPreparedOrder.stableOrderId, "role-outage-order")),
    ).toEqual([]);
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
    expect((await getDb(ctx.db).select().from(emailTable))[0]?.status).toBe(
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
