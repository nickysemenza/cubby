/**
 * Gmail order-mail permutations against real PostgreSQL.
 *
 * Failure modes these scenarios guard:
 * - a statement charge never becomes a hunt the mail pipeline can see, or the
 *   hunt leaves `pending_mail` before mail can name its order;
 * - an order mail matches a hunt of the opposite direction because amounts
 *   are compared by absolute value (a refund resolving a charge hunt, or an
 *   order confirmation resolving a statement credit);
 * - combined-charge subset matching sums refund events into a charge;
 * - order mail processed before its statement charge never resolves the
 *   charge's later hunt, or an unmatched hunt goes to the browser before the
 *   next mail sync could resolve it;
 * - a second, equal partial refund is dropped because one is already booked;
 * - order mail and order history arriving in either order leave two
 *   Purchases, a lost PDF, or a duplicated attachment.
 *
 * Only the external seams are faked, through the pipeline's ports: the mail
 * classifier (a model call) and object storage.
 */
import { parseEntityId } from "@cubby/schemas/identifiers";
import type {
  OrderMailClassification,
  OrderMailMessageClassification,
} from "@cubby/schemas/purchase-import";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { testUserId } from "@cubby/schemas/testing";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";

import {
  entityAttachment,
  runFinding,
  importHunt,
  merchantVendorRule,
  orderMail,
  orderMailAttachment,
  orderMailEvent,
  vendor,
  vendorAccount,
  user,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import {
  createImageStorageService,
  productionImageStoragePorts,
} from "~/server/services/image-storage.service";

import { resolveRunFinding } from "../findings";
import {
  discoverImportHunts,
  dispatchImportHunts,
  MAIL_GRACE_MS,
} from "../hunts";
import {
  importOrderHistory,
  liveExpenseCents,
  purchasesForOrder,
} from "../order-import.fixtures";
import { type OrderMailPorts, processOrderMails } from "./process";
import { decideOrderMailCandidate, listVendorOrderMail } from "./review";

const classifications = new Map<string, OrderMailMessageClassification>();
const uploadedKeys: string[] = [];
const storage = createImageStorageService({
  ...productionImageStoragePorts,
  objectStorage: {
    ...productionImageStoragePorts.objectStorage,
    upload: async ({ key }) => {
      uploadedKeys.push(key);
    },
    deleteObject: async () => undefined,
    getPublicUrl: (key) => `https://images.example.test/${key}`,
  },
});
const ports: OrderMailPorts = {
  classify: async ({ messageId }) => {
    const classification = classifications.get(messageId);
    if (!classification)
      throw new Error(`test setup: no classification for ${messageId}`);
    return classification;
  },
  attachFile: storage.attachFileToEntity,
};

const SENDER = "ForgeWear <orders@forgewear.example>";
const PDF_BASE64URL = Buffer.from("%PDF-1.4 synthetic invoice").toString(
  "base64url",
);

describe("Gmail order mail processing", () => {
  const ctx = withTestDb();

  beforeEach(() => {
    classifications.clear();
    uploadedKeys.length = 0;
  });

  async function seedForgeWear() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Mail pipeline member",
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
      label: "ForgeWear account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const card = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Synthetic card",
      identity: { kind: "credit_card", issuer: null, network: "visa" },
      ledgerPartyId: party.id,
    });
    await getDb(ctx.db).insert(merchantVendorRule).values({
      ledgerPartyId: party.id,
      normalizedMerchant: "forgewear online",
      vendorId: vendor.id,
      confirmedByUserId: ctx.actor.userId,
    });
    return { party, vendor, account, card };
  }

  it("keeps a non-order message id without placing the message in the review worklist", async () => {
    const seed = await seedForgeWear();
    await receiveMail(
      seed,
      "synthetic-newsletter",
      "2026-09-10T15:00:00.000Z",
      {
        events: [],
      },
    );
    const saved = await getDb(ctx.db)
      .select({
        id: orderMail.id,
        rawChecksum: orderMail.rawChecksum,
        classifiedChecksum: orderMail.classifiedChecksum,
      })
      .from(orderMail)
      .where(eq(orderMail.messageId, "synthetic-newsletter"));
    expect(saved).toHaveLength(1);
    const savedMail = saved[0];
    if (!savedMail) throw new Error("test setup: missing saved newsletter");
    expect(savedMail.classifiedChecksum).toBe(savedMail.rawChecksum);
    await getDb(ctx.db).insert(orderMailEvent).values({
      orderMailId: savedMail.id,
      event: "other",
      orderId: null,
      amount: null,
      sourceKey: "classified:legacy-newsletter:0",
    });
    expect(
      (await listVendorOrderMail(ctx.db, { vendorId: seed.vendor.shortcode }))
        .items,
    ).toEqual([]);
  });

  type Seed = Awaited<ReturnType<typeof seedForgeWear>>;

  /** A posted statement row: charges are positive, credits negative. */
  const statementRow = (seed: Seed, amount: number, date: string) =>
    insertWithShortcode(ctx.db, "financialTransaction", {
      accountId: seed.card.id,
      kind: amount > 0 ? "purchase" : "refund",
      status: "posted",
      amount,
      merchant: "FORGEWEAR   Online",
      transactionDate: date,
      postedDate: date,
    });

  async function receiveMail(
    seed: Seed,
    messageId: string,
    receivedAt: string,
    classification: OrderMailClassification | OrderMailMessageClassification,
    options: { pdf?: boolean; rawChecksum?: string; sender?: string } = {},
  ) {
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: seed.party.id,
        messageId,
        sender: options.sender ?? SENDER,
        subject: "ForgeWear order update",
        receivedAt: new Date(receivedAt),
        rawChecksum: options.rawChecksum ?? `raw-${messageId}`,
      })
      .returning({ id: orderMail.id });
    if (!mail) throw new Error("test setup: order mail not inserted");
    if (options.pdf) {
      await getDb(ctx.db)
        .insert(orderMailAttachment)
        .values({
          orderMailId: mail.id,
          providerAttachmentId: `att-${messageId}`,
          filename: "invoice.pdf",
          mimeType: "application/pdf",
          checksum: `sum-${messageId}`,
          pendingDataBase64Url: PDF_BASE64URL,
        });
    }
    classifications.set(
      messageId,
      "events" in classification
        ? classification
        : { events: [classification] },
    );
    return processOrderMails(ctx.db, [messageId], [], ports);
  }

  const huntFor = async (financialTransactionId: string) => {
    const [row] = await getDb(ctx.db)
      .select({
        state: importHunt.state,
        matchedOrderIds: importHunt.matchedOrderIds,
        attempts: importHunt.attempts,
      })
      .from(importHunt)
      .where(
        eq(
          importHunt.financialTransactionId,
          parseEntityId("financialTransaction", financialTransactionId),
        ),
      );
    if (!row) throw new Error("test assertion: hunt was not discovered");
    return row;
  };

  const placed = (
    orderId: string,
    amount: number,
    occurredAt: string,
  ): OrderMailClassification => ({
    event: "placed",
    orderId,
    amount,
    currency: "USD",
    occurredAt,
  });
  const refunded = (
    orderId: string,
    amount: number,
    occurredAt: string,
  ): OrderMailClassification => ({
    event: "refunded",
    orderId,
    amount,
    currency: "USD",
    occurredAt,
  });

  it("does not trust a matching address shown only in the sender display name", async () => {
    const seed = await seedForgeWear();
    await receiveMail(
      seed,
      "spoofed-display",
      "2026-08-16T12:00:00Z",
      {
        event: "placed",
        orderId: "FW-FAKE",
        amount: 42.5,
        currency: "USD",
        occurredAt: null,
      },
      { sender: "orders@forgewear.example <stranger@other.example>" },
    );
    const [mail] = await getDb(ctx.db)
      .select({ vendorId: orderMail.vendorId })
      .from(orderMail)
      .where(eq(orderMail.messageId, "spoofed-display"));
    expect(mail?.vendorId).toBeNull();
  });

  it("matches a website-domain sender when no receipt address was configured", async () => {
    const seed = await seedForgeWear();
    await getDb(ctx.db)
      .update(vendor)
      .set({ orderEmailSenders: [] })
      .where(eq(vendor.id, seed.vendor.id));
    await receiveMail(
      seed,
      "website-domain-sender",
      "2026-09-12T12:00:00Z",
      placed("FW-SYN-3101", 25, "2026-09-12T12:00:00Z"),
      { sender: "Updates <receipt@notify.forgewear.example>" },
    );
    const [mail] = await getDb(ctx.db)
      .select({ vendorId: orderMail.vendorId })
      .from(orderMail)
      .where(eq(orderMail.messageId, "website-domain-sender"));
    expect(mail?.vendorId).toBe(seed.vendor.id);
  });

  it("prefers an exact configured sender over another Vendor on the same website domain", async () => {
    const seed = await seedForgeWear();
    await insertWithShortcode(ctx.db, "vendor", {
      name: "ForgeWear Outlet",
      website: "https://outlet.forgewear.example",
    });
    await receiveMail(
      seed,
      "shared-domain-exact-sender",
      "2026-09-12T12:00:00Z",
      placed("FW-SYN-3102", 25, "2026-09-12T12:00:00Z"),
    );
    const [mail] = await getDb(ctx.db)
      .select({ vendorId: orderMail.vendorId })
      .from(orderMail)
      .where(eq(orderMail.messageId, "shared-domain-exact-sender"));
    expect(mail?.vendorId).toBe(seed.vendor.id);
  });

  it("leaves an unscoped Purchase for review when more than one member has this Vendor", async () => {
    const seed = await seedForgeWear();
    const otherUserId = testUserId("other-mail-member");
    await getDb(ctx.db).insert(user).values({
      id: otherUserId,
      name: "Other synthetic member",
      email: "other-mail-member@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const otherParty = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Other synthetic member",
      kind: "member",
      userId: otherUserId,
    });
    await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Other ForgeWear account",
      vendorId: seed.vendor.id,
      ledgerPartyId: otherParty.id,
    });
    const target = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: seed.vendor.id,
      orderId: "FW-UNSCOPED-1001",
      date: "2026-08-16",
      statedTotal: 42.5,
    });
    await receiveMail(
      seed,
      "ambiguous-member-mail",
      "2026-08-16T12:00:00Z",
      {
        event: "placed",
        orderId: "FW-UNSCOPED-1001",
        amount: 42.5,
        currency: "USD",
        occurredAt: null,
      },
      { pdf: true },
    );
    const attachments = await getDb(ctx.db)
      .select({ id: entityAttachment.id })
      .from(entityAttachment)
      .where(eq(entityAttachment.entityId, target.id));
    expect(attachments).toEqual([]);
  });

  it("records separate order events when one message covers multiple orders", async () => {
    const seed = await seedForgeWear();
    const first = placed("FW-SYN-2001", 31, "2026-09-10T15:00:00.000Z");
    const second = placed("FW-SYN-2002", 42, "2026-09-10T15:00:00.000Z");
    const multiOrderMail = Object.assign({}, first, {
      events: [{ ...first }, { ...second }],
    });

    await receiveMail(
      seed,
      "msg-two-orders",
      "2026-09-10T15:00:00.000Z",
      multiOrderMail,
    );

    const events = await getDb(ctx.db)
      .select({ orderId: orderMailEvent.orderId })
      .from(orderMailEvent);
    expect(events.map((event) => event.orderId).sort()).toEqual([
      "FW-SYN-2001",
      "FW-SYN-2002",
    ]);
  });

  it("creates one mail-only Vendor account for verified orders without a browser login", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Mail-first member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Mail First Outfitters",
      orderEmailSenders: ["orders@forgewear.example"],
    });
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: party.id,
        messageId: "mail-first-order",
        sender: SENDER,
        subject: "Your order",
        receivedAt: new Date("2026-09-10T15:00:00.000Z"),
        rawChecksum: "mail-first-checksum",
      })
      .returning({ id: orderMail.id });
    if (!mail) throw new Error("test setup: mail not inserted");
    classifications.set("mail-first-order", {
      events: [placed("FW-SYN-3001", 25, "2026-09-10T15:00:00.000Z")],
    });

    await processOrderMails(ctx.db, ["mail-first-order"], [], ports);
    await processOrderMails(ctx.db, ["mail-first-order"], [], ports);

    const accounts = await getDb(ctx.db)
      .select({
        vendorId: vendorAccount.vendorId,
        ledgerPartyId: vendorAccount.ledgerPartyId,
        status: vendorAccount.status,
        browserSyncEnabled: vendorAccount.browserSyncEnabled,
      })
      .from(vendorAccount);
    expect(accounts).toEqual([
      {
        vendorId: vendor.id,
        ledgerPartyId: party.id,
        status: "disabled",
        browserSyncEnabled: false,
      },
    ]);
  });

  it("does not attach a replayed PDF after an exact mail match was dismissed", async () => {
    const seed = await seedForgeWear();
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: seed.vendor.id,
      vendorAccountId: seed.account.id,
      orderId: "FW-SYN-4001",
      date: "2026-09-10",
      statedTotal: 54,
    });
    await receiveMail(
      seed,
      "msg-dismissed-pdf",
      "2026-09-10T15:00:00.000Z",
      placed("FW-SYN-4001", 54, "2026-09-10T15:00:00.000Z"),
    );
    const [event] = await getDb(ctx.db)
      .select({ id: orderMailEvent.id })
      .from(orderMailEvent);
    if (!event) throw new Error("test setup: classified event missing");
    await decideOrderMailCandidate(
      ctx.db,
      {
        eventId: event.id,
        purchaseId: purchase.shortcode,
        decision: "dismissed",
        evidenceChecksum: "raw-msg-dismissed-pdf",
      },
      ctx.actor,
    );
    const [mail] = await getDb(ctx.db)
      .select({ id: orderMail.id })
      .from(orderMail);
    if (!mail) throw new Error("test setup: mail missing");
    await getDb(ctx.db).insert(orderMailAttachment).values({
      orderMailId: mail.id,
      providerAttachmentId: "att-dismissed",
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      checksum: "pdf-dismissed",
      pendingDataBase64Url: PDF_BASE64URL,
    });

    await processOrderMails(ctx.db, ["msg-dismissed-pdf"], [], ports);

    const [attachment] = await getDb(ctx.db)
      .select({ imageId: orderMailAttachment.imageId })
      .from(orderMailAttachment);
    expect(attachment?.imageId).toBeNull();
  });

  it("supersedes classified events when the same message content changes", async () => {
    const seed = await seedForgeWear();
    await receiveMail(
      seed,
      "msg-revised",
      "2026-09-10T15:00:00.000Z",
      placed("FW-SYN-5001", 31, "2026-09-10T15:00:00.000Z"),
      { rawChecksum: "checksum-before" },
    );
    await getDb(ctx.db)
      .update(orderMail)
      .set({ rawChecksum: "checksum-after" });
    classifications.set("msg-revised", {
      events: [placed("FW-SYN-5002", 42, "2026-09-10T15:00:00.000Z")],
    });

    await processOrderMails(ctx.db, ["msg-revised"], [], ports);

    const events = await getDb(ctx.db)
      .select({
        orderId: orderMailEvent.orderId,
        supersededAt: orderMailEvent.supersededAt,
      })
      .from(orderMailEvent);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          orderId: "FW-SYN-5001",
          supersededAt: expect.any(Date),
        }),
        { orderId: "FW-SYN-5002", supersededAt: null },
      ]),
    );
  });

  it("matches a statement charge's hunt to the order confirmation and hands the order id to browser dispatch", async () => {
    const seed = await seedForgeWear();
    const charge = await statementRow(seed, 64.25, "2026-09-10");

    await expect(discoverImportHunts(ctx.db)).resolves.toBe(1);
    // Replay-safe discovery: the same statement row never opens a second hunt.
    await expect(discoverImportHunts(ctx.db)).resolves.toBe(0);
    expect(await huntFor(charge.id)).toMatchObject({
      state: "pending_mail",
      matchedOrderIds: [],
    });

    // A different-amount confirmation inside the window is not this charge.
    await receiveMail(
      seed,
      "msg-other-amount",
      "2026-09-09T15:00:00.000Z",
      placed("FW-SYN-0999", 12.5, "2026-09-09T15:00:00.000Z"),
    );
    expect((await huntFor(charge.id)).state).toBe("pending_mail");

    await receiveMail(
      seed,
      "msg-confirmation",
      "2026-09-10T15:00:00.000Z",
      placed("FW-SYN-1001", 64.25, "2026-09-10T15:00:00.000Z"),
    );
    expect(await huntFor(charge.id)).toMatchObject({
      state: "pending_browser",
      matchedOrderIds: ["FW-SYN-1001"],
    });

    const sent: PurchaseAgentEvent[] = [];
    await expect(
      dispatchImportHunts(ctx.db, {
        send: async (event) => {
          sent.push(event);
        },
      }),
    ).resolves.toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe("start_or_resume");
    expect(await huntFor(charge.id)).toMatchObject({
      state: "browser_queued",
      matchedOrderIds: ["FW-SYN-1001"],
      attempts: 1,
    });
  });

  it("never matches a refund mail to a charge hunt, or an order confirmation to a statement credit", async () => {
    const seed = await seedForgeWear();
    const charge = await statementRow(seed, 42, "2026-09-10");
    const credit = await statementRow(seed, -18.5, "2026-09-10");
    await discoverImportHunts(ctx.db);

    // A refund for an older order, same absolute amount as the new charge.
    await receiveMail(
      seed,
      "msg-old-refund",
      "2026-09-11T09:00:00.000Z",
      refunded("FW-SYN-0500", 42, "2026-09-11T09:00:00.000Z"),
    );
    expect(await huntFor(charge.id)).toMatchObject({
      state: "pending_mail",
      matchedOrderIds: [],
    });

    // An order confirmation with the credit's absolute amount.
    await receiveMail(
      seed,
      "msg-small-order",
      "2026-09-11T10:00:00.000Z",
      placed("FW-SYN-0600", 18.5, "2026-09-11T10:00:00.000Z"),
    );
    expect(await huntFor(credit.id)).toMatchObject({
      state: "pending_mail",
      matchedOrderIds: [],
    });

    // The right-direction mails still resolve their own hunts.
    await receiveMail(
      seed,
      "msg-new-order",
      "2026-09-10T12:00:00.000Z",
      placed("FW-SYN-0700", 42, "2026-09-10T12:00:00.000Z"),
    );
    await receiveMail(
      seed,
      "msg-credit-refund",
      "2026-09-11T12:00:00.000Z",
      refunded("FW-SYN-0400", 18.5, "2026-09-11T12:00:00.000Z"),
    );
    expect(await huntFor(charge.id)).toMatchObject({
      state: "pending_browser",
      matchedOrderIds: ["FW-SYN-0700"],
    });
    expect(await huntFor(credit.id)).toMatchObject({
      state: "pending_browser",
      matchedOrderIds: ["FW-SYN-0400"],
    });
  });

  it("does not sum a refund into a combined-charge subset", async () => {
    const seed = await seedForgeWear();
    const charge = await statementRow(seed, 30, "2026-09-10");
    await discoverImportHunts(ctx.db);

    await receiveMail(
      seed,
      "msg-order-a",
      "2026-09-10T08:00:00.000Z",
      placed("FW-SYN-0801", 20, "2026-09-10T08:00:00.000Z"),
    );
    // 20 charged + 10 refunded is not a 30 charge.
    await receiveMail(
      seed,
      "msg-refund-b",
      "2026-09-10T09:00:00.000Z",
      refunded("FW-SYN-0802", 10, "2026-09-10T09:00:00.000Z"),
    );
    expect(await huntFor(charge.id)).toMatchObject({
      state: "pending_mail",
      matchedOrderIds: [],
    });

    // A second real order completes the combined charge.
    await receiveMail(
      seed,
      "msg-order-c",
      "2026-09-10T10:00:00.000Z",
      placed("FW-SYN-0803", 10, "2026-09-10T10:00:00.000Z"),
    );
    const hunt = await huntFor(charge.id);
    expect(hunt.state).toBe("pending_browser");
    expect([...hunt.matchedOrderIds].sort()).toEqual([
      "FW-SYN-0801",
      "FW-SYN-0803",
    ]);
  });

  // Regression: confirmation mail usually arrives days before the statement
  // charge, so the mail path found no hunt and every hunt fell to the browser.
  it("matches a new hunt to order mail processed before the statement charge", async () => {
    const seed = await seedForgeWear();
    await receiveMail(
      seed,
      "msg-early-confirmation",
      "2026-09-08T15:00:00.000Z",
      placed("FW-SYN-4001", 51.75, "2026-09-08T15:00:00.000Z"),
    );
    // Outside the charge's ±7 day window, same amount.
    await receiveMail(
      seed,
      "msg-stale-confirmation",
      "2026-08-20T15:00:00.000Z",
      placed("FW-SYN-3999", 51.75, "2026-08-20T15:00:00.000Z"),
    );
    // Combined charge: two earlier orders that only together equal it.
    await receiveMail(
      seed,
      "msg-combined-a",
      "2026-09-09T10:00:00.000Z",
      placed("FW-SYN-4101", 12, "2026-09-09T10:00:00.000Z"),
    );
    await receiveMail(
      seed,
      "msg-combined-b",
      "2026-09-09T11:00:00.000Z",
      placed("FW-SYN-4102", 7.5, "2026-09-09T11:00:00.000Z"),
    );
    const charge = await statementRow(seed, 51.75, "2026-09-12");
    const combined = await statementRow(seed, 19.5, "2026-09-12");
    const unmatched = await statementRow(seed, 99, "2026-09-12");

    await expect(discoverImportHunts(ctx.db)).resolves.toBe(3);
    expect(await huntFor(charge.id)).toMatchObject({
      state: "pending_browser",
      matchedOrderIds: ["FW-SYN-4001"],
    });
    const combinedHunt = await huntFor(combined.id);
    expect(combinedHunt.state).toBe("pending_browser");
    expect([...combinedHunt.matchedOrderIds].sort()).toEqual([
      "FW-SYN-4101",
      "FW-SYN-4102",
    ]);
    expect(await huntFor(unmatched.id)).toMatchObject({
      state: "pending_mail",
      matchedOrderIds: [],
    });
  });

  it("never matches earlier refund mail to a new charge hunt", async () => {
    const seed = await seedForgeWear();
    await receiveMail(
      seed,
      "msg-earlier-refund",
      "2026-09-09T09:00:00.000Z",
      refunded("FW-SYN-4201", 33, "2026-09-09T09:00:00.000Z"),
    );
    const charge = await statementRow(seed, 33, "2026-09-10");
    const credit = await statementRow(seed, -33, "2026-09-10");

    await discoverImportHunts(ctx.db);
    expect(await huntFor(charge.id)).toMatchObject({
      state: "pending_mail",
      matchedOrderIds: [],
    });
    expect(await huntFor(credit.id)).toMatchObject({
      state: "pending_browser",
      matchedOrderIds: ["FW-SYN-4201"],
    });
  });

  it("holds an unmatched hunt for the mail grace window before browser dispatch", async () => {
    const seed = await seedForgeWear();
    const charge = await statementRow(seed, 27, "2026-09-10");
    await discoverImportHunts(ctx.db);
    const sent: PurchaseAgentEvent[] = [];
    const queue = {
      send: async (event: PurchaseAgentEvent) => {
        sent.push(event);
      },
    };
    const now = Date.now();

    await expect(dispatchImportHunts(ctx.db, queue)).resolves.toBe(0);
    await expect(
      dispatchImportHunts(
        ctx.db,
        queue,
        new Date(now + MAIL_GRACE_MS - 60_000),
      ),
    ).resolves.toBe(0);
    expect(sent).toHaveLength(0);
    expect((await huntFor(charge.id)).state).toBe("pending_mail");

    await expect(
      dispatchImportHunts(
        ctx.db,
        queue,
        new Date(now + MAIL_GRACE_MS + 60_000),
      ),
    ).resolves.toBe(1);
    expect(sent).toHaveLength(1);
    expect(await huntFor(charge.id)).toMatchObject({
      state: "browser_queued",
      attempts: 1,
    });
  });

  it("files a refund finding for a second equal partial refund after the first is booked", async () => {
    const seed = await seedForgeWear();
    const imported = await importOrderHistory(ctx.db, ctx.actor, {
      ledgerPartyId: seed.party.id,
      vendorAccountId: seed.account.id,
      orderId: "FW-SYN-2001",
      orderedAt: "2026-09-01T12:00:00.000Z",
      lines: [
        { title: "Canvas work apron", amount: 30 },
        { title: "Leather gloves", amount: 20 },
      ],
      revision: "a",
    });
    const [target] = await purchasesForOrder(ctx.db, "FW-SYN-2001");
    if (!imported?.purchaseId || !target)
      throw new Error("test setup: history import wrote no Purchase");

    const refundFindings = () =>
      getDb(ctx.db)
        .select({ id: runFinding.id, status: runFinding.status })
        .from(runFinding)
        .where(
          and(
            eq(runFinding.entityId, target.id),
            eq(runFinding.kind, "refund_unbooked"),
          ),
        );

    await receiveMail(
      seed,
      "msg-refund-1",
      "2026-09-05T12:00:00.000Z",
      refunded("FW-SYN-2001", 10, "2026-09-05T12:00:00.000Z"),
    );
    const [first] = await refundFindings();
    if (!first) throw new Error("test assertion: first refund not filed");
    await resolveRunFinding(
      ctx.db,
      { id: first.id, action: "apply" },
      ctx.actor,
    );
    expect(await liveExpenseCents(ctx.db, target.id)).toEqual([
      -1000, 2000, 3000,
    ]);

    // Same amount, different refund mail: a second partial refund, not a replay.
    await receiveMail(
      seed,
      "msg-refund-2",
      "2026-09-06T12:00:00.000Z",
      refunded("FW-SYN-2001", 10, "2026-09-06T12:00:00.000Z"),
    );
    const second = (await refundFindings()).find(
      (row) => row.status === "open",
    );
    if (!second) throw new Error("test assertion: second refund not filed");
    await resolveRunFinding(
      ctx.db,
      { id: second.id, action: "apply" },
      ctx.actor,
    );
    expect(await liveExpenseCents(ctx.db, target.id)).toEqual([
      -1000, -1000, 2000, 3000,
    ]);

    // Replaying the first refund mail is still a no-op.
    await processOrderMails(ctx.db, ["msg-refund-1"], [], ports);
    expect(await refundFindings()).toHaveLength(2);
  });

  // Regression: counting refund mails by row let a resent copy of one refund
  // notice book the refund twice. Two different notices of the same amount
  // are still filed, since mail alone cannot tell them from two refunds, but
  // the finding tells the reviewer.
  it("counts a resent refund notice once and flags a second same-amount notice", async () => {
    const seed = await seedForgeWear();
    await importOrderHistory(ctx.db, ctx.actor, {
      ledgerPartyId: seed.party.id,
      vendorAccountId: seed.account.id,
      orderId: "FW-SYN-2002",
      orderedAt: "2026-09-01T12:00:00.000Z",
      lines: [{ title: "Canvas work apron", amount: 30 }],
      revision: "a",
    });
    const [target] = await purchasesForOrder(ctx.db, "FW-SYN-2002");
    if (!target)
      throw new Error("test setup: history import wrote no Purchase");
    const refundFindings = () =>
      getDb(ctx.db)
        .select({
          id: runFinding.id,
          status: runFinding.status,
          summary: runFinding.summary,
        })
        .from(runFinding)
        .where(
          and(
            eq(runFinding.entityId, target.id),
            eq(runFinding.kind, "refund_unbooked"),
          ),
        );

    await receiveMail(
      seed,
      "msg-notice-1",
      "2026-09-05T12:00:00.000Z",
      refunded("FW-SYN-2002", 10, "2026-09-05T12:00:00.000Z"),
    );
    const [first] = await refundFindings();
    if (!first) throw new Error("test assertion: refund not filed");
    expect(first.summary).not.toMatch(/same amount/);
    await resolveRunFinding(
      ctx.db,
      { id: first.id, action: "apply" },
      ctx.actor,
    );

    await receiveMail(
      seed,
      "msg-notice-1-resent",
      "2026-09-05T13:00:00.000Z",
      refunded("FW-SYN-2002", 10, "2026-09-05T12:00:00.000Z"),
      { rawChecksum: "raw-msg-notice-1" },
    );
    expect(await refundFindings()).toHaveLength(1);

    await receiveMail(
      seed,
      "msg-notice-2",
      "2026-09-07T12:00:00.000Z",
      refunded("FW-SYN-2002", 10, "2026-09-07T12:00:00.000Z"),
    );
    const second = (await refundFindings()).find(
      (row) => row.status === "open",
    );
    expect(second?.summary).toMatch(/same amount as another refund/);
    expect(await liveExpenseCents(ctx.db, target.id)).toEqual([-1000, 3000]);
  });

  it("converges mail-first and history-first arrivals on one Purchase with the mail PDF attached once", async () => {
    const seed = await seedForgeWear();
    const attachmentsOn = (purchaseId: string) =>
      getDb(ctx.db)
        .select({ imageId: entityAttachment.imageId })
        .from(entityAttachment)
        .where(
          and(
            eq(entityAttachment.entityId, purchaseId),
            notDeleted(entityAttachment),
          ),
        );
    const pendingMailPdfs = () =>
      getDb(ctx.db)
        .select({
          imageId: orderMailAttachment.imageId,
          pending: orderMailAttachment.pendingDataBase64Url,
        })
        .from(orderMailAttachment);

    // Mail first: nothing to attach to yet, so the PDF stays pending.
    await receiveMail(
      seed,
      "msg-mail-first",
      "2026-09-02T12:00:00.000Z",
      placed("FW-SYN-3001", 25, "2026-09-02T12:00:00.000Z"),
      { pdf: true },
    );
    expect(await purchasesForOrder(ctx.db, "FW-SYN-3001")).toHaveLength(0);
    expect(await pendingMailPdfs()).toEqual([
      { imageId: null, pending: PDF_BASE64URL },
    ]);
    await importOrderHistory(
      ctx.db,
      ctx.actor,
      {
        ledgerPartyId: seed.party.id,
        vendorAccountId: seed.account.id,
        orderId: "FW-SYN-3001",
        orderedAt: "2026-09-02T12:00:00.000Z",
        lines: [{ title: "Wool beanie", amount: 25 }],
        revision: "b",
      },
      storage.attachFileToEntity,
    );
    const mailFirst = await purchasesForOrder(ctx.db, "FW-SYN-3001");
    expect(mailFirst).toHaveLength(1);
    expect(await attachmentsOn(mailFirst[0]!.id)).toHaveLength(1);

    // History first: the Purchase exists, so the mail attaches immediately.
    await importOrderHistory(ctx.db, ctx.actor, {
      ledgerPartyId: seed.party.id,
      vendorAccountId: seed.account.id,
      orderId: "FW-SYN-3002",
      orderedAt: "2026-09-03T12:00:00.000Z",
      lines: [{ title: "Denim chore coat", amount: 88 }],
      revision: "c",
    });
    await receiveMail(
      seed,
      "msg-history-first",
      "2026-09-03T12:00:00.000Z",
      placed("FW-SYN-3002", 88, "2026-09-03T12:00:00.000Z"),
      { pdf: true },
    );
    const historyFirst = await purchasesForOrder(ctx.db, "FW-SYN-3002");
    expect(historyFirst).toHaveLength(1);
    expect(await attachmentsOn(historyFirst[0]!.id)).toHaveLength(1);

    // Replaying both mails adds nothing.
    await processOrderMails(
      ctx.db,
      ["msg-mail-first", "msg-history-first"],
      [],
      ports,
    );
    expect(await attachmentsOn(mailFirst[0]!.id)).toHaveLength(1);
    expect(await attachmentsOn(historyFirst[0]!.id)).toHaveLength(1);
    expect(
      (await pendingMailPdfs()).every(
        (row) => row.imageId !== null && row.pending === null,
      ),
    ).toBe(true);
    expect(uploadedKeys).toHaveLength(2);
    expect(await liveExpenseCents(ctx.db, mailFirst[0]!.id)).toEqual([2500]);
    expect(await liveExpenseCents(ctx.db, historyFirst[0]!.id)).toEqual([8800]);
  });
});
