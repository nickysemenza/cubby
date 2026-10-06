import {
  type VendorAccountId,
  vendorAccountShortcode,
} from "@cubby/schemas/identifiers";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  ledgerParty,
  orderMail,
  orderMailCandidateDecision,
  importSourceClaim,
  orderMailEvent,
  product,
  purchase,
  expense,
  inventoryEntry as inventory,
  runFinding,
  run as runTable,
  runOrderCandidate,
  runTarget,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { getRunLiveProgress } from "~/server/repo/run-progress";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { sweepPendingEnrichment } from "../enrichment-sweep";
import { commitPurchaseImport, preparePurchaseImport } from "../import-orders";
import {
  claimNextImportWork,
  controlRun,
  deferOrderForReview,
  finishRun,
  loadRunDetail,
  startTargetedRun,
} from "../run-service";
import { startTargetedImport } from "../targeted-run";
import { autoImportOrderMail, AUTO_IMPORTS_PER_VENDOR } from "./auto-import";
import {
  loadOrderMailImportEvidence,
  startOrderMailImport,
  startSelectedOrderMailImport,
} from "./import";

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

  it("starts and replays one browser-independent agent run with frozen mail evidence", async () => {
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
    // Restart copies the Vendor and the assigned confirmation, so the panel
    // that claims to show exactly what it copies must show both, by public id.
    const { restartInputs } = await loadRunDetail(ctx.db, first.runId);
    expect(restartInputs).toMatchObject({
      vendor: expect.stringMatching(/^VEN-/),
      input: { kind: "order_mail_import", orderIds: ["EXAMPLE-123"] },
    });
    expect(JSON.stringify(restartInputs)).not.toContain(event.id);
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
    // The Purchase belongs to the member's mail-only account, which stays
    // mail-only; the run itself never becomes an account (browser) run.
    const [account] = await getDb(ctx.db)
      .select()
      .from(vendorAccount)
      .where(eq(vendorAccount.id, purchases[0].vendorAccountId!));
    expect(account).toMatchObject({
      vendorId: run.vendorId,
      ledgerPartyId: run.ledgerPartyId,
      browserSyncEnabled: false,
      status: "disabled",
    });
    const [after] = await getDb(ctx.db)
      .select({ vendorAccountId: runTable.vendorAccountId })
      .from(runTable)
      .where(eq(runTable.id, run.id));
    expect(after?.vendorAccountId).toBeNull();
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
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "completed", endedAt: new Date() })
      .where(eq(runTable.id, run.id));
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

  // Every order is household spending, but a delivered meal or a ticket is
  // not inventory. Failure modes: an expense-only line mints a Product, or
  // files an unresolved-Product finding that holds the run for review.
  it("books an expense-only line with no Product and nothing to review", async () => {
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
    const evidence = await loadOrderMailImportEvidence(ctx.db, run!.id);
    const productsBefore = await getDb(ctx.db).select().from(product);
    await preparePurchaseImport(
      ctx.db,
      {
        _runExecution: { runId: run!.id, operationId: "prepare-meal" },
        orders: [
          {
            stableOrderId: "assigned-mail",
            itemOperationId: "assigned-mail",
            source: evidence!.source,
            evidenceChecksum: evidence!.evidenceChecksum,
            extractionRevision: "order-mail@1",
            extraction: {
              status: "ready" as const,
              candidate: {
                orderId: evidence!.orderId,
                orderedAt: "2026-09-01T12:00:00Z",
                merchant: "Example Noodle Bar",
                currency: "USD",
                printedGrandTotal: 10,
                // Both lines print the same menu SKU: the expense-only line
                // must not inherit the Product the first line created.
                lines: [
                  {
                    title: "Chili crisp jar",
                    amount: 5,
                    quantity: 1,
                    sku: "MENU-7",
                    lineKind: "principal" as const,
                  },
                  {
                    title: "Spicy basil noodles, large",
                    amount: 5,
                    quantity: 1,
                    sku: "MENU-7",
                    lineKind: "principal" as const,
                  },
                ],
                payments: [],
                allShipmentsDelivered: true,
              },
            },
            lineIds: ["jar", "noodles"],
            primaryDocumentImageId: null,
            screenshotImageId: null,
          },
        ],
      },
      ctx.actor,
    );
    const committed = await commitPurchaseImport(
      ctx.db,
      {
        _runExecution: { runId: run!.id, operationId: "commit-meal" },
        prepareOperationId: "prepare-meal",
        defaultTrade: "other" as const,
        resolutions: [
          {
            stableOrderId: "assigned-mail",
            stableLineId: "jar",
            resolution: { kind: "new" as const },
          },
          {
            stableOrderId: "assigned-mail",
            stableLineId: "noodles",
            resolution: { kind: "expense_only" as const },
          },
        ],
      },
      ctx.actor,
    );
    expect(committed.items[0]?.outcome).toBe("created");
    const lines = await getDb(ctx.db)
      .select({ name: expense.name, productId: expense.productId })
      .from(expense)
      .innerJoin(purchase, eq(purchase.id, expense.purchaseId))
      .where(eq(purchase.orderId, evidence!.orderId));
    expect(lines.find((line) => line.name.startsWith("Spicy"))).toEqual({
      name: "Spicy basil noodles, large",
      productId: null,
    });
    // Only the jar became a Product.
    expect(await getDb(ctx.db).select().from(product)).toHaveLength(
      productsBefore.length + 1,
    );
    // The jar is a stocked item, so the delivered order has something to
    // receive; nothing else asks for review.
    expect(
      await getDb(ctx.db)
        .select({ kind: runFinding.kind })
        .from(runFinding)
        .where(eq(runFinding.runId, run!.id)),
    ).toEqual([{ kind: "arrived" }]);
  });

  it("files no receiving finding for a delivered order with nothing stocked", async () => {
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
    const evidence = await loadOrderMailImportEvidence(ctx.db, run!.id);
    const productsBefore = await getDb(ctx.db).select().from(product);
    await preparePurchaseImport(
      ctx.db,
      {
        _runExecution: { runId: run!.id, operationId: "prepare-meal-only" },
        orders: [
          {
            stableOrderId: "assigned-mail",
            itemOperationId: "assigned-mail",
            source: evidence!.source,
            evidenceChecksum: evidence!.evidenceChecksum,
            extractionRevision: "order-mail@1",
            extraction: {
              status: "ready" as const,
              candidate: {
                orderId: evidence!.orderId,
                orderedAt: "2026-09-01T12:00:00Z",
                merchant: "Example Noodle Bar",
                currency: "USD",
                printedGrandTotal: 4,
                // A discount is never a reversal of a stocked item, so it
                // files no reversal finding either.
                lines: [
                  {
                    title: "Spicy basil noodles, large",
                    amount: 5,
                    quantity: 1,
                    sku: "MENU-7",
                    lineKind: "principal" as const,
                  },
                  {
                    title: "Welcome discount",
                    amount: -1,
                    lineKind: "discount" as const,
                  },
                ],
                payments: [],
                allShipmentsDelivered: true,
              },
            },
            lineIds: ["noodles", "discount"],
            primaryDocumentImageId: null,
            screenshotImageId: null,
          },
        ],
      },
      ctx.actor,
    );
    const committed = await commitPurchaseImport(
      ctx.db,
      {
        _runExecution: { runId: run!.id, operationId: "commit-meal-only" },
        prepareOperationId: "prepare-meal-only",
        defaultTrade: "other" as const,
        resolutions: [
          {
            stableOrderId: "assigned-mail",
            stableLineId: "noodles",
            resolution: { kind: "expense_only" as const },
          },
        ],
      },
      ctx.actor,
    );
    expect(committed.items[0]?.outcome).toBe("created");
    // Nothing stocked arrived, so nothing asks to be received or reviewed.
    expect(await getDb(ctx.db).select().from(product)).toHaveLength(
      productsBefore.length,
    );
    expect(
      await getDb(ctx.db)
        .select({ kind: runFinding.kind })
        .from(runFinding)
        .where(eq(runFinding.runId, run!.id)),
    ).toEqual([]);
  });

  describe("enrichment after a mail import", () => {
    // A new Product from a confirmation should be enriched without a click
    // when the member can browse that Vendor. Failure modes: no follow-up at
    // all; a follow-up on a mail-only account (no browser to use); a child
    // that starts from the Gmail source key instead of the product page.
    const importNewLine = async (
      synced: boolean,
      extraLines: {
        title: string;
        productUrl: string;
        sku?: string;
        amount: number;
      }[] = [],
    ) => {
      const { mail, event } = await seed();
      const productUrl = "https://seed.example.test/products/herb";
      await getDb(ctx.db)
        .update(vendor)
        .set({
          website: "https://seed.example.test",
          browserDomains: ["seed.example.test"],
        })
        .where(eq(vendor.id, mail.vendorId!));
      const account = await insertWithShortcode(ctx.db, "vendorAccount", {
        label: "Synthetic seed account",
        vendorId: mail.vendorId!,
        ledgerPartyId: mail.ledgerPartyId,
        status: synced ? "active" : "disabled",
        browserSyncEnabled: synced,
      });
      const started = await startOrderMailImport(
        ctx.db,
        { eventId: event.id, evidenceChecksum: mail.rawChecksum },
        ctx.actor,
        { send: async () => {} },
      );
      const [run] = await getDb(ctx.db)
        .select()
        .from(runTable)
        .where(eq(runTable.shortcode, started.runId));
      if (!run) throw new Error("Missing confirmation run");
      const evidence = await loadOrderMailImportEvidence(ctx.db, run.id);
      if (!evidence) throw new Error("Missing assigned mail");
      await preparePurchaseImport(
        ctx.db,
        {
          _runExecution: { runId: run.id, operationId: "prepare-new" },
          orders: [
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
                  printedGrandTotal:
                    5 + extraLines.reduce((sum, line) => sum + line.amount, 0),
                  lines: [
                    {
                      title: "Synthetic herb packet",
                      amount: 5,
                      quantity: 1,
                      productUrl,
                      sku: extraLines.length ? "HERB-1" : undefined,
                      lineKind: "principal" as const,
                    },
                    ...extraLines.map((line) => ({
                      ...line,
                      quantity: 1,
                      lineKind: "principal" as const,
                    })),
                  ],
                  payments: [],
                  allShipmentsDelivered: null,
                },
              },
              lineIds: [
                "herb",
                ...extraLines.map((_, index) => `extra${index}`),
              ],
              primaryDocumentImageId: null,
              screenshotImageId: null,
            },
          ],
        },
        ctx.actor,
      );
      await commitPurchaseImport(
        ctx.db,
        {
          _runExecution: { runId: run.id, operationId: "commit-new" },
          prepareOperationId: "prepare-new",
          defaultTrade: "other" as const,
          resolutions: ["herb", ...extraLines.map((_, i) => `extra${i}`)].map(
            (stableLineId) => ({
              stableOrderId: "assigned-mail",
              stableLineId,
              resolution: { kind: "new" as const },
            }),
          ),
        },
        ctx.actor,
      );
      const children = await getDb(ctx.db)
        .select()
        .from(runTable)
        .where(eq(runTable.purpose, "product_enrichment"));
      return { run, account, productUrl, children };
    };

    it("starts one enrichment run at the new Product's page when the account browses", async () => {
      const { run, account, productUrl, children } = await importNewLine(true);
      expect(children).toHaveLength(1);
      const [child] = children;
      expect(child).toMatchObject({
        vendorAccountId: account.id,
        trigger: "discovery",
        purpose: "product_enrichment",
      });
      expect(run.vendorAccountId).toBeNull();
      const targets = await getDb(ctx.db)
        .select({ startUrl: runTarget.sourceExternalKey })
        .from(runTarget)
        .where(eq(runTarget.runId, child!.id));
      expect(targets).toEqual([{ startUrl: productUrl }]);
    });

    it("targets a Product once when two differently titled lines share its SKU", async () => {
      const { children } = await importNewLine(true, [
        {
          title: "Synthetic herb packet (gift)",
          productUrl: "https://seed.example.test/products/herb",
          sku: "HERB-1",
          amount: 5,
        },
      ]);
      expect(children).toHaveLength(1);
      const targets = await getDb(ctx.db)
        .select({ productId: runTarget.entityId })
        .from(runTarget)
        .where(eq(runTarget.runId, children[0]!.id));
      expect(targets).toHaveLength(1);
    });

    // A member enriching a mail-imported Product from its Purchase: the
    // source claim's key is a Gmail message id, never a page to open.
    it("starts manual enrichment of a mail-imported Product at a web page", async () => {
      const { run } = await importNewLine(false);
      const [claim] = await getDb(ctx.db)
        .select({
          id: importSourceClaim.id,
          purchaseId: importSourceClaim.purchaseId,
        })
        .from(importSourceClaim)
        .where(eq(importSourceClaim.lastRunId, run.id));
      const [line] = await getDb(ctx.db)
        .select({ productId: product.shortcode })
        .from(expense)
        .innerJoin(product, eq(product.id, expense.productId))
        .where(eq(expense.purchaseId, claim!.purchaseId!));
      await startTargetedImport(ctx.db, run.ledgerPartyId!, {
        purpose: "product_enrichment",
        targets: [
          {
            productId: line!.productId,
            sourceId: claim!.id,
            vendorAccountId: null,
          },
        ],
      });
      const targets = await getDb(ctx.db)
        .select({ startUrl: runTarget.sourceExternalKey })
        .from(runTarget)
        .innerJoin(runTable, eq(runTable.id, runTarget.runId))
        .where(eq(runTable.purpose, "product_enrichment"));
      // No SKU, so no learned product URL: the Vendor's own site.
      expect(targets).toEqual([{ startUrl: "https://seed.example.test/" }]);
    });

    // The browser bridge refuses any navigation off the Vendor's browser
    // domains, so a start page must be on one; with none, starting refuses
    // with what to add instead of handing the agent a Gmail key.
    it("refuses manual enrichment when no start page is on the Vendor's browser domains", async () => {
      const { run } = await importNewLine(false);
      const [claim] = await getDb(ctx.db)
        .select({
          id: importSourceClaim.id,
          purchaseId: importSourceClaim.purchaseId,
        })
        .from(importSourceClaim)
        .where(eq(importSourceClaim.lastRunId, run.id));
      const [line] = await getDb(ctx.db)
        .select({ productId: product.shortcode })
        .from(expense)
        .innerJoin(product, eq(product.id, expense.productId))
        .where(eq(expense.purchaseId, claim!.purchaseId!));
      const start = () =>
        startTargetedImport(ctx.db, run.ledgerPartyId!, {
          purpose: "product_enrichment",
          targets: [
            {
              productId: line!.productId,
              sourceId: claim!.id,
              vendorAccountId: null,
            },
          ],
        });
      for (const website of ["https://www.other-host.example.test", null]) {
        await getDb(ctx.db)
          .update(vendor)
          .set({ website })
          .where(eq(vendor.id, run.vendorId!));
        await expect(start()).rejects.toThrow(/browser domains/u);
      }
    });

    it("starts nothing for a mail-only account", async () => {
      const { children } = await importNewLine(false);
      expect(children).toEqual([]);
    });

    // A Product left unenriched by the one-shot start must be picked up by a
    // later pass. Failure modes: no later pass at all; a mail-only account
    // that turns browser sync on is never revisited; a Purchase imported
    // before mail Purchases were linked to an account is invisible; an
    // occupied account or an offline Mac drops the work instead of waiting;
    // a failed run is never retried, or retried forever; a Product already
    // enriched or skipped is swept again; the start page is lost.
    describe("enrichment sweep", () => {
      const online = { connected: async () => true };
      const enrichmentTargets = () =>
        getDb(ctx.db)
          .select({
            runId: runTarget.runId,
            productId: runTarget.entityId,
            startUrl: runTarget.sourceExternalKey,
            vendorAccountId: runTable.vendorAccountId,
          })
          .from(runTarget)
          .innerJoin(runTable, eq(runTable.id, runTarget.runId))
          .where(eq(runTable.purpose, "product_enrichment"));
      const enableBrowserSync = (accountId: VendorAccountId) =>
        getDb(ctx.db)
          .update(vendorAccount)
          .set({ status: "active", browserSyncEnabled: true })
          .where(eq(vendorAccount.id, accountId));
      const mailOnlyImport = async () => {
        const imported = await importNewLine(false);
        const [line] = await getDb(ctx.db)
          .select({
            productId: expense.productId,
            purchaseId: expense.purchaseId,
            url: expense.url,
            accountId: purchase.vendorAccountId,
          })
          .from(expense)
          .innerJoin(purchase, eq(purchase.id, expense.purchaseId))
          .where(eq(purchase.vendorId, imported.run.vendorId!));
        if (!line?.accountId) throw new Error("Missing mail account link");
        return { ...imported, line, accountId: line.accountId };
      };

      it("keeps each line's product page on its Expense", async () => {
        const { line, productUrl } = await mailOnlyImport();
        expect(line.url).toBe(productUrl);
      });

      it("enriches a mail-only account's Products once browser sync turns on", async () => {
        const { accountId, line, productUrl } = await mailOnlyImport();
        expect(
          await sweepPendingEnrichment(ctx.db, { bridge: online }),
        ).toEqual({ started: [], waiting: [] });
        await enableBrowserSync(accountId);
        const swept = await sweepPendingEnrichment(ctx.db, { bridge: online });
        expect(swept.started).toHaveLength(1);
        expect(await enrichmentTargets()).toEqual([
          {
            runId: expect.any(String),
            productId: line.productId,
            startUrl: productUrl,
            vendorAccountId: accountId,
          },
        ]);
      });

      // The member's own switch is the trigger: no discovery pass needed.
      it("starts enrichment when the member turns browser sync on in the account editor", async () => {
        const { accountId, line } = await mailOnlyImport();
        const { entityKernelContextSchema, executeEntity } =
          await import("~/server/entity-kernel");
        const { requireActor } = await import("~/server/request-context");
        const { createTestRequestContext } =
          await import("~/server/testing/request-context");
        const kernel = entityKernelContextSchema.parse(
          requireActor(
            createTestRequestContext(ctx.db, {
              auth: { userId: ctx.actor.userId },
            }),
          ),
        );
        const [account] = await getDb(ctx.db)
          .select({ shortcode: vendorAccount.shortcode })
          .from(vendorAccount)
          .where(eq(vendorAccount.id, accountId));
        await executeEntity(kernel, {
          action: "update",
          entity: "vendorAccount",
          id: vendorAccountShortcode.parse(account!.shortcode),
          data: { status: "active", browserSyncEnabled: true },
        });
        expect(await enrichmentTargets()).toMatchObject([
          { productId: line.productId, vendorAccountId: accountId },
        ]);
      });

      // A mail claim names no account; a run without one cannot browse.
      it("starts a member's manual enrichment on the vendor's browsing account", async () => {
        const { accountId, run, line } = await mailOnlyImport();
        await enableBrowserSync(accountId);
        const [claim] = await getDb(ctx.db)
          .select({ id: importSourceClaim.id })
          .from(importSourceClaim)
          .where(eq(importSourceClaim.lastRunId, run.id));
        // As imported before mail Purchases were linked to an account.
        await getDb(ctx.db)
          .update(importSourceClaim)
          .set({ vendorAccountId: null })
          .where(eq(importSourceClaim.id, claim!.id));
        await getDb(ctx.db)
          .update(purchase)
          .set({ vendorAccountId: null })
          .where(eq(purchase.id, line.purchaseId!));
        const [code] = await getDb(ctx.db)
          .select({ shortcode: product.shortcode })
          .from(product)
          .where(eq(product.id, line.productId!));
        await startTargetedImport(ctx.db, run.ledgerPartyId!, {
          purpose: "product_enrichment",
          targets: [
            {
              productId: code!.shortcode,
              sourceId: claim!.id,
              vendorAccountId: null,
            },
          ],
        });
        expect(await enrichmentTargets()).toMatchObject([
          { productId: line.productId, vendorAccountId: accountId },
        ]);
      });

      it("finds the vendor's browsing account for a Purchase with no account link", async () => {
        const { accountId, line } = await mailOnlyImport();
        await enableBrowserSync(accountId);
        await getDb(ctx.db)
          .update(purchase)
          .set({ vendorAccountId: null })
          .where(eq(purchase.id, line.purchaseId!));
        await sweepPendingEnrichment(ctx.db, { bridge: online });
        expect(await enrichmentTargets()).toMatchObject([
          { productId: line.productId, vendorAccountId: accountId },
        ]);
      });

      it("waits while the account is occupied or its Mac is offline, then starts", async () => {
        const { accountId, run, line } = await mailOnlyImport();
        await enableBrowserSync(accountId);
        const busy = await startTargetedRun(ctx.db, {
          ledgerPartyId: run.ledgerPartyId!,
          purpose: "purchase_validation",
          vendorId: run.vendorId!,
          vendorAccountId: accountId,
          trigger: "manual",
          targets: [
            {
              kind: "purchase",
              purchaseId: line.purchaseId!,
              targetFingerprint: "b".repeat(64),
            },
          ],
        });
        if (!busy.created) throw new Error("Expected an occupying run");
        expect(
          await sweepPendingEnrichment(ctx.db, { bridge: online }),
        ).toEqual({
          started: [],
          waiting: [{ vendorAccountId: accountId, reason: "occupied" }],
        });
        await getDb(ctx.db)
          .update(runTable)
          .set({ status: "completed", endedAt: new Date() })
          .where(eq(runTable.id, busy.run.id));
        const offline = { connected: async () => false };
        expect(
          await sweepPendingEnrichment(ctx.db, { bridge: offline }),
        ).toEqual({
          started: [],
          waiting: [{ vendorAccountId: accountId, reason: "offline" }],
        });
        expect(
          (await sweepPendingEnrichment(ctx.db, { bridge: online })).started,
        ).toHaveLength(1);
      });

      it("retries a failed run at most three times", async () => {
        const { accountId } = await mailOnlyImport();
        await enableBrowserSync(accountId);
        for (let attempt = 0; attempt < 3; attempt++) {
          const { started } = await sweepPendingEnrichment(ctx.db, {
            bridge: online,
          });
          expect(started).toHaveLength(1);
          await getDb(ctx.db)
            .update(runTable)
            .set({ status: "failed", failureCode: "offline_expired" })
            .where(eq(runTable.id, started[0]!.runId));
        }
        expect(
          (await sweepPendingEnrichment(ctx.db, { bridge: online })).started,
        ).toEqual([]);
      });

      it("never re-sweeps a Product a run skipped", async () => {
        const second = await mailOnlyImport();
        await enableBrowserSync(second.accountId);
        const { started } = await sweepPendingEnrichment(ctx.db, {
          bridge: online,
        });
        expect(started).toHaveLength(1);
        await getDb(ctx.db)
          .update(runTarget)
          .set({ state: "skipped", outcome: "skipped" })
          .where(eq(runTarget.runId, started[0]!.runId));
        await getDb(ctx.db)
          .update(runTable)
          .set({ status: "completed" })
          .where(eq(runTable.id, started[0]!.runId));
        expect(
          (await sweepPendingEnrichment(ctx.db, { bridge: online })).started,
        ).toEqual([]);
      });
    });
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

  // A member selects several saved confirmations of one Vendor and gets one
  // run whose per-order outcomes are RunOrderCandidate rows.
  describe("selected confirmations", () => {
    const seedPair = async () => {
      const first = await seed();
      const [secondMail] = await getDb(ctx.db)
        .insert(orderMail)
        .values({
          ledgerPartyId: first.mail.ledgerPartyId,
          vendorId: first.mail.vendorId,
          messageId: `synthetic-confirmation-${crypto.randomUUID()}`,
          sender: "orders@seed.example.test",
          subject: "Order confirmation",
          receivedAt: new Date("2026-09-02T12:00:00Z"),
          rawChecksum: "c".repeat(64),
          content: {
            snippet: null,
            bodyHtml: null,
            bodyText:
              "Order EXAMPLE-456. One trowel, SKU TOOL-1, quantity 1, $9.00. Grand Total $9.00 USD.",
          },
        })
        .returning();
      if (!secondMail) throw new Error("Missing second synthetic mail");
      const [secondEvent] = await getDb(ctx.db)
        .insert(orderMailEvent)
        .values({
          orderMailId: secondMail.id,
          event: "placed",
          orderId: "EXAMPLE-456",
          amount: 9,
          currency: "USD",
          sourceKey: `synthetic:${secondMail.id}`,
        })
        .returning();
      if (!secondEvent) throw new Error("Missing second synthetic event");
      const orders = [
        { eventId: first.event.id, evidenceChecksum: first.mail.rawChecksum },
        {
          eventId: secondEvent.id,
          evidenceChecksum: secondMail.rawChecksum,
        },
      ] as const;
      return {
        first,
        second: { mail: secondMail, event: secondEvent },
        orders,
        selection: { orders: [...orders] },
      };
    };
    const candidateStates = async (runId: string) =>
      Object.fromEntries(
        (
          await getDb(ctx.db)
            .select()
            .from(runOrderCandidate)
            .where(eq(runOrderCandidate.runId, runId))
        ).map((row) => [row.orderId, row.state]),
      );
    const noChrome = {
      getByName: () => {
        throw new Error("A mail import must not contact Chrome");
      },
    };
    const mailOrder = (
      evidence: NonNullable<
        Awaited<ReturnType<typeof loadOrderMailImportEvidence>>
      >,
    ) => ({
      stableOrderId: `mail:${evidence.eventId}`,
      itemOperationId: `mail:${evidence.eventId}`,
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
              title: "Synthetic selected item",
              amount: 5,
              quantity: 1,
              lineKind: "principal" as const,
            },
          ],
          payments: [],
          allShipmentsDelivered: null,
        },
      },
      lineIds: ["item"],
      primaryDocumentImageId: null,
      screenshotImageId: null,
    });
    const prepareAndCommit = async (
      runId: string,
      evidence: NonNullable<
        Awaited<ReturnType<typeof loadOrderMailImportEvidence>>
      >,
      tag: string,
    ) => {
      const product = await insertWithShortcode(ctx.db, "product", {
        name: `Synthetic selected item ${tag}`,
        manufacturer: "Synthetic Seed Shop",
      });
      await preparePurchaseImport(
        ctx.db,
        {
          _runExecution: { runId, operationId: `prepare-${tag}` },
          orders: [mailOrder(evidence)],
        },
        ctx.actor,
      );
      return commitPurchaseImport(
        ctx.db,
        {
          _runExecution: { runId, operationId: `commit-${tag}` },
          prepareOperationId: `prepare-${tag}`,
          defaultTrade: "other" as const,
          resolutions: [
            {
              stableOrderId: `mail:${evidence.eventId}`,
              stableLineId: "item",
              resolution: {
                kind: "existing" as const,
                productId: product.shortcode,
              },
            },
          ],
        },
        ctx.actor,
      );
    };

    it("dates each selected order by the household day its mail arrived", async () => {
      const { first, selection } = await seedPair();
      // 03:00Z on Sep 1 is the evening of Aug 31 in the household.
      await getDb(ctx.db)
        .update(orderMail)
        .set({ receivedAt: new Date("2026-09-01T03:00:00Z") })
        .where(eq(orderMail.id, first.mail.id));
      const started = await startSelectedOrderMailImport(
        ctx.db,
        selection,
        ctx.actor,
        { send: async () => {} },
      );
      const [run] = await getDb(ctx.db)
        .select()
        .from(runTable)
        .where(eq(runTable.shortcode, started.runId));
      if (!run) throw new Error("Missing selected run");
      const rows = await getDb(ctx.db)
        .select()
        .from(runOrderCandidate)
        .where(eq(runOrderCandidate.runId, run.id));
      expect(
        Object.fromEntries(rows.map((row) => [row.orderId, row.orderedAt])),
      ).toEqual({ "EXAMPLE-123": "2026-08-31", "EXAMPLE-456": "2026-09-02" });
    });

    it("records each selected order's terminal outcome on one run and carries the deferred one on restart", async () => {
      const { first, second, orders, selection } = await seedPair();
      const sent: PurchaseAgentEvent[] = [];
      const queue = {
        send: async (value: PurchaseAgentEvent) => {
          sent.push(value);
        },
      };
      const started = await startSelectedOrderMailImport(
        ctx.db,
        selection,
        ctx.actor,
        queue,
      );
      expect(sent).toHaveLength(1);
      const [run] = await getDb(ctx.db)
        .select()
        .from(runTable)
        .where(eq(runTable.shortcode, started.runId));
      if (!run) throw new Error("Missing selected run");
      expect(await candidateStates(run.id)).toEqual({
        "EXAMPLE-123": "pending",
        "EXAMPLE-456": "pending",
      });
      // Replaying the identical selection reuses the run.
      expect(
        (
          await startSelectedOrderMailImport(
            ctx.db,
            selection,
            ctx.actor,
            queue,
          )
        ).runId,
      ).toBe(started.runId);
      expect(sent).toHaveLength(1);

      expect(await claimNextImportWork(ctx.db, noChrome, run.id)).toMatchObject(
        { kind: "mail_evidence", orderId: "EXAMPLE-123" },
      );
      const firstEvidence = await loadOrderMailImportEvidence(ctx.db, run.id);
      if (!firstEvidence) throw new Error("Missing claimed mail");
      expect(firstEvidence.eventId).toBe(first.event.id);
      // Preparation stays restricted to the claimed order: the second
      // confirmation cannot be prepared before the first is resolved.
      await expect(
        preparePurchaseImport(
          ctx.db,
          {
            _runExecution: { runId: run.id, operationId: "prepare-early" },
            orders: [
              mailOrder({
                ...firstEvidence,
                eventId: second.event.id,
                orderId: "EXAMPLE-456",
                evidenceChecksum: second.mail.rawChecksum,
                source: {
                  kind: "mail_message",
                  externalKey: `gmail:${second.mail.messageId}:order:EXAMPLE-456`,
                  checksum: second.mail.rawChecksum,
                },
              }),
            ],
          },
          ctx.actor,
        ),
      ).rejects.toThrow(/assigned/i);
      await expect(
        finishRun(ctx.db, noChrome, {
          runId: run.id,
          operationId: "finish-early",
        }),
      ).rejects.toThrow(/confirmation|order/i);

      await prepareAndCommit(run.id, firstEvidence, "first");
      expect(await candidateStates(run.id)).toEqual({
        "EXAMPLE-123": "imported",
        "EXAMPLE-456": "pending",
      });
      expect(await claimNextImportWork(ctx.db, noChrome, run.id)).toMatchObject(
        { kind: "mail_evidence", orderId: "EXAMPLE-456" },
      );
      expect((await loadOrderMailImportEvidence(ctx.db, run.id))?.eventId).toBe(
        second.event.id,
      );

      await deferOrderForReview(ctx.db, {
        runId: run.id,
        operationId: "defer-second",
        orderId: "EXAMPLE-456",
        summary: "The confirmation has no readable itemization.",
      });
      expect(await candidateStates(run.id)).toEqual({
        "EXAMPLE-123": "imported",
        "EXAMPLE-456": "skipped",
      });
      expect(await claimNextImportWork(ctx.db, noChrome, run.id)).toEqual({
        kind: "none",
      });
      // finish_import_run would run the LLM auditor over the committed
      // Purchase (an external seam); the agent scenario covers that finish.
      await getDb(ctx.db)
        .update(runTable)
        .set({ status: "needs_review", endedAt: new Date() })
        .where(eq(runTable.id, run.id));
      // The Run page lists each selected order's recorded outcome.
      expect((await getRunLiveProgress(ctx.db, run.shortcode))?.orders).toEqual(
        [
          { orderId: "EXAMPLE-123", state: "imported" },
          { orderId: "EXAMPLE-456", state: "skipped" },
        ],
      );

      // Already imported: never a second run.
      await expect(
        startSelectedOrderMailImport(
          ctx.db,
          { orders: [orders[0]] },
          ctx.actor,
          queue,
        ),
      ).rejects.toThrow(/already imported/i);

      const successor = await controlRun(ctx.db, ctx.actor, {
        runPublicId: run.shortcode,
        action: "restart",
      });
      if (!successor.successorRunId) throw new Error("Missing successor");
      expect(await candidateStates(successor.successorRunId)).toEqual({
        "EXAMPLE-456": "pending",
      });
      expect(
        await claimNextImportWork(ctx.db, noChrome, successor.successorRunId),
      ).toMatchObject({ kind: "mail_evidence", orderId: "EXAMPLE-456" });
    });

    it("finishes for review once every selected order is deferred, and not before", async () => {
      const { orders, selection } = await seedPair();
      const started = await startSelectedOrderMailImport(
        ctx.db,
        selection,
        ctx.actor,
        { send: async () => {} },
      );
      const [run] = await getDb(ctx.db)
        .select()
        .from(runTable)
        .where(eq(runTable.shortcode, started.runId));
      if (!run) throw new Error("Missing selected run");
      const defer = (orderId: string) =>
        deferOrderForReview(ctx.db, {
          runId: run.id,
          operationId: `defer-${orderId}`,
          orderId,
          summary: "The confirmation has no readable itemization.",
        });
      await defer("EXAMPLE-123");
      expect(await claimNextImportWork(ctx.db, noChrome, run.id)).toMatchObject(
        { kind: "mail_evidence", orderId: "EXAMPLE-456" },
      );
      await expect(
        finishRun(ctx.db, noChrome, {
          runId: run.id,
          operationId: "finish-with-pending",
        }),
      ).rejects.toThrow(/1 listed order/i);
      await defer("EXAMPLE-456");
      const finished = await finishRun(ctx.db, noChrome, {
        runId: run.id,
        operationId: "finish-selected",
      });
      expect(finished.status).toBe("needs_review");
      expect(await candidateStates(run.id)).toEqual({
        "EXAMPLE-123": "skipped",
        "EXAMPLE-456": "skipped",
      });
      // Deferred, not imported: the review run still owns the orders, so a
      // new selection is refused (the member restarts that run instead).
      await expect(
        startSelectedOrderMailImport(
          ctx.db,
          { orders: [orders[0]] },
          ctx.actor,
          { send: async () => {} },
        ),
      ).rejects.toThrow(new RegExp(`already on run ${started.runId}`, "i"));
    });

    it("refuses a selection that is mixed, stale, duplicated, or already on a live run", async () => {
      const queue = { send: async () => {} };
      const { first, second, orders, selection } = await seedPair();
      const other = await seed();
      await expect(
        startSelectedOrderMailImport(
          ctx.db,
          {
            orders: [
              orders[0],
              {
                eventId: other.event.id,
                evidenceChecksum: other.mail.rawChecksum,
              },
            ],
          },
          ctx.actor,
          queue,
        ),
      ).rejects.toThrow(/same Vendor/i);
      await expect(
        startSelectedOrderMailImport(
          ctx.db,
          {
            orders: [
              orders[0],
              { ...orders[1], evidenceChecksum: "d".repeat(64) },
            ],
          },
          ctx.actor,
          queue,
        ),
      ).rejects.toThrow(/changed/i);
      await expect(
        startSelectedOrderMailImport(
          ctx.db,
          { orders: [orders[0], orders[0]] },
          ctx.actor,
          queue,
        ),
      ).rejects.toThrow(/more than once/i);
      expect(
        await getDb(ctx.db)
          .select()
          .from(runTable)
          .where(eq(runTable.vendorId, first.mail.vendorId!)),
      ).toHaveLength(0);

      const started = await startSelectedOrderMailImport(
        ctx.db,
        selection,
        ctx.actor,
        queue,
      );
      // A different selection and the single-order path both see the live run.
      await expect(
        startSelectedOrderMailImport(
          ctx.db,
          { orders: [orders[1]] },
          ctx.actor,
          queue,
        ),
      ).rejects.toThrow(new RegExp(`already on run ${started.runId}`, "i"));
      await expect(
        startOrderMailImport(
          ctx.db,
          {
            eventId: second.event.id,
            evidenceChecksum: second.mail.rawChecksum,
          },
          ctx.actor,
          queue,
        ),
      ).rejects.toThrow(new RegExp(`already on run ${started.runId}`, "i"));
    });
  });

  // A scheduled pass imports a new confirmation without a click. Failure
  // modes: a replayed batch starts a second run; shipping mail, an order
  // already imported, or a member's decision starts one anyway; a backlog of
  // saved placements floods the queue; a confirmation a live run already owns
  // gets a second run.
  describe("automatic import of new confirmations", () => {
    const PASS_START = new Date(0);
    const recordingQueue = () => {
      const sent: PurchaseAgentEvent[] = [];
      return {
        sent,
        send: async (value: PurchaseAgentEvent) => {
          sent.push(value);
        },
      };
    };

    it("starts one discovery run per new confirmation and replays to the same run", async () => {
      const { mail } = await seed();
      const queue = recordingQueue();
      const pass = {
        ledgerPartyId: mail.ledgerPartyId,
        messageIds: [mail.messageId],
        since: PASS_START,
      };
      const first = await autoImportOrderMail(ctx.db, pass, queue);
      const again = await autoImportOrderMail(ctx.db, pass, queue);
      expect(first).toHaveLength(1);
      expect(again).toEqual(first);
      expect(queue.sent).toHaveLength(1);
      const [run] = await getDb(ctx.db)
        .select()
        .from(runTable)
        .where(eq(runTable.vendorId, mail.vendorId!));
      expect(run).toMatchObject({
        trigger: "discovery",
        purpose: "account_sync",
        actorUserId: ctx.actor.userId,
        input: { kind: "order_mail_import", orderId: "EXAMPLE-123" },
      });
    });

    it("leaves shipping mail, imported orders, and decided confirmations alone", async () => {
      const queue = recordingQueue();
      const shipped = await seed("shipped");
      const imported = await seed();
      await insertWithShortcode(ctx.db, "purchase", {
        vendorId: imported.mail.vendorId!,
        orderId: "EXAMPLE-123",
        date: "2026-09-01",
      });
      const decided = await seed();
      const other = await insertWithShortcode(ctx.db, "purchase", {
        vendorId: decided.mail.vendorId!,
        orderId: "OTHER-9",
        date: "2026-09-01",
      });
      await getDb(ctx.db).insert(orderMailCandidateDecision).values({
        eventId: decided.event.id,
        purchaseId: other.id,
        decision: "dismissed",
        evidenceChecksum: decided.mail.rawChecksum,
        decidedByUserId: ctx.actor.userId,
      });
      const started = await autoImportOrderMail(
        ctx.db,
        {
          ledgerPartyId: shipped.mail.ledgerPartyId,
          messageIds: [shipped.mail, imported.mail, decided.mail].map(
            (mail) => mail.messageId,
          ),
          since: PASS_START,
        },
        queue,
      );
      expect(started).toEqual([]);
      expect(queue.sent).toEqual([]);
    });

    it("counts the cap across a pass's batches and its retries", async () => {
      const queue = recordingQueue();
      const { mail: head } = await seed();
      const mails = [head];
      for (let index = 1; index <= AUTO_IMPORTS_PER_VENDOR + 1; index += 1) {
        const [mail] = await getDb(ctx.db)
          .insert(orderMail)
          .values({
            ...head,
            id: undefined,
            messageId: `${head.messageId}-${index}`,
          })
          .returning();
        await getDb(ctx.db)
          .insert(orderMailEvent)
          .values({
            orderMailId: mail!.id,
            event: "placed",
            orderId: `EXAMPLE-${300 + index}`,
            amount: 5,
            currency: "USD",
            sourceKey: `synthetic:${mail!.id}`,
          });
        mails.push(mail!);
      }
      const batch = (from: number, to: number) =>
        autoImportOrderMail(
          ctx.db,
          {
            ledgerPartyId: head.ledgerPartyId,
            messageIds: mails.slice(from, to).map((mail) => mail.messageId),
            since: PASS_START,
          },
          queue,
        );
      const first = await batch(0, 3);
      const second = await batch(3, mails.length);
      // A retried second batch admits nothing the first delivery left capped.
      const retried = await batch(3, mails.length);
      expect(first.length + second.length).toBe(AUTO_IMPORTS_PER_VENDOR);
      expect(retried).toEqual(second);
      expect(queue.sent).toHaveLength(AUTO_IMPORTS_PER_VENDOR);
    });

    it("rethrows a failed dispatch and redispatches the same run on retry", async () => {
      const { mail } = await seed();
      const pass = {
        ledgerPartyId: mail.ledgerPartyId,
        messageIds: [mail.messageId],
        since: PASS_START,
      };
      await expect(
        autoImportOrderMail(ctx.db, pass, {
          send: async () => {
            throw new Error("synthetic queue outage");
          },
        }),
      ).rejects.toThrow(/synthetic queue outage/);
      const queue = recordingQueue();
      const [runId] = await autoImportOrderMail(ctx.db, pass, queue);
      expect(queue.sent).toHaveLength(1);
      expect(
        await getDb(ctx.db)
          .select({ shortcode: runTable.shortcode })
          .from(runTable)
          .where(eq(runTable.vendorId, mail.vendorId!)),
      ).toEqual([{ shortcode: runId }]);
    });

    it("caps one Vendor's imports per pass and skips a confirmation a live run owns", async () => {
      const queue = recordingQueue();
      const { mail: head } = await seed();
      const mails = [head];
      for (let index = 1; index <= AUTO_IMPORTS_PER_VENDOR + 1; index += 1) {
        const [mail] = await getDb(ctx.db)
          .insert(orderMail)
          .values({
            ...head,
            id: undefined,
            messageId: `${head.messageId}-${index}`,
          })
          .returning();
        await getDb(ctx.db)
          .insert(orderMailEvent)
          .values({
            orderMailId: mail!.id,
            event: "placed",
            orderId: `EXAMPLE-${200 + index}`,
            amount: 5,
            currency: "USD",
            sourceKey: `synthetic:${mail!.id}`,
          });
        mails.push(mail!);
      }
      const [owned] = await getDb(ctx.db)
        .select()
        .from(orderMailEvent)
        .where(eq(orderMailEvent.orderMailId, mails[1]!.id));
      await startSelectedOrderMailImport(
        ctx.db,
        {
          orders: [
            { eventId: owned!.id, evidenceChecksum: mails[1]!.rawChecksum },
          ],
        },
        ctx.actor,
        { send: async () => {} },
      );
      const started = await autoImportOrderMail(
        ctx.db,
        {
          ledgerPartyId: head.ledgerPartyId,
          messageIds: mails.map((mail) => mail.messageId),
          since: PASS_START,
        },
        queue,
      );
      expect(started).toHaveLength(AUTO_IMPORTS_PER_VENDOR);
      expect(queue.sent).toHaveLength(AUTO_IMPORTS_PER_VENDOR);
    });
  });
});
