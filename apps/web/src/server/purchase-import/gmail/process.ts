import { parseEntityId, runEntityId } from "@cubby/schemas/identifiers";
import { importRunAgentIdentity } from "@cubby/schemas/import-run-agent";
import { generateShortcode } from "@cubby/shared";
import {
  and,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lte,
  notInArray,
} from "drizzle-orm";

import { classifyOrderMail } from "~/server/agents/purchase-import/extract";
import type { Database } from "~/server/db";
import {
  financialTransaction,
  expense,
  runFinding,
  importHunt,
  run as runTable,
  ledgerParty,
  orderMail,
  orderMailAttachment,
  orderMailCandidateDecision,
  orderMailEvent,
  purchase,
  vendor,
  vendorAccount,
  user,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { findOrCreateWithShortcode } from "~/server/repo/shortcode-utils";
import { sha256Hex } from "~/server/semantic/hash";
import { attachFileToEntity } from "~/server/services/image-storage.service";

import { refundTally } from "../findings";
import { orderAmountsInHuntWindow, uniqueOrderSubsetIds } from "./match";
import type { GmailOrderMailAttachment } from "./types";
import {
  matchesConfiguredVendorSender,
  matchesVendorSender,
} from "./vendor-identity";

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
  const targetPurchaseId = await resolveOrThrow(
    db,
    "purchase",
    input.purchaseShortcode,
  );
  const rows = await database
    .select({
      orderMailId: orderMail.id,
      eventId: orderMailEvent.id,
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
        isNull(orderMailEvent.supersededAt),
        eq(orderMailAttachment.mimeType, "application/pdf"),
        isNull(orderMailAttachment.imageId),
        isNotNull(orderMailAttachment.pendingDataBase64Url),
      ),
    );
  let attachedCount = 0;
  for (const row of rows) {
    if (!row.data) continue;
    const decisions = await database
      .select({
        purchaseId: orderMailCandidateDecision.purchaseId,
        decision: orderMailCandidateDecision.decision,
      })
      .from(orderMailCandidateDecision)
      .where(eq(orderMailCandidateDecision.eventId, row.eventId));
    if (
      decisions.some(
        (decision) =>
          (decision.purchaseId === targetPurchaseId &&
            decision.decision === "dismissed") ||
          (decision.purchaseId !== targetPurchaseId &&
            decision.decision === "linked"),
      )
    )
      continue;
    const messageOrders = await database
      .select({ orderId: orderMailEvent.orderId })
      .from(orderMailEvent)
      .where(eq(orderMailEvent.orderMailId, row.orderMailId));
    if (
      new Set(messageOrders.map((event) => event.orderId).filter(Boolean))
        .size !== 1
    )
      continue;
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
        name: vendor.name,
        senders: vendor.orderEmailSenders,
        website: vendor.website,
        returnWindowDays: vendor.returnWindowDays,
      })
      .from(vendor)
      .where(notDeleted(vendor)),
  ]);
  let processed = 0;
  for (const mail of mails) {
    const exactVendors = vendors.filter((candidate) =>
      matchesConfiguredVendorSender(mail.sender, {
        website: candidate.website,
        orderEmailSenders: candidate.senders,
      }),
    );
    const matchedVendors = exactVendors.length
      ? exactVendors
      : vendors.filter((candidate) =>
          matchesVendorSender(mail.sender, {
            website: candidate.website,
            orderEmailSenders: candidate.senders,
          }),
        );
    if (matchedVendors.length !== 1) {
      const fingerprint = await sha256Hex(
        `unknown-sender:${mail.sender.toLowerCase()}`,
      );
      const [existing] = await database
        .select({ id: runFinding.id })
        .from(runFinding)
        .where(
          and(
            eq(runFinding.ledgerPartyId, mail.ledgerPartyId),
            eq(runFinding.kind, "unclassified_vendor"),
            eq(runFinding.evidenceFingerprint, fingerprint),
            eq(runFinding.status, "open"),
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
        const runId = runEntityId.parse(crypto.randomUUID());
        await database.insert(runTable).values({
          id: runId,
          shortcode: generateShortcode("run"),
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
        await database.insert(runFinding).values({
          runId: runId,
          ledgerPartyId: mail.ledgerPartyId,
          targetKind: "run",
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

    let classification: Awaited<ReturnType<typeof ports.classify>>;
    try {
      classification = await ports.classify({
        db,
        messageId: mail.messageId,
        sender: mail.sender,
        subject: mail.subject,
        receivedAt: mail.receivedAt.toISOString(),
        content: mail.content,
      });
    } catch (error) {
      throw new Error(
        `Order email classification failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const classifiedEvents = [...classification.events].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
    const sourceKeys = classifiedEvents.map(
      (_, index) => `classified:${mail.rawChecksum}:${index}`,
    );
    const firstSourceKey = sourceKeys[0];
    if (firstSourceKey) {
      const [currentFirst] = await database
        .select({ id: orderMailEvent.id })
        .from(orderMailEvent)
        .where(
          and(
            eq(orderMailEvent.orderMailId, mail.id),
            eq(orderMailEvent.sourceKey, firstSourceKey),
          ),
        )
        .limit(1);
      if (!currentFirst) {
        await database
          .update(orderMailEvent)
          .set({ sourceKey: firstSourceKey })
          .where(
            and(
              eq(orderMailEvent.orderMailId, mail.id),
              eq(orderMailEvent.sourceKey, `classified:${mail.rawChecksum}`),
            ),
          );
      }
    }
    await database
      .update(orderMailEvent)
      .set({ supersededAt: new Date() })
      .where(
        and(
          eq(orderMailEvent.orderMailId, mail.id),
          like(orderMailEvent.sourceKey, "classified:%"),
          sourceKeys.length
            ? notInArray(orderMailEvent.sourceKey, sourceKeys)
            : undefined,
          isNull(orderMailEvent.supersededAt),
        ),
      );
    if (
      classifiedEvents.some((event) => event.orderId && event.event !== "other")
    ) {
      await findOrCreateWithShortcode(db, "vendorAccount", {
        where: and(
          eq(vendorAccount.vendorId, matchedVendor.id),
          eq(vendorAccount.ledgerPartyId, mail.ledgerPartyId),
          notDeleted(vendorAccount),
        ),
        values: () => ({
          label: `${matchedVendor.name} mail`,
          vendorId: matchedVendor.id,
          ledgerPartyId: mail.ledgerPartyId,
          status: "disabled",
          browserSyncEnabled: false,
        }),
      });
    }
    const vendorMembers = await database
      .select({ ledgerPartyId: vendorAccount.ledgerPartyId })
      .from(vendorAccount)
      .where(
        and(
          eq(vendorAccount.vendorId, matchedVendor.id),
          notDeleted(vendorAccount),
        ),
      );
    const oneMemberVendor =
      new Set(vendorMembers.map((account) => account.ledgerPartyId)).size <= 1;
    for (const [eventIndex, event] of classifiedEvents.entries()) {
      const sourceKey = sourceKeys[eventIndex];
      if (!sourceKey)
        throw new Error("Classified order mail source key is missing");
      const [insertedEvent] = await database
        .insert(orderMailEvent)
        .values({
          orderMailId: mail.id,
          event: event.event,
          orderId: event.orderId,
          amount: event.amount,
          currency: event.currency,
          occurredAt: event.occurredAt
            ? new Date(event.occurredAt)
            : mail.receivedAt,
          sourceKey,
          payload: event,
        })
        .onConflictDoNothing()
        .returning({ id: orderMailEvent.id });
      const [storedEvent] = insertedEvent
        ? [insertedEvent]
        : await database
            .select({ id: orderMailEvent.id })
            .from(orderMailEvent)
            .where(
              and(
                eq(orderMailEvent.orderMailId, mail.id),
                eq(orderMailEvent.sourceKey, sourceKey),
              ),
            )
            .limit(1);
      if (!storedEvent)
        throw new Error("Classified order mail event was not persisted");

      if (event.orderId) {
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
        const isRefund = event.event === "refunded";
        const sameDirection = candidates.filter(
          (candidate) => candidate.amount < 0 === isRefund,
        );
        const exact =
          event.amount === null
            ? []
            : sameDirection.filter(
                (candidate) =>
                  cents(Math.abs(candidate.amount)) ===
                  cents(Math.abs(event.amount ?? 0)),
              );
        let matchedHunt =
          exact.length === 1
            ? { id: exact[0]?.id ?? "", orderIds: [event.orderId] }
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
          if (subsetMatches.length === 1)
            matchedHunt = subsetMatches[0] ?? null;
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

      const decisions = await database
        .select({
          decision: orderMailCandidateDecision.decision,
          purchaseId: orderMailCandidateDecision.purchaseId,
        })
        .from(orderMailCandidateDecision)
        .where(eq(orderMailCandidateDecision.eventId, storedEvent.id));
      const linked = decisions.find(
        (decision) => decision.decision === "linked",
      );
      const [exactTarget] = event.orderId
        ? await database
            .select({
              id: purchase.id,
              shortcode: purchase.shortcode,
              accountPartyId: vendorAccount.ledgerPartyId,
            })
            .from(purchase)
            .leftJoin(
              vendorAccount,
              and(
                eq(vendorAccount.id, purchase.vendorAccountId),
                notDeleted(vendorAccount),
              ),
            )
            .where(
              and(
                eq(purchase.vendorId, matchedVendor.id),
                eq(purchase.orderId, event.orderId),
                notDeleted(purchase),
              ),
            )
            .limit(1)
        : [];
      const [linkedTarget] = linked
        ? await database
            .select({
              id: purchase.id,
              shortcode: purchase.shortcode,
              accountPartyId: vendorAccount.ledgerPartyId,
            })
            .from(purchase)
            .leftJoin(
              vendorAccount,
              and(
                eq(vendorAccount.id, purchase.vendorAccountId),
                notDeleted(vendorAccount),
              ),
            )
            .where(
              and(
                eq(purchase.id, linked.purchaseId),
                eq(purchase.vendorId, matchedVendor.id),
                notDeleted(purchase),
              ),
            )
            .limit(1)
        : [];
      const target =
        linkedTarget ??
        (exactTarget &&
        (!exactTarget.accountPartyId ||
          exactTarget.accountPartyId === mail.ledgerPartyId) &&
        (Boolean(exactTarget.accountPartyId) || oneMemberVendor) &&
        !decisions.some(
          (decision) =>
            decision.purchaseId === exactTarget.id &&
            decision.decision === "dismissed",
        )
          ? exactTarget
          : null);

      if (target && event.orderId) {
        await attachPendingOrderMailEvidence(
          db,
          {
            vendorId: matchedVendor.id,
            orderId: event.orderId,
            purchaseShortcode: target.shortcode,
            ledgerPartyId: mail.ledgerPartyId,
          },
          ports.attachFile,
        );
      }

      if (
        target &&
        (event.event === "delivered" || event.event === "refunded")
      ) {
        let possibleDuplicateRefund = false;
        if (event.event === "refunded" && event.amount !== null) {
          const tally = await refundTally(database, {
            purchaseId: target.id,
            ledgerPartyId: mail.ledgerPartyId,
            amount: event.amount,
          });
          if (tally.booked >= Math.max(tally.evidenced, 1)) {
            continue;
          }
          possibleDuplicateRefund = tally.booked > 0 || tally.evidenced > 1;
        }
        const kind =
          event.event === "delivered" ? "arrived" : "refund_unbooked";
        const proposedFix =
          event.event === "delivered"
            ? { kind: "receive_purchase" as const, purchaseId: target.id }
            : event.amount !== null
              ? {
                  kind: "create_refund" as const,
                  purchaseId: target.id,
                  amount: -Math.abs(event.amount),
                  title: `Refund for order ${event.orderId}`,
                }
              : null;
        await database
          .insert(runFinding)
          .values({
            ledgerPartyId: mail.ledgerPartyId,
            targetKind: "purchase",
            targetId: target.id,
            kind,
            summary:
              event.event === "delivered"
                ? "Vendor mail says all items were delivered. Review and receive this purchase."
                : possibleDuplicateRefund
                  ? "Vendor mail reports a refund of the same amount as another refund on this order. Apply only if it is a separate refund, not a second notice for the same one."
                  : "Vendor mail reports a refund that is not yet booked in the expense ledger.",
            proposedFix,
            evidenceFingerprint: await sha256Hex(
              JSON.stringify({ sourceKey, event, target: target.id }),
            ),
          })
          .onConflictDoNothing();
        if (
          event.event === "delivered" &&
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
            const deliveredAt = event.occurredAt
              ? new Date(event.occurredAt)
              : mail.receivedAt;
            const expiresAt = new Date(
              deliveredAt.getTime() +
                matchedVendor.returnWindowDays * 24 * 60 * 60 * 1_000,
            );
            await database
              .insert(runFinding)
              .values({
                ledgerPartyId: mail.ledgerPartyId,
                targetKind: "purchase",
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
    }
    await database
      .update(orderMail)
      .set({ classifiedChecksum: mail.rawChecksum, updatedAt: new Date() })
      .where(eq(orderMail.id, mail.id));
    processed += 1;
  }
  return processed;
}
