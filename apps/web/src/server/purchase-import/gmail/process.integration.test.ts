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
import type { OrderMailClassification } from "@cubby/schemas/purchase-import";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
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

const classifications = new Map<string, OrderMailClassification>();
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
    classification: OrderMailClassification,
    options: { pdf?: boolean; rawChecksum?: string } = {},
  ) {
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: seed.party.id,
        messageId,
        sender: SENDER,
        subject: `ForgeWear ${classification.event} ${classification.orderId ?? ""}`,
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
    classifications.set(messageId, classification);
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
            eq(runFinding.targetId, target.id),
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
            eq(runFinding.targetId, target.id),
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
            eq(entityAttachment.subjectEntityId, purchaseId),
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
