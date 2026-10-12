import {
  parseEntityId,
  parseShortcodeFor,
  type LedgerPartyId,
  type VendorId,
} from "@cubby/schemas/identifiers";
import {
  type ExtractedOrderCandidate,
  commitPurchaseImportInput,
  proposedImportFix,
} from "@cubby/schemas/purchase-import";
import { testShortcode } from "@cubby/schemas/testing";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  auditLog,
  entityAttachment,
  entityExternalId,
  expense,
  externalSource,
  financialTransactionAllocation,
  importSourceClaim,
  importSourceOrder,
  importSourceProduct,
  inventoryEntry,
  email as emailTable,
  orderMail,
  orderMailAttachment,
  orderMailCandidateDecision,
  orderMailEvent,
  product,
  productCategory,
  project,
  purchase,
  purchasePaymentEvidence,
  run,
  runFinding,
  runOperation,
  sourceOrderObservation,
} from "~/server/db/schema";
import { loadDataQualities } from "~/server/repo/data-quality/hydrate";
import { getDb, withTransaction } from "~/server/repo/database-helpers";
import { ensureExternalSources } from "~/server/repo/entity-external-ids";
import { effectiveExpenseTradeSql } from "~/server/repo/expense-inheritance";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { resolveRunFinding } from "./findings";
import { commitPurchaseImport, preparePurchaseImport } from "./import-orders";
import { startImportRunFixture } from "./import-run.fixtures";
import { resolveMail } from "./mail-tool";
import {
  mailSource,
  memberImport,
  memberImportWorld,
  prepareMemberImport,
  retainedMailFixture,
} from "./order-import.fixtures";
import { prepareSourceOrderReconciliation } from "./reconciliation";

const mailboxId = "synthetic-mailbox";
const checksum = (digit: string) => digit.repeat(64);

// Caller-driven import: a member (or Pi) prepares and commits from a retained
// Email through the public writers, Email dispositions are recorded through
// `mail.resolve`, and nothing launches unattended Product research.
describe("caller-driven purchase import", () => {
  const ctx = withTestDb();

  const retainedMail = (
    partyId: LedgerPartyId,
    messageId: string,
    bodyText: string,
    checksumDigit: string,
  ) =>
    retainedMailFixture(ctx.db, {
      ledgerPartyId: partyId,
      messageId,
      bodyText,
      checksum: checksumDigit.repeat(64),
      mailboxId,
    });

  async function importConfirmation() {
    const { party, vendor } = await memberImportWorld(ctx.db, ctx.actor, {
      vendor: {
        name: "Synthetic garden shop",
        website: "https://shop.example",
      },
    });
    const mail = await retainedMail(
      party.id,
      "confirmation-1",
      "Order SYN-100 confirmed: Synthetic trowel $18.50",
      "a",
    );
    const prepareInput = {
      _runExecution: {
        operationId: "prepare:syn-100",
        itemOperationIds: ["prepare-item:syn-100"],
      },
      orders: [
        {
          vendorId: vendor.shortcode,
          stableOrderId: "syn-100",
          itemOperationId: "prepare-item:syn-100",
          source: {
            kind: "mail_message",
            externalKey: `gmail:${mailboxId}:${mail.messageId}`,
            checksum: mail.rawChecksum,
          },
          evidenceChecksum: mail.rawChecksum,
          extractionRevision: "synthetic@1",
          extraction: {
            status: "ready",
            candidate: {
              orderId: "SYN-100",
              orderedAt: "2026-09-20T12:00:00.000Z",
              merchant: "Synthetic garden shop",
              currency: "USD",
              printedGrandTotal: 18.5,
              lines: [
                {
                  title: "Synthetic trowel",
                  amount: 18.5,
                  lineKind: "principal",
                },
              ],
              payments: [],
              allShipmentsDelivered: false,
            },
          },
          lineIds: ["syn-100:line-1"],
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    } satisfies Parameters<typeof preparePurchaseImport>[1];
    const prepared = await preparePurchaseImport(
      ctx.db,
      prepareInput,
      ctx.actor,
    );
    const commitInput = {
      _runExecution: { run: prepared.runId, operationId: "commit:syn-100" },
      prepareOperationId: "prepare:syn-100",
      defaultTrade: "other" as const,
      resolutions: [
        {
          stableOrderId: "syn-100",
          stableLineId: "syn-100:line-1",
          resolution: { kind: "new" as const },
        },
      ],
    };
    const committed = await commitPurchaseImport(
      ctx.db,
      commitInput,
      ctx.actor,
    );
    return {
      party,
      vendor,
      mail,
      prepareInput,
      prepared,
      commitInput,
      committed,
    };
  }

  it("imports a retained Email for a member without a Run and launches no research", async () => {
    const { mail, prepared, commitInput, committed } =
      await importConfirmation();

    const runs = await getDb(ctx.db)
      .select({ shortcode: run.shortcode, purpose: run.purpose })
      .from(run);
    // Absent caller: the member's import is the only Run; no Product research
    // or other follow-on work was launched by the commit.
    expect(runs).toEqual([
      { shortcode: prepared.runId, purpose: "file_import" },
    ]);

    const replay = await commitPurchaseImport(ctx.db, commitInput, ctx.actor);
    expect(replay).toEqual(committed);
    const purchaseId = committed.items[0]?.purchaseId;
    expect(purchaseId).toBeTruthy();

    // A mail-sourced commit records its confirmation link itself.
    const links = await getDb(ctx.db)
      .select({
        event: orderMailEvent.event,
        decision: orderMailCandidateDecision.decision,
        purchaseShortcode: purchase.shortcode,
      })
      .from(orderMailEvent)
      .innerJoin(
        orderMailCandidateDecision,
        eq(orderMailCandidateDecision.eventId, orderMailEvent.id),
      )
      .innerJoin(
        purchase,
        eq(purchase.id, orderMailCandidateDecision.purchaseId),
      )
      .where(eq(orderMailEvent.orderMailId, mail.id));
    expect(links).toEqual([
      {
        event: "confirmation",
        decision: "linked",
        purchaseShortcode: purchaseId,
      },
    ]);
    const [message] = await getDb(ctx.db)
      .select({ status: emailTable.status })
      .from(emailTable)
      .where(eq(emailTable.messageId, mail.messageId));
    expect(message?.status).toBe("completed");
  });

  // A completed prepare replays its recorded result even after its Email was
  // later excluded or resolved, so a caller retrying a lost response recovers.
  it("replays a completed prepare after its Email stops being importable", async () => {
    const { mail, prepareInput, prepared } = await importConfirmation();
    await getDb(ctx.db)
      .update(emailTable)
      .set({ status: "excluded" })
      .where(eq(emailTable.messageId, mail.messageId));

    await expect(
      preparePurchaseImport(ctx.db, prepareInput, ctx.actor),
    ).resolves.toEqual(prepared);
  });

  it("links a shipment Email to an existing Purchase without new Expenses, idempotently", async () => {
    const { party, committed } = await importConfirmation();
    const purchaseId = committed.items[0]!.purchaseId!;
    const shipment = await retainedMail(
      party.id,
      "shipment-1",
      "Order SYN-100 has shipped",
      "c",
    );
    const expensesBefore = await getDb(ctx.db)
      .select({ id: expense.id })
      .from(expense);

    const input = {
      mailboxId,
      messageId: shipment.messageId,
      checksum: shipment.rawChecksum,
      disposition: {
        kind: "linked" as const,
        purchaseIds: [purchaseId],
        event: "shipped" as const,
      },
    };
    const first = await resolveMail(ctx.db, input, ctx.actor);
    const replay = await resolveMail(ctx.db, input, ctx.actor);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      status: "completed",
      purchaseIds: [purchaseId],
    });

    const events = await getDb(ctx.db)
      .select({ event: orderMailEvent.event })
      .from(orderMailEvent)
      .where(eq(orderMailEvent.orderMailId, shipment.id));
    expect(events).toEqual([{ event: "shipped" }]);
    expect(
      await getDb(ctx.db).select({ id: expense.id }).from(expense),
    ).toEqual(expensesBefore);
  });

  // An order with no order id cannot converge by (Vendor, order id); without
  // a target, importing an Email already linked to its Purchase would book
  // that order a second time.
  it("imports a no-order-id Email into the one Purchase it is already linked to", async () => {
    const { party, vendor } = await memberImportWorld(ctx.db, ctx.actor, {
      vendor: { name: "Synthetic seed shop", website: "https://seed.example" },
    });
    const existing = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: parseEntityId("vendor", vendor.id),
      date: "2026-09-20",
      statedTotal: 18.5,
    });
    const mail = await retainedMail(
      party.id,
      "orderless-receipt",
      "Thanks for your order: Synthetic seed packet $18.50",
      "e",
    );
    await resolveMail(
      ctx.db,
      {
        mailboxId,
        messageId: mail.messageId,
        checksum: mail.rawChecksum,
        disposition: {
          kind: "linked",
          purchaseIds: [parseShortcodeFor("purchase", existing.shortcode)],
          event: "confirmation",
        },
      },
      ctx.actor,
    );
    const prepared = await preparePurchaseImport(
      ctx.db,
      {
        _runExecution: {
          operationId: "prepare:orderless",
          itemOperationIds: ["prepare-item:orderless"],
        },
        orders: [
          {
            vendorId: vendor.shortcode,
            stableOrderId: "orderless",
            itemOperationId: "prepare-item:orderless",
            source: {
              kind: "mail_message",
              externalKey: `gmail:${mailboxId}:${mail.messageId}`,
              checksum: mail.rawChecksum,
            },
            evidenceChecksum: mail.rawChecksum,
            extractionRevision: "synthetic@1",
            extraction: {
              status: "ready",
              candidate: {
                orderId: null,
                orderedAt: "2026-09-20",
                merchant: "Synthetic seed shop",
                currency: "USD",
                printedGrandTotal: 18.5,
                lines: [
                  {
                    title: "Synthetic seed packet",
                    amount: 18.5,
                    lineKind: "principal",
                  },
                ],
                payments: [],
                allShipmentsDelivered: false,
              },
            },
            lineIds: ["orderless:line-1"],
            primaryDocumentImageId: null,
            screenshotImageId: null,
          },
        ],
      },
      ctx.actor,
    );
    expect(prepared.orders[0]?.targetPurchaseId).toBe(existing.shortcode);
    await commitPurchaseImport(
      ctx.db,
      {
        _runExecution: { run: prepared.runId, operationId: "commit:orderless" },
        prepareOperationId: "prepare:orderless",
        defaultTrade: "other",
        resolutions: [
          {
            stableOrderId: "orderless",
            stableLineId: "orderless:line-1",
            resolution: { kind: "new" },
          },
        ],
      },
      ctx.actor,
    );
    const booked = await getDb(ctx.db)
      .select({ purchase: purchase.shortcode, cost: expense.cost })
      .from(purchase)
      .leftJoin(expense, eq(expense.purchaseId, purchase.id))
      .where(eq(purchase.vendorId, parseEntityId("vendor", vendor.id)));
    expect(booked).toEqual([{ purchase: existing.shortcode, cost: 18.5 }]);
  });

  it("refuses a changed Email and disposes of an unrelated one", async () => {
    const { party } = await memberImportWorld(ctx.db, ctx.actor, {
      vendor: {
        name: "Synthetic garden shop",
        website: "https://shop.example",
      },
    });
    const newsletter = await retainedMail(
      party.id,
      "newsletter-1",
      "Synthetic newsletter with no purchase",
      "d",
    );
    await expect(
      resolveMail(
        ctx.db,
        {
          mailboxId,
          messageId: newsletter.messageId,
          checksum: "e".repeat(64),
          disposition: { kind: "unrelated", reason: "Marketing only" },
        },
        ctx.actor,
      ),
    ).rejects.toThrow(/changed/i);

    const resolved = await resolveMail(
      ctx.db,
      {
        mailboxId,
        messageId: newsletter.messageId,
        checksum: newsletter.rawChecksum,
        disposition: { kind: "unrelated", reason: "Marketing only" },
      },
      ctx.actor,
    );
    expect(resolved).toMatchObject({ status: "completed", purchaseIds: [] });
    // Content disposal preserves the original's identity and checksum.
    const [cleared] = await getDb(ctx.db)
      .select()
      .from(orderMail)
      .where(eq(orderMail.id, newsletter.id));
    expect(cleared).toMatchObject({
      id: newsletter.id,
      rawChecksum: newsletter.rawChecksum,
      content: { snippet: null, bodyText: null, bodyHtml: null },
    });
    const [message] = await getDb(ctx.db)
      .select({
        classification: emailTable.classification,
        orderMailId: emailTable.orderMailId,
      })
      .from(emailTable)
      .where(
        and(
          eq(emailTable.mailboxId, mailboxId),
          eq(emailTable.messageId, newsletter.messageId),
        ),
      );
    expect(message).toEqual({
      classification: "unrelated",
      orderMailId: newsletter.id,
    });
  });
});

// Ported write-boundary regressions through the member's prepare/commit:
// a Purchase-wide fallback replaces member purpose; an identified incomplete
// order invents spend; a mail import overrides a member's dismissal, links or
// attaches another Email's order, or loses a refund's money.
describe("caller-driven purchase import writes", () => {
  const ctx = withTestDb();

  const candidate = (
    orderId: string | null,
    lines: ExtractedOrderCandidate["lines"],
    overrides: Partial<ExtractedOrderCandidate> = {},
  ): ExtractedOrderCandidate => ({
    orderId,
    orderedAt: "2026-09-01T18:00:00Z",
    merchant: "Synthetic service merchant",
    currency: "USD",
    printedGrandTotal: lines.reduce((sum, line) => sum + line.amount, 0),
    lines,
    payments: [],
    allShipmentsDelivered: false,
    ...overrides,
  });
  const service = (amount = 10, title = "Synthetic service") => ({
    title,
    amount,
    quantity: 1,
    lineKind: "principal" as const,
  });
  const source = (key: string, digit: string) => ({
    kind: "receipt_photo" as const,
    externalKey: `synthetic:${key}`,
    checksum: digit.repeat(64),
  });

  async function purchaseLines(purchaseId: string) {
    return getDb(ctx.db)
      .select({
        name: expense.name,
        cost: expense.cost,
        trade: expense.trade,
        projectId: expense.projectId,
        productId: expense.productId,
        effectiveTrade: effectiveExpenseTradeSql(),
      })
      .from(expense)
      .where(eq(expense.purchaseId, parseEntityId("purchase", purchaseId)));
  }

  async function purchaseByShortcode(shortcode: string | null | undefined) {
    if (!shortcode) throw new Error("Import wrote no Purchase");
    const [row] = await getDb(ctx.db)
      .select()
      .from(purchase)
      .where(eq(purchase.shortcode, shortcode));
    if (!row) throw new Error("Imported Purchase is missing");
    return row;
  }

  // Without a commit default, purpose inheritance resolves first: a food
  // Product line keeps its household-project purpose, only a still-unassigned
  // principal line gets Other, and a Purchase-wide default is never invented.
  // The order-id gap follows the retained order identity, not the source
  // kind: a retailer order read in a member's own browser still lands in the
  // Research queue when its Purchase loses that id.
  it.each([
    ["vendor_export", "EXAMPLE-ORDER-ID", ["order_id"]],
    ["receipt_photo", null, []],
  ] as const)(
    "expects an order id only for an identified %s order",
    async (kind, orderId, expected) => {
      const { vendor } = await memberImportWorld(ctx.db, ctx.actor);
      const { committed } = await memberImport(ctx.db, ctx.actor, {
        key: `order-id-${kind}`,
        orders: [
          {
            stableOrderId: `order-id-${kind}`,
            vendorId: vendor.shortcode,
            source: { ...source(`order-id-${kind}`, "d"), kind },
            extraction: {
              status: "ready" as const,
              candidate: candidate(orderId, [service(12)]),
            },
          },
        ],
        defaultTrade: "other",
      });
      const saved = await purchaseByShortcode(committed.items[0]?.purchaseId);
      await getDb(ctx.db)
        .update(purchase)
        .set({ orderId: null })
        .where(eq(purchase.id, saved.id));
      const gaps = (await loadDataQualities(ctx.db, "purchase", [saved.id]))
        .get(saved.id)
        ?.gaps.map((gap) => gap.check)
        .filter((check) => check === "order_id");
      expect(gaps).toEqual(expected);
    },
  );

  it("fills unassigned imported lines after resolving Product purpose inheritance", async () => {
    const { vendor } = await memberImportWorld(ctx.db, ctx.actor);
    await getDb(ctx.db)
      .insert(project)
      .values({
        shortcode: testShortcode("project", "PRJ-HSHD"),
        name: "Synthetic household purpose",
        defaultTrade: "building",
      });
    const [food] = await getDb(ctx.db)
      .select()
      .from(productCategory)
      .where(eq(productCategory.feature, "food"));
    if (!food) throw new Error("Synthetic taxonomy lacks the food feature.");
    const item = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic ingredient",
      manufacturer: "",
      categoryId: food.id,
    });
    const order = {
      stableOrderId: "mixed-purpose",
      vendorId: vendor.shortcode,
      source: source("mixed-purpose", "c"),
      extraction: {
        status: "ready" as const,
        candidate: candidate("EXAMPLE-MIXED-PURPOSE", [
          service(10, item.name),
          service(4),
          { title: "Printed shipping", amount: 1, lineKind: "shipping" },
        ]),
      },
      resolutions: [
        { kind: "existing" as const, productId: item.shortcode },
        { kind: "expense_only" as const },
      ],
    };
    const { committed } = await memberImport(ctx.db, ctx.actor, {
      key: "mixed-purpose",
      orders: [order],
    });
    const saved = await purchaseByShortcode(committed.items[0]?.purchaseId);
    expect(saved.defaultTrade).toBeNull();
    const lines = await purchaseLines(saved.id);
    expect(lines).toHaveLength(3);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: item.name,
          cost: 10,
          trade: null,
          productId: item.id,
          effectiveTrade: "building",
        }),
        expect.objectContaining({
          name: "Synthetic service",
          cost: 4,
          trade: "other",
          effectiveTrade: "other",
        }),
        expect.objectContaining({
          name: "Printed shipping",
          cost: 1,
          trade: null,
          effectiveTrade: null,
        }),
      ]),
    );
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
    // A second member import of the unchanged source replays the source order.
    const replay = await memberImport(ctx.db, ctx.actor, {
      key: "mixed-purpose-again",
      orders: [order],
    });
    expect(replay.committed.items[0]).toMatchObject({
      outcome: "replayed",
      purchaseId: saved.shortcode,
    });
    expect(await getDb(ctx.db).select().from(expense)).toHaveLength(3);
  });

  // Regression: every imported line was stored as "materials", so an award
  // ticket's fare and taxes read as physical goods.
  it("stores each extracted line's cost type", async () => {
    const { vendor } = await memberImportWorld(ctx.db, ctx.actor);
    const { committed } = await memberImport(ctx.db, ctx.actor, {
      key: "award-ticket",
      orders: [
        {
          stableOrderId: "award-ticket",
          vendorId: vendor.shortcode,
          source: source("award-ticket", "d"),
          extraction: {
            status: "ready" as const,
            candidate: candidate("EXAMPLE-AWARD", [
              { ...service(0, "Synthetic award fare"), costType: "services" },
              {
                title: "Synthetic departure tax",
                amount: 5,
                lineKind: "tax",
                costType: "services",
              },
              { ...service(3, "Synthetic seat cushion") },
            ]),
          },
          resolutions: [
            { kind: "expense_only" as const },
            { kind: "expense_only" as const },
          ],
        },
      ],
    });
    const saved = await purchaseByShortcode(committed.items[0]?.purchaseId);
    const lines = await getDb(ctx.db)
      .select({ name: expense.name, costType: expense.costType })
      .from(expense)
      .where(eq(expense.purchaseId, saved.id));
    expect(Object.fromEntries(lines.map((l) => [l.name, l.costType]))).toEqual({
      "Synthetic award fare": "services",
      "Synthetic departure tax": "services",
      // An extractor that states no cost type keeps the materials default.
      "Synthetic seat cushion": "materials",
    });
  });

  it("imports a supported receipt without inventing purpose or replacing member attribution", async () => {
    const { vendor } = await memberImportWorld(ctx.db, ctx.actor);
    const existing = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "EXAMPLE-UNKNOWN-PURPOSE",
      defaultTrade: "other",
    });
    const { committed } = await memberImport(ctx.db, ctx.actor, {
      key: "unknown-purpose",
      orders: [
        {
          stableOrderId: "unknown-purpose",
          vendorId: vendor.shortcode,
          targetPurchaseId: existing.shortcode,
          source: source("unknown-purpose", "a"),
          extraction: {
            status: "ready",
            candidate: candidate("EXAMPLE-UNKNOWN-PURPOSE", [service()]),
          },
        },
      ],
    });
    expect(committed.items[0]?.purchaseId).toBe(existing.shortcode);
    const saved = await purchaseByShortcode(existing.shortcode);
    expect(saved.defaultTrade).toBe("other");
    expect((await purchaseLines(saved.id)).map(({ cost }) => cost)).toEqual([
      10,
    ]);
  });

  // Exact money replay must not erase deliberate Product choices. Binding
  // manual item rows is safe only when each source line has one unclaimed row;
  // duplicated item rows and previously accepted sources require review.
  it.each(["new", "existing", "ambiguous", "source_owned"] as const)(
    "honors %s Product choices on existing itemized spend or returns review",
    async (mode) => {
      const { vendor } = await memberImportWorld(ctx.db, ctx.actor);
      const lines: ExtractedOrderCandidate["lines"] = [
        {
          title: "Synthetic brass trowel",
          amount: 18,
          quantity: 2,
          lineKind: "principal",
        },
        {
          title:
            mode === "ambiguous"
              ? "Synthetic brass trowel"
              : "Synthetic steel fork",
          amount: mode === "ambiguous" ? 18 : 12,
          quantity: 2,
          lineKind: "principal",
        },
        { title: "Synthetic sales tax", amount: 3, lineKind: "tax" },
      ];
      const target = await insertWithShortcode(ctx.db, "purchase", {
        vendorId: vendor.id,
        orderId: "SYNTHETIC-ITEMIZED-CHOICES",
        date: "2026-09-01",
        defaultTrade: "other",
        itemizationEvidence: true,
      });
      for (const line of lines)
        await insertWithShortcode(ctx.db, "expense", {
          purchaseId: target.id,
          name: line.title,
          cost: line.amount,
          date: target.date,
          lineKind: line.lineKind,
          lineBasis: "item_line",
          costType: "materials",
          trade: "other",
          projectId: null,
          economicRole: "vendor",
          productId: null,
          productQuantity: null,
        });
      const database = getDb(ctx.db);
      const before = await database.select().from(expense).orderBy(expense.id);
      if (mode === "source_owned")
        await memberImport(ctx.db, ctx.actor, {
          key: "accepted-itemized-source",
          orders: [
            {
              stableOrderId: "accepted-itemized-source",
              vendorId: vendor.shortcode,
              targetPurchaseId: target.shortcode,
              source: source("accepted-itemized-source", "a"),
              extraction: {
                status: "ready",
                candidate: candidate(target.orderId, lines),
              },
            },
          ],
        });
      const products =
        mode === "existing"
          ? await Promise.all(
              lines
                .slice(0, 2)
                .map((line) =>
                  createProductFixture(
                    ctx.db,
                    makeProductInput({ name: line.title }),
                    ctx.actor,
                  ),
                ),
            )
          : [];
      const resolutions =
        mode === "existing"
          ? products.map((row) => ({
              kind: "existing" as const,
              productId: row.id,
            }))
          : [{ kind: "new" as const }, { kind: "new" as const }];
      const { committed } = await memberImport(ctx.db, ctx.actor, {
        key: "itemized-product-choice",
        orders: [
          {
            stableOrderId: "itemized-product-choice",
            vendorId: vendor.shortcode,
            targetPurchaseId: target.shortcode,
            source: source("itemized-product-choice", "b"),
            extraction: {
              status: "ready",
              candidate: candidate(target.orderId, lines),
            },
            resolutions,
          },
        ],
      });
      const item = committed.items[0];
      const after = await database.select().from(expense).orderBy(expense.id);
      const needsReview = mode === "ambiguous" || mode === "source_owned";
      expect(item).toMatchObject({
        outcome: needsReview ? "conflict" : "updated",
        purchaseId: target.shortcode,
        findingCount: needsReview ? 1 : 0,
      });
      const principals = after.filter((row) => row.lineKind === "principal");
      expect(
        principals.every(
          (row) => row.productId !== null && row.productQuantity === 2,
        ),
      ).toBe(!needsReview);
      expect(principals.map((row) => row.productQuantity)).toEqual(
        needsReview ? [null, null] : [2, 2],
      );
      expect(
        after.map(
          ({
            productId: _productId,
            productQuantity: _quantity,
            updatedAt: _updatedAt,
            ...row
          }) => row,
        ),
      ).toEqual(
        before.map(
          ({
            productId: _productId,
            productQuantity: _quantity,
            updatedAt: _updatedAt,
            ...row
          }) => row,
        ),
      );
      const bindings = await database.select().from(importSourceProduct);
      expect(bindings).toHaveLength(needsReview ? 0 : 2);
      expect(bindings.map((row) => row.lineIndex).sort()).toEqual(
        needsReview ? [] : [0, 1],
      );
      expect(bindings.map((row) => row.productId).sort()).toEqual(
        principals
          .flatMap((row) => (row.productId ? [row.productId] : []))
          .sort(),
      );
      expect(await database.select().from(product)).toHaveLength(
        needsReview ? 0 : 2,
      );
      expect(await database.select().from(runFinding)).toHaveLength(
        needsReview ? 1 : 0,
      );
      expect(await database.select().from(inventoryEntry)).toHaveLength(0);
    },
  );

  // A null Purchase trade can intentionally inherit a selected Project or
  // line purpose. The member's import default must not override that
  // selection, nor an assigned Purchase trade; it fills only a new or
  // genuinely unassigned Purchase.
  it.each([
    "purchase_project",
    "line_project",
    "line_trade",
    "assigned_purchase",
    "unassigned_purchase",
    "new_purchase",
  ] as const)(
    "fills Other only without member purpose: %s",
    async (selection) => {
      const { vendor } = await memberImportWorld(ctx.db, ctx.actor);
      const parentProject = await insertWithShortcode(ctx.db, "project", {
        name: "Synthetic purpose parent",
        defaultTrade: "plumbing",
      });
      const selectedProject = await insertWithShortcode(ctx.db, "project", {
        name: "Synthetic purpose child",
        parentProjectId: parentProject.id,
      });
      const existing =
        selection === "new_purchase"
          ? undefined
          : await insertWithShortcode(ctx.db, "purchase", {
              vendorId: vendor.id,
              orderId: "EXAMPLE-MEMBER-PURPOSE",
              date: "2026-09-01",
              defaultTrade:
                selection === "assigned_purchase" ? "plumbing" : null,
              defaultProjectId:
                selection === "purchase_project" ? selectedProject.id : null,
            });
      if (
        existing &&
        (selection === "line_project" || selection === "line_trade")
      )
        await insertWithShortcode(ctx.db, "expense", {
          purchaseId: existing.id,
          name: "Synthetic service",
          date: "2026-09-01",
          cost: 10,
          costType: "materials",
          lineKind: "principal",
          lineBasis: "item_line",
          trade: selection === "line_trade" ? "plumbing" : null,
          projectId: selection === "line_project" ? selectedProject.id : null,
        });
      const order = {
        stableOrderId: "member-purpose",
        vendorId: vendor.shortcode,
        targetPurchaseId: existing?.shortcode,
        source: source("member-purpose", "b"),
        extraction: {
          status: "ready" as const,
          candidate: candidate("EXAMPLE-MEMBER-PURPOSE", [service()]),
        },
      };
      const { committed } = await memberImport(ctx.db, ctx.actor, {
        key: "member-purpose",
        orders: [order],
        defaultTrade: "other",
      });
      const saved = await purchaseByShortcode(committed.items[0]?.purchaseId);
      const hasMemberPurpose =
        selection !== "unassigned_purchase" && selection !== "new_purchase";
      expect(saved).toMatchObject({
        id: existing?.id ?? saved.id,
        defaultTrade:
          selection === "assigned_purchase"
            ? "plumbing"
            : hasMemberPurpose
              ? null
              : "other",
        defaultProjectId:
          selection === "purchase_project" ? selectedProject.id : null,
      });
      expect(await purchaseLines(saved.id)).toEqual([
        expect.objectContaining({
          cost: 10,
          trade: selection === "line_trade" ? "plumbing" : null,
          projectId: selection === "line_project" ? selectedProject.id : null,
          effectiveTrade: hasMemberPurpose ? "plumbing" : "other",
        }),
      ]);
      const replay = await memberImport(ctx.db, ctx.actor, {
        key: "member-purpose-again",
        orders: [order],
        defaultTrade: "other",
      });
      expect(replay.committed.items[0]).toMatchObject({
        outcome: "replayed",
        purchaseId: saved.shortcode,
      });
    },
  );

  it.each(["USD", null, "CAD", "CAD-mismatch"])(
    "keeps an identified incomplete order in %s unknown, then improves it without invented spend",
    async (currency) => {
      const { vendor } = await memberImportWorld(ctx.db, ctx.actor);
      const shipment = candidate("EXAMPLE-101", [], {
        orderedAt: currency === "USD" ? null : "2026-09-01T18:00:00Z",
        currency: currency === "CAD-mismatch" ? "CAD" : currency,
        printedGrandTotal: currency === "USD" ? null : 24,
        payments: currency === "USD" ? [] : [{ amount: 24 }],
      });
      const first = await memberImport(ctx.db, ctx.actor, {
        key: "incomplete-shipment",
        orders: [
          {
            stableOrderId: "incomplete-shipment",
            vendorId: vendor.shortcode,
            source: source("shipment", "a"),
            extraction:
              currency === "CAD-mismatch"
                ? {
                    status: "needs_review",
                    reason: "sum_mismatch",
                    detail: "The foreign-unit total differs from priced lines.",
                    candidate: shipment,
                  }
                : { status: "ready", candidate: shipment },
          },
        ],
      });
      const saved = await purchaseByShortcode(
        first.committed.items[0]?.purchaseId,
      );
      expect(saved).toMatchObject({
        date: currency === "USD" ? null : "2026-09-01",
        statedTotal: null,
      });
      expect(
        await getDb(ctx.db)
          .select()
          .from(purchasePaymentEvidence)
          .where(eq(purchasePaymentEvidence.purchaseId, saved.id)),
      ).toEqual([]);
      expect(await purchaseLines(saved.id)).toEqual([]);
      const confirmation = {
        stableOrderId: "incomplete-confirmation",
        vendorId: vendor.shortcode,
        source: source("confirmation", "b"),
        extraction: {
          status: "ready" as const,
          candidate: candidate("EXAMPLE-101", [
            service(24, "Workshop admission"),
          ]),
        },
      };
      const improved = await memberImport(ctx.db, ctx.actor, {
        key: "incomplete-confirmation",
        orders: [confirmation],
        defaultTrade: "other",
      });
      expect(improved.committed.items[0]?.purchaseId).toBe(saved.shortcode);
      await memberImport(ctx.db, ctx.actor, {
        key: "incomplete-confirmation-again",
        orders: [confirmation],
        defaultTrade: "other",
      });
      expect(await purchaseByShortcode(saved.shortcode)).toMatchObject({
        date: "2026-09-01",
        statedTotal: 24,
      });
      expect(
        (await purchaseLines(saved.id)).map(({ cost, productId }) => ({
          cost,
          productId,
        })),
      ).toEqual([{ cost: 24, productId: null }]);
    },
  );

  async function retainedOrderMail(partyId: LedgerPartyId, messageId: string) {
    return retainedMailFixture(ctx.db, {
      ledgerPartyId: partyId,
      messageId,
      checksum: await sha256Hex(messageId),
      mailboxId,
    });
  }

  async function existingServiceOrder(vendorId: VendorId) {
    const existing = await insertWithShortcode(ctx.db, "purchase", {
      vendorId,
      orderId: "ORDER-ONE",
    });
    await insertWithShortcode(ctx.db, "expense", {
      purchaseId: existing.id,
      name: "Synthetic annual service",
      trade: "other",
      costType: "services",
      date: "2026-10-01",
      cost: 10,
      lineKind: "principal",
    });
    return existing;
  }

  async function historicalEvent(mailId: string) {
    const [event] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: mailId,
        sourceKey: "synthetic-historical-event",
        event: "placed",
        orderId: "ORDER-ONE",
        payload: {},
      })
      .returning();
    if (!event) throw new Error("Synthetic event missing");
    return event;
  }

  it("links refund provenance without changing money", async () => {
    const { party, vendor } = await memberImportWorld(ctx.db, ctx.actor);
    const existing = await existingServiceOrder(vendor.id);
    const mail = await retainedOrderMail(party.id, "refund-notice");
    await historicalEvent(mail.id);
    await expect(
      resolveMail(
        ctx.db,
        {
          mailboxId,
          messageId: mail.messageId,
          checksum: mail.rawChecksum,
          disposition: {
            kind: "linked",
            purchaseIds: [existing.shortcode],
            event: "refunded",
          },
        },
        ctx.actor,
      ),
    ).resolves.toMatchObject({ purchaseIds: [existing.shortcode] });
    expect(
      (await getDb(ctx.db).select().from(expense)).map(({ cost }) => cost),
    ).toEqual([10]);
    expect(
      (await getDb(ctx.db).select().from(orderMailEvent)).some(
        (row) => row.event === "refunded",
      ),
    ).toBe(true);
    expect(
      await getDb(ctx.db)
        .select({
          decision: orderMailCandidateDecision.decision,
          purchaseId: orderMailCandidateDecision.purchaseId,
        })
        .from(orderMailCandidateDecision),
    ).toEqual([{ decision: "linked", purchaseId: existing.id }]);
  });

  it("refuses a refund link over the member's dismissal of that Email", async () => {
    const { party, vendor } = await memberImportWorld(ctx.db, ctx.actor);
    const existing = await existingServiceOrder(vendor.id);
    const mail = await retainedOrderMail(party.id, "dismissed-refund");
    const event = await historicalEvent(mail.id);
    await getDb(ctx.db).insert(orderMailCandidateDecision).values({
      eventId: event.id,
      purchaseId: existing.id,
      decision: "dismissed",
      evidenceChecksum: mail.rawChecksum,
      decidedByUserId: ctx.actor.userId,
    });
    await expect(
      resolveMail(
        ctx.db,
        {
          mailboxId,
          messageId: mail.messageId,
          checksum: mail.rawChecksum,
          disposition: {
            kind: "linked",
            purchaseIds: [existing.shortcode],
            event: "refunded",
          },
        },
        ctx.actor,
      ),
    ).rejects.toThrow(/dismissed/);
    expect(
      (await getDb(ctx.db).select().from(expense)).map(({ cost }) => cost),
    ).toEqual([10]);
    expect(
      (await getDb(ctx.db).select().from(orderMailEvent)).map(
        ({ event }) => event,
      ),
    ).toEqual(["placed"]);
    expect(
      (await getDb(ctx.db).select().from(orderMailCandidateDecision)).map(
        ({ decision }) => decision,
      ),
    ).toEqual(["dismissed"]);
  });

  it("preserves historical dismissal when the writer would find a known order without an explicit purchaseRef", async () => {
    const { party, vendor } = await memberImportWorld(ctx.db, ctx.actor);
    const existing = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "ORDER-ONE",
    });
    const mail = await retainedOrderMail(party.id, "dismissed-order");
    const event = await historicalEvent(mail.id);
    await getDb(ctx.db).insert(orderMailCandidateDecision).values({
      eventId: event.id,
      purchaseId: existing.id,
      decision: "dismissed",
      evidenceChecksum: mail.rawChecksum,
      decidedByUserId: ctx.actor.userId,
    });
    const { commit } = await prepareMemberImport(ctx.db, ctx.actor, {
      key: "dismissed-order",
      orders: [
        {
          stableOrderId: "dismissed-order",
          vendorId: vendor.shortcode,
          source: mailSource(mail),
          extraction: {
            status: "ready",
            candidate: candidate("ORDER-ONE", [service()]),
          },
        },
      ],
      defaultTrade: "other",
    });
    await expect(commit()).rejects.toThrow(/dismissed/i);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    expect(await getDb(ctx.db).select().from(importSourceClaim)).toEqual([]);
    expect(
      (await getDb(ctx.db).select().from(orderMailCandidateDecision)).map(
        ({ decision }) => decision,
      ),
    ).toEqual(["dismissed"]);
  });

  it("attaches only the imported original while refusing implicit same-order mail links and attachments", async () => {
    const { party, vendor } = await memberImportWorld(ctx.db, ctx.actor);
    const mail = await retainedOrderMail(party.id, "imported-original");
    const otherMail = await retainedOrderMail(
      party.id,
      "unimported-same-order",
    );
    const [otherEvent] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: otherMail.id,
        event: "confirmation",
        orderId: "ORDER-ONE",
        sourceKey: "synthetic-unimported-order",
        payload: {},
      })
      .returning();
    if (!otherEvent) throw new Error("Synthetic unimported event missing");
    const [importedImage, otherImage] = await Promise.all(
      ["imported", "unimported"].map((name) =>
        insertWithShortcode(ctx.db, "image", {
          key: `images/synthetic-${name}.pdf`,
          filename: `synthetic-${name}.pdf`,
          contentType: "application/pdf",
          size: 100,
          status: "UPLOADED",
          sha256: "a".repeat(64),
        }),
      ),
    );
    if (!importedImage || !otherImage)
      throw new Error("Synthetic original images missing");
    await getDb(ctx.db)
      .insert(orderMailAttachment)
      .values(
        [
          { owner: mail, image: importedImage },
          { owner: otherMail, image: otherImage },
        ].map(({ owner, image }) => ({
          orderMailId: owner.id,
          providerAttachmentId: `synthetic-${image.filename}`,
          filename: image.filename,
          mimeType: "application/pdf",
          checksum: image.sha256!,
          imageId: image.id,
        })),
      );
    const { committed } = await memberImport(ctx.db, ctx.actor, {
      key: "imported-original",
      orders: [
        {
          stableOrderId: "imported-original",
          vendorId: vendor.shortcode,
          source: mailSource(mail),
          extraction: {
            status: "ready",
            candidate: candidate("ORDER-ONE", [service()]),
          },
        },
      ],
      defaultTrade: "other",
    });
    expect(committed.items).toHaveLength(1);
    const attached = await getDb(ctx.db).select().from(entityAttachment);
    expect(attached.map(({ imageId }) => imageId)).toEqual([importedImage.id]);
    const decisions = await getDb(ctx.db)
      .select()
      .from(orderMailCandidateDecision);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.eventId).not.toBe(otherEvent.id);
    expect(await getDb(ctx.db).select().from(importSourceOrder)).toHaveLength(
      1,
    );
  });

  it("refuses the retired browser_order source kind on a new preparation", async () => {
    const { vendor } = await memberImportWorld(ctx.db, ctx.actor);
    await expect(
      prepareMemberImport(ctx.db, ctx.actor, {
        key: "retired-browser-order",
        orders: [
          {
            stableOrderId: "retired-browser-order",
            vendorId: vendor.shortcode,
            source: {
              // SAFETY: the retired kind is outside the input type on purpose;
              // the runtime parse must refuse it.
              kind: "browser_order" as never,
              externalKey: "synthetic:browser-order",
              checksum: "b".repeat(64),
            },
            extraction: {
              status: "ready",
              candidate: candidate("ORDER-ONE", [service()]),
            },
          },
        ],
        defaultTrade: "other",
      }),
    ).rejects.toThrow(/source|kind/i);
    expect(await getDb(ctx.db).select().from(run)).toEqual([]);
  });

  it("links and settles the parent Email when its attachment creates the Purchase", async () => {
    const { party, vendor } = await memberImportWorld(ctx.db, ctx.actor);
    const mail = await retainedOrderMail(party.id, "attachment-original");
    const attachmentChecksum = await sha256Hex("synthetic attachment receipt");
    await getDb(ctx.db).insert(orderMailAttachment).values({
      orderMailId: mail.id,
      providerAttachmentId: "receipt-part",
      filename: "receipt.pdf",
      mimeType: "application/pdf",
      checksum: attachmentChecksum,
    });
    const { committed } = await memberImport(ctx.db, ctx.actor, {
      key: "attachment-original",
      orders: [
        {
          stableOrderId: "attachment-original",
          vendorId: vendor.shortcode,
          source: {
            kind: "mail_attachment",
            externalKey: `gmail:${mailboxId}:${mail.messageId}:attachment:receipt-part`,
            checksum: attachmentChecksum,
          },
          extraction: {
            status: "ready",
            candidate: candidate("ORDER-ONE", [service()]),
          },
        },
      ],
      defaultTrade: "other",
    });
    const saved = await purchaseByShortcode(committed.items[0]?.purchaseId);
    expect(
      (await getDb(ctx.db).select().from(orderMailCandidateDecision)).map(
        ({ purchaseId, decision, evidenceChecksum }) => ({
          purchaseId,
          decision,
          evidenceChecksum,
        }),
      ),
    ).toEqual([
      {
        purchaseId: saved.id,
        decision: "linked",
        evidenceChecksum: mail.rawChecksum,
      },
    ]);
    const [message] = await getDb(ctx.db)
      .select({ status: emailTable.status })
      .from(emailTable)
      .where(eq(emailTable.messageId, mail.messageId));
    expect(message?.status).toBe("completed");
    // The import-source identity keeps the attachment's own checksum.
    expect(
      await getDb(ctx.db)
        .select({
          kind: importSourceClaim.kind,
          checksum: importSourceClaim.checksum,
        })
        .from(importSourceClaim),
    ).toEqual([{ kind: "mail_attachment", checksum: attachmentChecksum }]);
  });

  it("records the shipping event when its Email creates the Purchase first", async () => {
    const { party, vendor } = await memberImportWorld(ctx.db, ctx.actor);
    const mail = await retainedOrderMail(party.id, "shipping-first");
    const { committed } = await memberImport(ctx.db, ctx.actor, {
      key: "shipping-first",
      orders: [
        {
          stableOrderId: "shipping-first",
          vendorId: vendor.shortcode,
          source: mailSource(mail),
          extraction: {
            status: "ready",
            candidate: candidate("ORDER-ONE", [service()], {
              sourceEvent: "shipped",
            }),
          },
        },
      ],
      defaultTrade: "other",
    });
    const saved = await purchaseByShortcode(committed.items[0]?.purchaseId);
    const events = await getDb(ctx.db).select().from(orderMailEvent);
    expect(events.map(({ event }) => event)).toEqual(["shipped"]);
    const links = await getDb(ctx.db).select().from(orderMailCandidateDecision);
    expect(
      links.map(({ eventId, purchaseId, evidenceChecksum }) => ({
        eventId,
        purchaseId,
        evidenceChecksum,
      })),
    ).toEqual([
      {
        eventId: events[0]!.id,
        purchaseId: saved.id,
        evidenceChecksum: mail.rawChecksum,
      },
    ]);
    expect((await purchaseLines(saved.id)).map(({ cost }) => cost)).toEqual([
      10,
    ]);
  });
});

describe("shared purchase-import prepare and commit", () => {
  const ctx = withTestDb();

  it("reuses an exact ASIN and replays the committed business result", async () => {
    const { party, vendor } = await memberImportWorld(ctx.db, ctx.actor, {
      vendor: {
        name: "Shared import Amazon fixture",
        website: "https://www.amazon.com/orders",
        browserDomains: ["amazon.com", "www.amazon.com"],
      },
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Shared import fixture account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const existingProduct = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Reusable exact-ASIN product" }),
      ctx.actor,
    );
    const [existingProductRow] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, existingProduct.entityId));
    if (!existingProductRow) throw new Error("Product fixture was not created");
    await withTransaction(ctx.db, async (tx) => {
      await ensureExternalSources(tx, ["gtin"]);
      await tx.insert(externalSource).values({
        slug: "amazon",
        label: "Example registered catalog",
        vendorId: vendor.id,
      });
      await tx.insert(entityExternalId).values({
        entityId: existingProduct.entityId,
        entityKind: "product" as const,
        source: "amazon",
        kind: "asin",
        externalId: "B012345678",
        isPrimary: true,
      });
    });
    const run = await startImportRunFixture(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const financialAccount = await insertWithShortcode(
      ctx.db,
      "financialAccount",
      {
        name: "Shared import fixture card",
        identity: { kind: "credit_card", issuer: null, network: "visa" },
        ledgerPartyId: party.id,
      },
    );
    const postedCharge = await insertWithShortcode(
      ctx.db,
      "financialTransaction",
      {
        accountId: financialAccount.id,
        kind: "purchase",
        status: "posted",
        amount: 12.34,
        transactionDate: null,
        postedDate: "2026-09-21",
      },
    );
    const prepareInput = {
      _runExecution: {
        runId: run.id,
        operationId: "prepare:amazon-order-1",
        itemOperationIds: ["prepare-item:amazon-order-1"],
      },
      orders: [
        {
          stableOrderId: "amazon-order-1",
          itemOperationId: "prepare-item:amazon-order-1",
          source: {
            kind: "vendor_export" as const,
            externalKey: "amazon:order:111-2222222-3333333",
            checksum: checksum("a"),
          },
          evidenceChecksum: checksum("b"),
          extractionRevision: "amazon@fixture-1",
          extraction: {
            status: "ready" as const,
            candidate: {
              orderId: "111-2222222-3333333",
              orderedAt: "2026-09-20T12:00:00.000Z",
              merchant: "Amazon",
              currency: "USD",
              printedGrandTotal: 12.34,
              lines: [
                {
                  title: "Reusable exact-ASIN product",
                  amount: 12.34,
                  lineKind: "principal" as const,
                  productUrl:
                    "https://www.amazon.com/dp/B012345678?ref_=orders",
                },
              ],
              payments: [
                { amount: 12.34, chargedAt: "2026-09-20T12:00:00.000Z" },
              ],
              allShipmentsDelivered: false,
            },
          },
          lineIds: ["amazon-order-1:line-1"],
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    };

    const prepared = await preparePurchaseImport(
      ctx.db,
      prepareInput,
      ctx.actor,
    );
    expect(prepared.status).toBe("running");
    expect(prepared.orders[0]?.lines[0]?.candidates[0]).toMatchObject({
      productId: existingProductRow.shortcode,
      exactIdentifierMatch: true,
    });

    const commitInput = commitPurchaseImportInput.parse({
      _runExecution: {
        runId: run.id,
        operationId: "commit:amazon-order-1",
      },
      prepareOperationId: prepareInput._runExecution.operationId,
      defaultTrade: "other",
      resolutions: [
        {
          stableOrderId: "amazon-order-1",
          stableLineId: "amazon-order-1:line-1",
          resolution: {
            kind: "existing" as const,
            productId: existingProductRow.shortcode,
          },
        },
      ],
    });
    const first = await commitPurchaseImport(ctx.db, commitInput, ctx.actor);
    const replay = await commitPurchaseImport(ctx.db, commitInput, ctx.actor);
    expect(replay).toEqual(first);

    const writtenPurchases = await getDb(ctx.db)
      .select({ id: purchase.id })
      .from(purchase)
      .where(eq(purchase.orderId, "111-2222222-3333333"));
    expect(writtenPurchases).toHaveLength(1);
    const writtenExpenses = await getDb(ctx.db)
      .select({ productId: expense.productId })
      .from(expense)
      .where(eq(expense.purchaseId, writtenPurchases[0]!.id));
    expect(writtenExpenses).toEqual([{ productId: existingProduct.entityId }]);
    const allocations = await getDb(ctx.db)
      .select({ transactionId: financialTransactionAllocation.transactionId })
      .from(financialTransactionAllocation)
      .where(
        eq(financialTransactionAllocation.purchaseId, writtenPurchases[0]!.id),
      );
    expect(allocations).toEqual([{ transactionId: postedCharge.id }]);

    // The import's writes are recorded once, under the Run, in the shared
    // audit trail; a replay of the same commit adds nothing.
    const runAudit = await getDb(ctx.db)
      .select({
        entityKind: auditLog.entityKind,
        entityId: auditLog.entityId,
        action: auditLog.action,
        userId: auditLog.userId,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.runId, run.id),
          inArray(auditLog.entityKind, ["purchase", "expense"]),
        ),
      );
    expect(runAudit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityKind: "purchase",
          entityId: writtenPurchases[0]!.id,
          userId: ctx.actor.userId,
        }),
        expect.objectContaining({ entityKind: "expense", action: "create" }),
      ]),
    );
    expect(
      runAudit.filter((row) => row.entityKind === "purchase"),
    ).toHaveLength(1);
  });

  it("matches a photo-recorded barcode exactly when the order line SKU is that UPC", async () => {
    const { party, vendor } = await memberImportWorld(ctx.db, ctx.actor, {
      vendor: {
        name: "Barcode import vendor fixture",
        website: "https://shop.example.com/orders",
        browserDomains: ["shop.example.com"],
      },
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Barcode import fixture account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    // A photo-first Product whose only identifier is the barcode read off its
    // tag, stored under the vendor-neutral GTIN source.
    const photoProduct = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Gray crew t-shirt — M" }),
      ctx.actor,
    );
    const [photoProductRow] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, photoProduct.entityId));
    if (!photoProductRow) throw new Error("Product fixture was not created");
    await withTransaction(ctx.db, async (tx) => {
      await ensureExternalSources(tx, ["amazon", "gtin"]);
      await tx.insert(entityExternalId).values({
        entityId: photoProduct.entityId,
        entityKind: "product" as const,
        source: "gtin",
        kind: "gtin_14",
        externalId: "00012345678905",
        isPrimary: true,
      });
    });
    const run = await startImportRunFixture(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });

    const prepared = await preparePurchaseImport(
      ctx.db,
      {
        _runExecution: {
          runId: run.id,
          operationId: "prepare:barcode-order-1",
          itemOperationIds: ["prepare-item:barcode-order-1"],
        },
        orders: [
          {
            stableOrderId: "barcode-order-1",
            itemOperationId: "prepare-item:barcode-order-1",
            source: {
              kind: "vendor_export" as const,
              externalKey: "example:order:barcode-1",
              checksum: checksum("c"),
            },
            evidenceChecksum: checksum("d"),
            extractionRevision: "example@fixture-1",
            extraction: {
              status: "ready" as const,
              candidate: {
                orderId: "barcode-1",
                orderedAt: "2026-09-20T12:00:00.000Z",
                merchant: "Example Shop",
                currency: "USD",
                printedGrandTotal: 20,
                lines: [
                  {
                    title: "Everyday Crew Tee Heather Gray",
                    amount: 20,
                    lineKind: "principal" as const,
                    sku: "012345678905",
                  },
                ],
                payments: [],
                allShipmentsDelivered: false,
              },
            },
            lineIds: ["barcode-order-1:line-1"],
            primaryDocumentImageId: null,
            screenshotImageId: null,
          },
        ],
      },
      ctx.actor,
    );
    expect(prepared.orders[0]?.lines[0]?.candidates[0]).toMatchObject({
      productId: photoProductRow.shortcode,
      exactIdentifierMatch: true,
    });
  });

  it("commits tax and shipping lines using only the principal line's resolution", async () => {
    const { party, vendor } = await memberImportWorld(ctx.db, ctx.actor, {
      vendor: {
        name: `Adjustment lines vendor ${crypto.randomUUID()}`,
        website: "https://shop.example.test",
        browserDomains: ["shop.example.test"],
      },
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Adjustment lines account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const existingProduct = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Adjustment lines widget" }),
      ctx.actor,
    );
    const [productRow] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, existingProduct.entityId));
    if (!productRow) throw new Error("Product fixture was not created");

    const run = await startImportRunFixture(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const prepareInput = {
      _runExecution: {
        runId: run.id,
        operationId: "prepare:adjustments-order-1",
        itemOperationIds: ["prepare-item:adjustments-order-1"],
      },
      orders: [
        {
          stableOrderId: "adjustments-order-1",
          itemOperationId: "prepare-item:adjustments-order-1",
          source: {
            kind: "vendor_export" as const,
            externalKey: "adjustments:order:1",
            checksum: checksum("e"),
          },
          evidenceChecksum: checksum("f"),
          extractionRevision: "adjustments@fixture-1",
          extraction: {
            status: "ready" as const,
            candidate: {
              orderId: "ADJUSTMENTS-ORDER-1",
              orderedAt: "2026-09-20T12:00:00.000Z",
              merchant: "Example",
              currency: "USD",
              printedGrandTotal: 25,
              lines: [
                {
                  title: "Adjustment lines widget",
                  amount: 20,
                  lineKind: "principal" as const,
                },
                { title: "Sales tax", amount: 2, lineKind: "tax" as const },
                {
                  title: "Shipping",
                  amount: 3,
                  lineKind: "shipping" as const,
                },
              ],
              payments: [],
              allShipmentsDelivered: false,
            },
          },
          lineIds: [
            "adjustments-order-1:line-1",
            "adjustments-order-1:line-2",
            "adjustments-order-1:line-3",
          ],
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    };
    await preparePurchaseImport(ctx.db, prepareInput, ctx.actor);

    // Only the principal line carries a resolution — tax and shipping are
    // never resolvable to a Product, matching what the MCP layer sends.
    const commitInput = commitPurchaseImportInput.parse({
      _runExecution: {
        runId: run.id,
        operationId: "commit:adjustments-order-1",
      },
      prepareOperationId: prepareInput._runExecution.operationId,
      defaultTrade: "other" as const,
      resolutions: [
        {
          stableOrderId: "adjustments-order-1",
          stableLineId: "adjustments-order-1:line-1",
          resolution: {
            kind: "existing" as const,
            productId: parseShortcodeFor("product", productRow.shortcode),
          },
        },
      ],
    });

    const result = await commitPurchaseImport(ctx.db, commitInput, ctx.actor);
    expect(result.status).toBe("running");
    expect(result.items[0]?.purchaseId).not.toBeNull();

    const [written] = await getDb(ctx.db)
      .select({ id: purchase.id })
      .from(purchase)
      .where(eq(purchase.orderId, "ADJUSTMENTS-ORDER-1"));
    if (!written) throw new Error("Purchase was not written");
    const writtenExpenses = await getDb(ctx.db)
      .select({ lineKind: expense.lineKind, productId: expense.productId })
      .from(expense)
      .where(eq(expense.purchaseId, written.id));
    expect(writtenExpenses).toHaveLength(3);
    expect(
      writtenExpenses.find((row) => row.lineKind === "principal")?.productId,
    ).toBe(existingProduct.entityId);
    for (const kind of ["tax", "shipping"] as const) {
      expect(
        writtenExpenses.find((row) => row.lineKind === kind)?.productId,
      ).toBeNull();
    }
  });

  it("leaves a failed RunOperation row when a resolution's product cannot be resolved", async () => {
    const { party, vendor } = await memberImportWorld(ctx.db, ctx.actor, {
      vendor: {
        name: `Failed commit vendor ${crypto.randomUUID()}`,
        website: "https://shop.example.test",
        browserDomains: ["shop.example.test"],
      },
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Failed commit account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const run = await startImportRunFixture(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const prepareInput = {
      _runExecution: {
        runId: run.id,
        operationId: "prepare:failing-order-1",
        itemOperationIds: ["prepare-item:failing-order-1"],
      },
      orders: [
        {
          stableOrderId: "failing-order-1",
          itemOperationId: "prepare-item:failing-order-1",
          source: {
            kind: "vendor_export" as const,
            externalKey: "failing:order:1",
            checksum: checksum("1"),
          },
          evidenceChecksum: checksum("2"),
          extractionRevision: "failing@fixture-1",
          extraction: {
            status: "ready" as const,
            candidate: {
              orderId: "FAILING-ORDER-1",
              orderedAt: "2026-09-20T12:00:00.000Z",
              merchant: "Example",
              currency: "USD",
              printedGrandTotal: 9.99,
              lines: [
                {
                  title: "Widget",
                  amount: 9.99,
                  lineKind: "principal" as const,
                },
              ],
              payments: [],
              allShipmentsDelivered: false,
            },
          },
          lineIds: ["failing-order-1:line-1"],
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    };
    await preparePurchaseImport(ctx.db, prepareInput, ctx.actor);

    const operationId = "commit:failing-order-1";
    const commitInput = commitPurchaseImportInput.parse({
      _runExecution: { runId: run.id, operationId },
      prepareOperationId: prepareInput._runExecution.operationId,
      defaultTrade: "other" as const,
      resolutions: [
        {
          stableOrderId: "failing-order-1",
          stableLineId: "failing-order-1:line-1",
          // Well-formed shortcode for a Product that does not exist:
          // resolveOrThrow rejects deep inside the transaction, after the
          // RunOperation "started" row has already been inserted, so
          // that insert is rolled back along with everything else.
          resolution: { kind: "existing" as const, productId: "PRD-9999" },
        },
      ],
    });

    await expect(
      commitPurchaseImport(ctx.db, commitInput, ctx.actor),
    ).rejects.toThrow("PRD-9999");

    const [operation] = await getDb(ctx.db)
      .select({
        state: runOperation.state,
        error: runOperation.error,
      })
      .from(runOperation)
      .where(
        and(
          eq(runOperation.runId, run.id),
          eq(runOperation.operationId, operationId),
        ),
      );
    expect(operation?.state).toBe("failed");
    expect(operation?.error).toContain("PRD-9999");
  });

  /**
   * A member booked an order by hand as one aggregate Expense, then an import
   * of the same order commits its itemized line, which leaves a reviewed
   * replacement of the aggregate for approval.
   */
  async function importOverManualAggregate(
    targetOrderless: boolean,
    categorized = false,
    includeTax = false,
  ) {
    const { party, vendor } = await memberImportWorld(ctx.db, ctx.actor, {
      vendor: {
        name: `Manual-then-import vendor ${crypto.randomUUID()}`,
        website: "https://shop.example.test",
        browserDomains: ["shop.example.test"],
      },
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Manual-then-import account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    // A household member recorded this order by hand before any import ran:
    // one aggregate Expense, no Product, no source claim.
    const manualPurchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: targetOrderless ? null : "MANUAL-ORDER-1",
      date: "2026-09-18",
      statedTotal: 45,
    });
    const category = categorized
      ? await insertWithShortcode(ctx.db, "spendingCategory", {
          name: "Replacement category",
        })
      : null;
    const manualExpense = await insertWithShortcode(ctx.db, "expense", {
      purchaseId: manualPurchase.id,
      name: "Recorded from a paper receipt",
      cost: 45,
      date: "2026-09-18",
      lineKind: "principal",
      costType: "materials",
      trade: "other",
      future: false,
      productId: null,
      productQuantity: null,
      spendingCategoryId: category?.id ?? null,
    });
    const existingProduct = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Manual merge target product" }),
      ctx.actor,
    );
    const [productRow] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, existingProduct.entityId));
    if (!productRow) throw new Error("Product fixture was not created");

    const run = await startImportRunFixture(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const prepareInput = {
      _runExecution: {
        runId: run.id,
        operationId: "prepare:manual-order-1",
        itemOperationIds: ["prepare-item:manual-order-1"],
      },
      orders: [
        {
          stableOrderId: "manual-order-1",
          targetPurchaseId: targetOrderless
            ? manualPurchase.shortcode
            : undefined,
          itemOperationId: "prepare-item:manual-order-1",
          source: {
            kind: "vendor_export" as const,
            externalKey: "manual-then-import:order:1",
            checksum: checksum("5"),
          },
          evidenceChecksum: checksum("6"),
          extractionRevision: "manual-then-import@fixture-1",
          extraction: {
            status: "ready" as const,
            candidate: {
              orderId: "MANUAL-ORDER-1",
              orderedAt: "2026-09-18T12:00:00.000Z",
              merchant: "Example",
              currency: "USD",
              printedGrandTotal: 45,
              lines: includeTax
                ? [
                    {
                      title: "Manual merge target product",
                      amount: 40,
                      lineKind: "principal" as const,
                    },
                    { title: "Sales tax", amount: 5, lineKind: "tax" as const },
                  ]
                : [
                    {
                      title: "Manual merge target product",
                      amount: 45,
                      lineKind: "principal" as const,
                    },
                  ],
              payments: [],
              allShipmentsDelivered: false,
            },
          },
          lineIds: includeTax
            ? ["manual-order-1:line-1", "manual-order-1:line-2"]
            : ["manual-order-1:line-1"],
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    };
    await preparePurchaseImport(ctx.db, prepareInput, ctx.actor);

    const commitInput = commitPurchaseImportInput.parse({
      _runExecution: { runId: run.id, operationId: "commit:manual-order-1" },
      prepareOperationId: prepareInput._runExecution.operationId,
      defaultTrade: "other" as const,
      resolutions: [
        {
          stableOrderId: "manual-order-1",
          stableLineId: "manual-order-1:line-1",
          resolution: {
            kind: "existing" as const,
            productId: parseShortcodeFor("product", productRow.shortcode),
          },
        },
      ],
    });
    const result = await commitPurchaseImport(ctx.db, commitInput, ctx.actor);
    return {
      manualPurchase,
      manualExpense,
      existingProduct,
      productRow,
      category,
      result,
    };
  }

  async function replacementFinding(
    purchaseId: typeof purchase.$inferSelect.id,
  ) {
    const rows = await getDb(ctx.db)
      .select()
      .from(runFinding)
      .where(
        and(eq(runFinding.entityId, purchaseId), eq(runFinding.status, "open")),
      );
    const finding = rows.find(
      (row) =>
        proposedImportFix.safeParse(row.proposedFix).data?.kind ===
        "reconcile_source_order",
    );
    if (!finding)
      throw new Error("Expected source-order reconciliation finding");
    return finding;
  }

  it("replaces a categorized aggregate with an uncategorized tax line", async () => {
    const { manualPurchase, manualExpense, category, productRow, result } =
      await importOverManualAggregate(false, true, true);
    if (!category) throw new Error("Expected the category fixture");
    expect(result.items[0]?.outcome).toBe("conflict");
    const finding = await replacementFinding(manualPurchase.id);
    const before = await getDb(ctx.db).select().from(expense);
    const inventoryBefore = await getDb(ctx.db).select().from(inventoryEntry);
    const review = await prepareSourceOrderReconciliation(
      ctx.db,
      {
        id: finding.id,
        resolution: {
          kind: "replace_lines",
          expenseIds: [manualExpense.shortcode],
          lines: [
            {
              lineIndex: 0,
              expenseId: manualExpense.shortcode,
              productId: parseShortcodeFor("product", productRow.shortcode),
            },
            {
              lineIndex: 1,
              expenseId: manualExpense.shortcode,
              productId: null,
            },
          ],
        },
      },
      ctx.actor,
    );
    expect(review.spend).toEqual({ before: 45, after: 45, delta: 0 });
    expect(await getDb(ctx.db).select().from(expense)).toEqual(before);
    await resolveRunFinding(
      ctx.db,
      {
        id: finding.id,
        action: "apply",
        reviewedFingerprint: review.reviewedFingerprint,
      },
      ctx.actor,
    );
    const rows = await getDb(ctx.db)
      .select()
      .from(expense)
      .where(
        and(
          eq(expense.purchaseId, manualPurchase.id),
          isNull(expense.deletedAt),
        ),
      );
    expect(rows.find((row) => row.lineKind === "principal")).toMatchObject({
      id: manualExpense.id,
      cost: 40,
      spendingCategoryId: category.id,
    });
    expect(rows.find((row) => row.lineKind === "tax")).toMatchObject({
      cost: 5,
      spendingCategoryId: null,
    });
    expect(rows).toHaveLength(2);
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual(
      inventoryBefore,
    );
  });

  it.each([
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [false, false, true],
  ])(
    "keeps an exact aggregate until its unchanged replacement preview is approved (edited: %s, orderless: %s, proposal changed: %s)",
    async (editAfterPreview, targetOrderless, editProposal) => {
      const {
        manualPurchase,
        manualExpense,
        existingProduct,
        productRow,
        result,
      } = await importOverManualAggregate(targetOrderless);
      expect(result.items[0]?.outcome).toBe("conflict");
      expect(result.items[0]?.purchaseId).toBe(manualPurchase.shortcode);
      const before = await getDb(ctx.db).select().from(expense);
      expect(before).toEqual([manualExpense]);
      expect(await getDb(ctx.db).select().from(purchase)).toEqual([
        manualPurchase,
      ]);
      const stock = await getDb(ctx.db).select().from(inventoryEntry);
      const allocations = await getDb(ctx.db)
        .select()
        .from(financialTransactionAllocation);
      const finding = await replacementFinding(manualPurchase.id);
      await expect(
        resolveRunFinding(
          ctx.db,
          { id: finding.id, action: "apply" },
          ctx.actor,
        ),
      ).rejects.toThrow(/review/i);
      const review = await prepareSourceOrderReconciliation(
        ctx.db,
        {
          id: finding.id,
          resolution: {
            kind: "replace_lines",
            expenseIds: [manualExpense.shortcode],
            lines: [
              {
                lineIndex: 0,
                expenseId: manualExpense.shortcode,
                productId: parseShortcodeFor("product", productRow.shortcode),
              },
            ],
          },
        },
        ctx.actor,
      );
      expect(review.spend).toEqual({ before: 45, after: 45, delta: 0 });
      expect(await getDb(ctx.db).select().from(expense)).toEqual(before);
      if (editAfterPreview)
        await getDb(ctx.db)
          .update(expense)
          .set({ notes: "Changed after preview" })
          .where(eq(expense.id, manualExpense.id));
      if (editProposal) {
        const [stored] = await getDb(ctx.db)
          .select()
          .from(runFinding)
          .where(eq(runFinding.id, finding.id));
        const fix = proposedImportFix.parse(stored!.proposedFix);
        if (
          fix.kind !== "reconcile_source_order" ||
          !fix.proposedExtraction.candidate
        )
          throw new Error("Expected reconciliation proposal");
        await getDb(ctx.db)
          .update(runFinding)
          .set({
            proposedFix: {
              ...fix,
              proposedExtraction: {
                ...fix.proposedExtraction,
                candidate: {
                  ...fix.proposedExtraction.candidate,
                  lines: fix.proposedExtraction.candidate.lines.map((line) => ({
                    ...line,
                    title: "Different unreviewed item",
                  })),
                },
              },
            },
          })
          .where(eq(runFinding.id, finding.id));
      }
      const changed = editAfterPreview || editProposal;
      const input = {
        id: finding.id,
        action: "apply" as const,
        reviewedFingerprint: review.reviewedFingerprint,
      };
      const outcome = await resolveRunFinding(ctx.db, input, ctx.actor).then(
        () => "applied",
        (error) => (error instanceof Error ? error.message : String(error)),
      );
      expect(outcome).toMatch(
        changed ? /changed|preview|stale|again/i : /^applied$/,
      );
      expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual(stock);
      expect(
        await getDb(ctx.db).select().from(financialTransactionAllocation),
      ).toEqual(allocations);
      const live = await getDb(ctx.db)
        .select()
        .from(expense)
        .where(isNull(expense.deletedAt));
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({
        id: manualExpense.id,
        cost: 45,
        productId: changed ? null : existingProduct.entityId,
      });
      if (changed) return;
      expect(await resolveRunFinding(ctx.db, input, ctx.actor)).toMatchObject({
        status: "applied",
      });
      const after = await getDb(ctx.db)
        .select()
        .from(expense)
        .where(isNull(expense.deletedAt));
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        id: manualExpense.id,
        productId: existingProduct.entityId,
        cost: 45,
      });
      expect(await getDb(ctx.db).select().from(purchase)).toHaveLength(1);
      expect((await getDb(ctx.db).select().from(purchase))[0]?.orderId).toBe(
        "MANUAL-ORDER-1",
      );
      expect(await resolveRunFinding(ctx.db, input, ctx.actor)).toMatchObject({
        status: "applied",
      });
      expect(
        await getDb(ctx.db)
          .select()
          .from(expense)
          .where(isNull(expense.deletedAt)),
      ).toEqual(after);
      const observations = await getDb(ctx.db)
        .select()
        .from(sourceOrderObservation);
      expect(
        observations.every(
          (row) => row.extraction.candidate?.printedGrandTotal === 45,
        ),
      ).toBe(true);
      expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual(stock);
      expect(
        await getDb(ctx.db).select().from(financialTransactionAllocation),
      ).toEqual(allocations);
    },
  );

  it.each(["accepted_identity", "competing_purchase"] as const)(
    "refuses reviewed orderless identity adoption after %s changes",
    async (change) => {
      const { manualPurchase, manualExpense, productRow } =
        await importOverManualAggregate(true);
      const finding = await replacementFinding(manualPurchase.id);
      const review = await prepareSourceOrderReconciliation(
        ctx.db,
        {
          id: finding.id,
          resolution: {
            kind: "replace_lines",
            expenseIds: [manualExpense.shortcode],
            lines: [
              {
                lineIndex: 0,
                expenseId: manualExpense.shortcode,
                productId: parseShortcodeFor("product", productRow.shortcode),
              },
            ],
          },
        },
        ctx.actor,
      );
      if (change === "accepted_identity") {
        await getDb(ctx.db)
          .update(purchase)
          .set({ orderId: "DISTINCT-ACCEPTED-ORDER" })
          .where(eq(purchase.id, manualPurchase.id));
      } else {
        await insertWithShortcode(ctx.db, "purchase", {
          vendorId: manualPurchase.vendorId,
          orderId: "MANUAL-ORDER-1",
          date: "2026-09-18",
          statedTotal: 45,
        });
      }
      const before = {
        purchases: await getDb(ctx.db).select().from(purchase),
        expenses: await getDb(ctx.db).select().from(expense),
        observations: await getDb(ctx.db).select().from(sourceOrderObservation),
        stock: await getDb(ctx.db).select().from(inventoryEntry),
      };
      await expect(
        resolveRunFinding(
          ctx.db,
          {
            id: finding.id,
            action: "apply",
            reviewedFingerprint: review.reviewedFingerprint,
          },
          ctx.actor,
        ),
      ).rejects.toThrow(/changed|identity|owns|order|unique/i);
      expect(await getDb(ctx.db).select().from(purchase)).toEqual(
        before.purchases,
      );
      expect(await getDb(ctx.db).select().from(expense)).toEqual(
        before.expenses,
      );
      expect(await getDb(ctx.db).select().from(sourceOrderObservation)).toEqual(
        before.observations,
      );
      expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual(
        before.stock,
      );
    },
  );

  it("files product_unresolved for goods an applied replacement leaves unresolved", async () => {
    const { manualPurchase, manualExpense } =
      await importOverManualAggregate(false);
    const finding = await replacementFinding(manualPurchase.id);
    const review = await prepareSourceOrderReconciliation(
      ctx.db,
      {
        id: finding.id,
        resolution: {
          kind: "replace_lines",
          expenseIds: [manualExpense.shortcode],
          lines: [
            {
              lineIndex: 0,
              expenseId: manualExpense.shortcode,
              productId: null,
            },
          ],
        },
      },
      ctx.actor,
    );
    const input = {
      id: finding.id,
      action: "apply" as const,
      reviewedFingerprint: review.reviewedFingerprint,
    };
    expect(await resolveRunFinding(ctx.db, input, ctx.actor)).toMatchObject({
      status: "applied",
    });
    expect(await resolveRunFinding(ctx.db, input, ctx.actor)).toMatchObject({
      status: "applied",
    });
    const unresolved = await getDb(ctx.db)
      .select({ id: runFinding.id })
      .from(runFinding)
      .where(
        and(
          eq(runFinding.entityId, manualPurchase.id),
          eq(runFinding.kind, "product_unresolved"),
          eq(runFinding.status, "open"),
        ),
      );
    expect(unresolved).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
  });

  it("associates equivalent evidence instead of duplicating a manual Purchase whose Expense is already identified", async () => {
    const { party, vendor } = await memberImportWorld(ctx.db, ctx.actor, {
      vendor: {
        name: `Manual conflict vendor ${crypto.randomUUID()}`,
        website: "https://shop.example.test",
        browserDomains: ["shop.example.test"],
      },
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Manual conflict account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const existingProduct = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Already-identified manual product" }),
      ctx.actor,
    );
    // This member already fully recorded the order by hand: a Purchase, an
    // Expense, AND its Product — nothing here is a replaceable aggregate.
    const manualPurchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "MANUAL-ORDER-2",
      date: "2026-09-19",
      statedTotal: 18,
    });
    const manualExpense = await insertWithShortcode(ctx.db, "expense", {
      purchaseId: manualPurchase.id,
      name: "Already-identified manual product",
      cost: 18,
      date: "2026-09-19",
      lineKind: "principal",
      costType: "materials",
      trade: "other",
      future: false,
      productId: existingProduct.entityId,
      productQuantity: 1,
    });

    const run = await startImportRunFixture(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const prepareInput = {
      _runExecution: {
        runId: run.id,
        operationId: "prepare:manual-order-2",
        itemOperationIds: ["prepare-item:manual-order-2"],
      },
      orders: [
        {
          stableOrderId: "manual-order-2",
          itemOperationId: "prepare-item:manual-order-2",
          source: {
            kind: "vendor_export" as const,
            externalKey: "manual-conflict:order:1",
            checksum: checksum("7"),
          },
          evidenceChecksum: checksum("8"),
          extractionRevision: "manual-conflict@fixture-1",
          extraction: {
            status: "ready" as const,
            candidate: {
              orderId: "MANUAL-ORDER-2",
              orderedAt: "2026-09-19T12:00:00.000Z",
              merchant: "Example",
              currency: "USD",
              printedGrandTotal: 18,
              lines: [
                {
                  title: "Already-identified manual product",
                  amount: 18,
                  lineKind: "principal" as const,
                },
              ],
              payments: [],
              allShipmentsDelivered: false,
            },
          },
          lineIds: ["manual-order-2:line-1"],
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    };
    await preparePurchaseImport(ctx.db, prepareInput, ctx.actor);

    const commitInput = commitPurchaseImportInput.parse({
      _runExecution: { runId: run.id, operationId: "commit:manual-order-2" },
      prepareOperationId: prepareInput._runExecution.operationId,
      defaultTrade: "other" as const,
      resolutions: [
        {
          stableOrderId: "manual-order-2",
          stableLineId: "manual-order-2:line-1",
          resolution: {
            kind: "existing" as const,
            productId: (
              await getDb(ctx.db)
                .select({ shortcode: product.shortcode })
                .from(product)
                .where(eq(product.id, existingProduct.entityId))
            )[0]!.shortcode,
          },
        },
      ],
    });
    const result = await commitPurchaseImport(ctx.db, commitInput, ctx.actor);
    expect(result.items[0]?.outcome).toBe("updated");
    expect(result.items[0]?.findingCount).toBe(0);

    const replayRun = await startImportRunFixture(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    const replayPreparation = {
      ...prepareInput,
      _runExecution: {
        runId: replayRun.id,
        operationId: "prepare:manual-order-2-replay",
        itemOperationIds: ["prepare-item:manual-order-2-replay"],
      },
      orders: prepareInput.orders.map((order) => ({
        ...order,
        itemOperationId: "prepare-item:manual-order-2-replay",
      })),
    };
    await preparePurchaseImport(ctx.db, replayPreparation, ctx.actor);
    const replay = await commitPurchaseImport(
      ctx.db,
      {
        ...commitInput,
        _runExecution: {
          runId: replayRun.id,
          operationId: "commit:manual-order-2-replay",
        },
        prepareOperationId: replayPreparation._runExecution.operationId,
      },
      ctx.actor,
    );
    expect(replay.items[0]).toMatchObject({
      outcome: "replayed",
      findingCount: 0,
    });

    const purchasesForOrder = await getDb(ctx.db)
      .select({ id: purchase.id })
      .from(purchase)
      .where(eq(purchase.orderId, "MANUAL-ORDER-2"));
    expect(purchasesForOrder).toHaveLength(1);

    const liveExpenses = await getDb(ctx.db)
      .select({ id: expense.id })
      .from(expense)
      .where(
        and(
          eq(expense.purchaseId, manualPurchase.id),
          isNull(expense.deletedAt),
        ),
      );
    // No second Expense was created, and the original manual line survives
    // untouched.
    expect(liveExpenses).toEqual([{ id: manualExpense.id }]);

    const findings = await getDb(ctx.db)
      .select({ kind: runFinding.kind })
      .from(runFinding)
      .where(eq(runFinding.entityId, manualPurchase.id));
    expect(findings).toEqual([]);
  });
});
