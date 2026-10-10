import {
  parseEntityId,
  type LedgerPartyId,
  type VendorId,
} from "@cubby/schemas/identifiers";
import type { ExtractedOrderCandidate } from "@cubby/schemas/purchase-import";
import { testShortcode } from "@cubby/schemas/testing";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  entityAttachment,
  expense,
  importSourceClaim,
  importSourceOrder,
  inventoryEntry,
  mailboxMessage,
  orderMail,
  orderMailAttachment,
  orderMailCandidateDecision,
  orderMailEvent,
  productCategory,
  project,
  purchase,
  purchasePaymentEvidence,
  run,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { effectiveExpenseTradeSql } from "~/server/repo/expense-inheritance";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { commitPurchaseImport, preparePurchaseImport } from "./import-orders";
import { resolveMail } from "./mail-tool";
import {
  mailSource,
  memberImport,
  prepareMemberImport,
  retainedMailFixture,
} from "./order-import.fixtures";

const mailboxId = "synthetic-mailbox";

// Caller-driven import: a member (or Pi) prepares and commits from a retained
// Email through the public writers, Email dispositions are recorded through
// `mail.resolve`, and nothing launches unattended Product research.
describe("caller-driven purchase import", () => {
  const ctx = withTestDb();

  async function fixture() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Caller import member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic garden shop",
      website: "https://shop.example",
    });
    return { party, vendor };
  }

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
    const { party, vendor } = await fixture();
    const mail = await retainedMail(
      party.id,
      "confirmation-1",
      "Order SYN-100 confirmed: Synthetic trowel $18.50",
      "a",
    );
    const prepared = await preparePurchaseImport(
      ctx.db,
      {
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
      },
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
    return { party, vendor, mail, prepared, commitInput, committed };
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
      .select({ status: mailboxMessage.status })
      .from(mailboxMessage)
      .where(eq(mailboxMessage.messageId, mail.messageId));
    expect(message?.status).toBe("completed");
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
        purchaseId,
        event: "shipped" as const,
      },
    };
    const first = await resolveMail(ctx.db, input, ctx.actor);
    const replay = await resolveMail(ctx.db, input, ctx.actor);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ status: "completed", purchaseId });

    const events = await getDb(ctx.db)
      .select({ event: orderMailEvent.event })
      .from(orderMailEvent)
      .where(eq(orderMailEvent.orderMailId, shipment.id));
    expect(events).toEqual([{ event: "shipped" }]);
    expect(
      await getDb(ctx.db).select({ id: expense.id }).from(expense),
    ).toEqual(expensesBefore);
  });

  it("refuses a changed Email and disposes of an unrelated one", async () => {
    const { party } = await fixture();
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
    expect(resolved).toMatchObject({ status: "completed", purchaseId: null });
    // No readable copy of unrelated mail survives the disposition.
    expect(
      await getDb(ctx.db)
        .select({ id: orderMail.id })
        .from(orderMail)
        .where(eq(orderMail.id, newsletter.id)),
    ).toEqual([]);
    const [message] = await getDb(ctx.db)
      .select({
        classification: mailboxMessage.classification,
        orderMailId: mailboxMessage.orderMailId,
      })
      .from(mailboxMessage)
      .where(
        and(
          eq(mailboxMessage.mailboxId, mailboxId),
          eq(mailboxMessage.messageId, newsletter.messageId),
        ),
      );
    expect(message).toEqual({ classification: "unrelated", orderMailId: null });
  });
});

// Ported write-boundary regressions through the member's prepare/commit:
// a Purchase-wide fallback replaces member purpose; an identified incomplete
// order invents spend; a mail import overrides a member's dismissal, links or
// attaches another Email's order, or loses a refund's money.
describe("caller-driven purchase import writes", () => {
  const ctx = withTestDb();

  async function scope() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Caller write member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic service merchant",
    });
    return { party, vendor };
  }

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
  it("fills unassigned imported lines after resolving Product purpose inheritance", async () => {
    const { vendor } = await scope();
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

  it("imports a supported receipt without inventing purpose or replacing member attribution", async () => {
    const { vendor } = await scope();
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
      const { vendor } = await scope();
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
      const { vendor } = await scope();
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
    const { party, vendor } = await scope();
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
            purchaseId: existing.shortcode,
            event: "refunded",
          },
        },
        ctx.actor,
      ),
    ).resolves.toMatchObject({ purchaseId: existing.shortcode });
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
    const { party, vendor } = await scope();
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
            purchaseId: existing.shortcode,
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
    const { party, vendor } = await scope();
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
    const { party, vendor } = await scope();
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

  it("records the shipping event when its Email creates the Purchase first", async () => {
    const { party, vendor } = await scope();
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
