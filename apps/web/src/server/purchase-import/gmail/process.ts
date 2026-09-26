import { parseEntityId, importRunId } from "@cubby/schemas/identifiers";
import { importRunAgentIdentity } from "@cubby/schemas/import-run-agent";
import { generateShortcode } from "@cubby/shared";
import { and, eq, gte, inArray, isNotNull, isNull, lte } from "drizzle-orm";

import { classifyOrderMail } from "~/server/agents/purchase-import/extract";
import type { Database } from "~/server/db";
import {
  financialTransaction,
  expense,
  importFinding,
  importHunt,
  importRun,
  ledgerParty,
  orderMail,
  orderMailAttachment,
  orderMailEvent,
  purchase,
  vendor,
  user,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { sha256Hex } from "~/server/semantic/hash";
import { attachFileToEntity } from "~/server/services/image-storage.service";

import { refundTally } from "../findings";
import { orderAmountsInHuntWindow, uniqueOrderSubsetIds } from "./match";
import type { GmailOrderMailAttachment } from "./types";

const cents = (value: number) => Math.round(value * 100);

export type AttachOrderMailFile = typeof attachFileToEntity;

/** External seams of the mail pipeline: the classifier model and object storage. */
export interface OrderMailPorts {
  classify: typeof classifyOrderMail;
  attachFile: AttachOrderMailFile;
}

const productionOrderMailPorts: OrderMailPorts = {
  classify: classifyOrderMail,
  attachFile: attachFileToEntity,
};

export async function attachPendingOrderMailEvidence(
  db: Database,
  input: {
    vendorId: string;
    orderId: string;
    purchaseShortcode: string;
    ledgerPartyId?: string;
  },
  attachFile: AttachOrderMailFile = attachFileToEntity,
) {
  const database = getDb(db);
  const rows = await database
    .select({
      id: orderMailAttachment.id,
      messageId: orderMail.messageId,
      subject: orderMail.subject,
      providerAttachmentId: orderMailAttachment.providerAttachmentId,
      filename: orderMailAttachment.filename,
      data: orderMailAttachment.pendingDataBase64Url,
    })
    .from(orderMailAttachment)
    .innerJoin(orderMail, eq(orderMail.id, orderMailAttachment.orderMailId))
    .innerJoin(orderMailEvent, eq(orderMailEvent.orderMailId, orderMail.id))
    .where(
      and(
        input.ledgerPartyId
          ? eq(
              orderMail.ledgerPartyId,
              parseEntityId("ledgerParty", input.ledgerPartyId),
            )
          : undefined,
        eq(orderMail.vendorId, parseEntityId("vendor", input.vendorId)),
        eq(orderMailEvent.orderId, input.orderId),
        eq(orderMailAttachment.mimeType, "application/pdf"),
        isNull(orderMailAttachment.imageId),
        isNotNull(orderMailAttachment.pendingDataBase64Url),
      ),
    );
  let attachedCount = 0;
  for (const row of rows) {
    if (!row.data) continue;
    const stored = await attachFile(db, {
      entityType: "purchase",
      entityId: input.purchaseShortcode,
      data: row.data,
      contentType: "application/pdf",
      filename: row.filename,
      documentKind: row.subject.toLowerCase().includes("receipt")
        ? "receipt"
        : "invoice",
      idempotencyKey: `gmail:${row.messageId}:${row.providerAttachmentId}`,
    });
    const [attached] = await database
      .update(orderMailAttachment)
      .set({
        imageId: await resolveOrThrow(db, "image", stored.imageId),
        pendingDataBase64Url: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(orderMailAttachment.id, row.id),
          isNull(orderMailAttachment.imageId),
        ),
      )
      .returning({ id: orderMailAttachment.id });
    if (!attached) continue;
    attachedCount += 1;
  }
  return attachedCount;
}

// This is the ordered mail pipeline: classify, match a hunt, attach evidence,
// then derive event findings. Keeping that sequence visible prevents cursor
// advancement from outrunning a partially processed message.
// eslint-disable-next-line complexity
export async function processOrderMails(
  db: Database,
  messageIds: readonly string[],
  _attachments: readonly GmailOrderMailAttachment[] = [],
  ports: OrderMailPorts = productionOrderMailPorts,
): Promise<number> {
  if (messageIds.length === 0) return 0;
  const database = getDb(db);
  const [mails, vendors] = await Promise.all([
    database
      .select()
      .from(orderMail)
      .where(inArray(orderMail.messageId, [...messageIds])),
    database
      .select({
        id: vendor.id,
        senders: vendor.orderEmailSenders,
        returnWindowDays: vendor.returnWindowDays,
      })
      .from(vendor)
      .where(notDeleted(vendor)),
  ]);
  let processed = 0;
  for (const mail of mails) {
    const sender = mail.sender.toLowerCase();
    const matchedVendors = vendors.filter((candidate) =>
      candidate.senders.some((value) => sender.includes(value.toLowerCase())),
    );
    if (matchedVendors.length !== 1) {
      const fingerprint = await sha256Hex(
        `unknown-sender:${mail.sender.toLowerCase()}`,
      );
      const [existing] = await database
        .select({ id: importFinding.id })
        .from(importFinding)
        .where(
          and(
            eq(importFinding.ledgerPartyId, mail.ledgerPartyId),
            eq(importFinding.kind, "unclassified_vendor"),
            eq(importFinding.evidenceFingerprint, fingerprint),
            eq(importFinding.status, "open"),
          ),
        )
        .limit(1);
      if (!existing) {
        const [actorSnapshot] = await database
          .select({
            actorUserId: ledgerParty.userId,
            actorName: user.name,
            actorEmail: user.email,
            actorLedgerPartyShortcode: ledgerParty.shortcode,
            actorLedgerPartyName: ledgerParty.name,
            actorLedgerPartyKind: ledgerParty.kind,
          })
          .from(ledgerParty)
          .innerJoin(user, eq(user.id, ledgerParty.userId))
          .where(
            and(
              eq(ledgerParty.id, mail.ledgerPartyId),
              notDeleted(ledgerParty),
            ),
          )
          .limit(1);
        if (!actorSnapshot?.actorUserId)
          throw new Error("Order mail party has no controlling member");
        const runId = importRunId.parse(crypto.randomUUID());
        await database.insert(importRun).values({
          id: runId,
          shortcode: generateShortcode("importRun"),
          ledgerPartyId: mail.ledgerPartyId,
          actorUserId: actorSnapshot.actorUserId,
          actorName: actorSnapshot.actorName,
          actorEmail: actorSnapshot.actorEmail,
          actorLedgerPartyShortcode: actorSnapshot.actorLedgerPartyShortcode,
          actorLedgerPartyName: actorSnapshot.actorLedgerPartyName,
          actorLedgerPartyKind: actorSnapshot.actorLedgerPartyKind,
          trigger: "discovery",
          status: "needs_review",
          agentSessionId: importRunAgentIdentity(runId, "account_sync"),
          endedAt: new Date(),
        });
        await database.insert(importFinding).values({
          importRunId: runId,
          ledgerPartyId: mail.ledgerPartyId,
          targetType: "import_run",
          targetId: runId,
          kind: "unclassified_vendor",
          summary: `Purchase mail from ${mail.sender} does not match a known vendor. Create or update the vendor's order-email sender list.`,
          evidenceFingerprint: fingerprint,
        });
      }
      processed += 1;
      continue;
    }
    const matchedVendor = matchedVendors[0];
    if (!matchedVendor) continue;
    await database
      .update(orderMail)
      .set({ vendorId: matchedVendor.id, updatedAt: new Date() })
      .where(eq(orderMail.id, mail.id));

    const classification = await ports.classify({
      db,
      messageId: mail.messageId,
      sender: mail.sender,
      subject: mail.subject,
      receivedAt: mail.receivedAt.toISOString(),
      content: mail.content,
    });
    const sourceKey = `classified:${mail.rawChecksum}`;
    await database
      .insert(orderMailEvent)
      .values({
        orderMailId: mail.id,
        event: classification.event,
        orderId: classification.orderId,
        amount: classification.amount,
        currency: classification.currency,
        occurredAt: classification.occurredAt
          ? new Date(classification.occurredAt)
          : mail.receivedAt,
        sourceKey,
        payload: classification,
      })
      .onConflictDoNothing();

    if (classification.orderId) {
      const date = mail.receivedAt.toISOString().slice(0, 10);
      const candidates = await database
        .select({
          id: importHunt.id,
          amount: financialTransaction.amount,
          dateFrom: importHunt.dateFrom,
          dateTo: importHunt.dateTo,
        })
        .from(importHunt)
        .innerJoin(
          financialTransaction,
          eq(financialTransaction.id, importHunt.financialTransactionId),
        )
        .where(
          and(
            eq(importHunt.ledgerPartyId, mail.ledgerPartyId),
            eq(importHunt.vendorId, matchedVendor.id),
            eq(importHunt.state, "pending_mail"),
            lte(importHunt.dateFrom, date),
            gte(importHunt.dateTo, date),
          ),
        );
      // Statement charges are positive and credits negative, while mail
      // amounts are unsigned: only the event kind says which way money moved.
      // A refund may resolve only a credit hunt, and any other event only a
      // charge hunt, or an equal-amount refund for another order claims a
      // new charge.
      const isRefund = classification.event === "refunded";
      const sameDirection = candidates.filter(
        (candidate) => candidate.amount < 0 === isRefund,
      );
      const exact =
        classification.amount === null
          ? []
          : sameDirection.filter(
              (candidate) =>
                cents(Math.abs(candidate.amount)) ===
                cents(Math.abs(classification.amount ?? 0)),
            );
      let matchedHunt =
        exact.length === 1
          ? { id: exact[0]?.id ?? "", orderIds: [classification.orderId] }
          : null;
      if (!matchedHunt) {
        const subsetMatches: { id: string; orderIds: string[] }[] = [];
        for (const candidate of sameDirection) {
          const orders = await orderAmountsInHuntWindow(db, {
            ledgerPartyId: mail.ledgerPartyId,
            vendorId: matchedVendor.id,
            ...candidate,
          });
          const orderIds = uniqueOrderSubsetIds(candidate.amount, orders);
          if (orderIds) subsetMatches.push({ id: candidate.id, orderIds });
        }
        if (subsetMatches.length === 1) matchedHunt = subsetMatches[0] ?? null;
      }
      if (matchedHunt) {
        await database
          .update(importHunt)
          .set({
            state: "pending_browser",
            matchedOrderIds: matchedHunt.orderIds,
            updatedAt: new Date(),
          })
          .where(eq(importHunt.id, matchedHunt.id));
      }
    }

    const [target] = classification.orderId
      ? await database
          .select({ id: purchase.id, shortcode: purchase.shortcode })
          .from(purchase)
          .where(
            and(
              eq(purchase.vendorId, matchedVendor.id),
              eq(purchase.orderId, classification.orderId),
              notDeleted(purchase),
            ),
          )
          .limit(1)
      : [];

    if (target && classification.orderId) {
      await attachPendingOrderMailEvidence(
        db,
        {
          vendorId: matchedVendor.id,
          orderId: classification.orderId,
          purchaseShortcode: target.shortcode,
          ledgerPartyId: mail.ledgerPartyId,
        },
        ports.attachFile,
      );
    }

    if (
      target &&
      (classification.event === "delivered" ||
        classification.event === "refunded")
    ) {
      let possibleDuplicateRefund = false;
      if (
        classification.event === "refunded" &&
        classification.amount !== null
      ) {
        const tally = await refundTally(database, {
          purchaseId: target.id,
          ledgerPartyId: mail.ledgerPartyId,
          amount: classification.amount,
        });
        if (tally.booked >= Math.max(tally.evidenced, 1)) {
          processed += 1;
          continue;
        }
        possibleDuplicateRefund = tally.booked > 0 || tally.evidenced > 1;
      }
      const kind =
        classification.event === "delivered" ? "arrived" : "refund_unbooked";
      const proposedFix =
        classification.event === "delivered"
          ? { kind: "receive_purchase" as const, purchaseId: target.id }
          : classification.amount !== null
            ? {
                kind: "create_refund" as const,
                purchaseId: target.id,
                amount: -Math.abs(classification.amount),
                title: `Refund for order ${classification.orderId}`,
              }
            : null;
      await database
        .insert(importFinding)
        .values({
          ledgerPartyId: mail.ledgerPartyId,
          targetType: "purchase",
          targetId: target.id,
          kind,
          summary:
            classification.event === "delivered"
              ? "Vendor mail says all items were delivered. Review and receive this purchase."
              : possibleDuplicateRefund
                ? "Vendor mail reports a refund of the same amount as another refund on this order. Apply only if it is a separate refund, not a second notice for the same one."
                : "Vendor mail reports a refund that is not yet booked in the expense ledger.",
          proposedFix,
          evidenceFingerprint: await sha256Hex(
            JSON.stringify({ sourceKey, classification, target: target.id }),
          ),
        })
        .onConflictDoNothing();
      if (
        classification.event === "delivered" &&
        matchedVendor.returnWindowDays !== null
      ) {
        const costlyLines = await database
          .select({ name: expense.name, cost: expense.cost })
          .from(expense)
          .where(
            and(
              eq(expense.purchaseId, target.id),
              gte(expense.cost, 50),
              notDeleted(expense),
            ),
          );
        if (costlyLines.length > 0) {
          const deliveredAt = classification.occurredAt
            ? new Date(classification.occurredAt)
            : mail.receivedAt;
          const expiresAt = new Date(
            deliveredAt.getTime() +
              matchedVendor.returnWindowDays * 24 * 60 * 60 * 1_000,
          );
          await database
            .insert(importFinding)
            .values({
              ledgerPartyId: mail.ledgerPartyId,
              targetType: "purchase",
              targetId: target.id,
              kind: "return_window",
              summary: `${costlyLines.length} line${costlyLines.length === 1 ? "" : "s"} worth at least $50 can be returned until ${expiresAt.toLocaleDateString("en-US", { timeZone: "UTC" })}.`,
              evidenceFingerprint: await sha256Hex(
                JSON.stringify({
                  sourceKey,
                  target: target.id,
                  expiresAt: expiresAt.toISOString(),
                  lines: costlyLines,
                }),
              ),
              expiresAt,
            })
            .onConflictDoNothing();
        }
      }
    }
    processed += 1;
  }
  return processed;
}
