/**
 * The public `mail` tool: read a member's retained Email and record what it
 * means for their Purchases. Pi's Mail import and a member's Claude/Codex
 * session call the same functions; Pi's calls are additionally bound to the
 * Emails its Mail import Run admitted.
 */
import type { ActorContext } from "@cubby/schemas/context";
import { parseEntityId, type RunId } from "@cubby/schemas/identifiers";
import {
  mailReadInput,
  mailResolveInput,
  mailResolveOut,
  type MailEvent,
  type MailMessageRef,
  type MailReadInput,
  type MailResolveInput,
} from "@cubby/schemas/mailbox-research";
import { researchAttachmentOriginal } from "@cubby/schemas/research-tools";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  entityAttachment,
  ledgerParty,
  mailboxMessage,
  orderMail,
  orderMailAttachment,
  orderMailCandidateDecision,
  orderMailEvent,
  purchase,
  run as runTable,
  runTarget,
  vendorAccount,
} from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/repo/database-helpers";
import { attachFileToEntity } from "~/server/repo/image";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

import {
  productionOrderMailAttachmentStorage,
  type OrderMailAttachmentStorage,
} from "./gmail/attachment-storage";
import { ensureMailVendorAccount } from "./gmail/mail-account";
import { clearUnrelatedOriginal } from "./gmail/persistence";
import { loadMailAttachmentOriginal } from "./research-mail-attachments";

type RetainedMail = typeof orderMail.$inferSelect;

async function memberPartyIds(db: Database, userId: string) {
  const tx = getDb(db);
  const rows = await tx
    .select({ id: ledgerParty.id })
    .from(ledgerParty)
    .where(
      and(
        eq(ledgerParty.userId, userId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    );
  return rows.map(({ id }) => id);
}

/** The Mail import Run this call executes under, when Pi is the caller. */
async function mailImportRun(db: Database, runId: RunId | null) {
  if (!runId) return null;
  const tx = getDb(db);
  const [row] = await tx
    .select({ id: runTable.id, purpose: runTable.purpose })
    .from(runTable)
    .where(eq(runTable.id, runId))
    .limit(1);
  return row?.purpose === "mail_import" ? row.id : null;
}

/**
 * The member's own retained Email. A Mail import Run may touch only the Emails
 * it admitted as targets; a member may touch any Email from their mailboxes.
 */
async function ownedMail(
  db: Database,
  ref: MailMessageRef,
  actor: ActorContext,
  lock: "update" | "share",
): Promise<{ mail: RetainedMail; importRunId: RunId | null }> {
  const tx = getDb(db);
  const parties = await memberPartyIds(db, actor.userId);
  if (parties.length === 0)
    throw new Error("Only a household member can read retained Email.");
  const [mail] = await tx
    .select()
    .from(orderMail)
    .where(
      and(
        inArray(orderMail.ledgerPartyId, parties),
        eq(orderMail.mailboxId, ref.mailboxId),
        eq(orderMail.messageId, ref.messageId),
      ),
    )
    .for(lock)
    .limit(1);
  if (!mail)
    throw new Error(
      `No retained Email ${ref.messageId} in mailbox ${ref.mailboxId} belongs to this member.`,
    );
  const importRunId = await mailImportRun(db, actor.runId);
  if (importRunId) {
    const [target] = await tx
      .select({ id: runTarget.id })
      .from(runTarget)
      .where(
        and(eq(runTarget.runId, importRunId), eq(runTarget.workKey, mail.id)),
      )
      .limit(1);
    if (!target)
      throw new Error(
        "This Mail import Run did not admit that Email; resolve only its own messages.",
      );
  }
  return { mail, importRunId };
}

async function mailboxRow(db: Database, mail: RetainedMail) {
  const [row] = await getDb(db)
    .select()
    .from(mailboxMessage)
    .where(
      and(
        eq(mailboxMessage.ledgerPartyId, mail.ledgerPartyId),
        eq(mailboxMessage.mailboxId, mail.mailboxId),
        eq(mailboxMessage.messageId, mail.messageId),
      ),
    )
    .for("update")
    .limit(1);
  return row;
}

export async function readMail(
  db: Database,
  rawInput: MailReadInput,
  actor: ActorContext,
) {
  const input = mailReadInput.parse(rawInput);
  const { mail, attachments, importRunId } = await withTransactionDatabase(
    db,
    async (tdb) => {
      const tx = getDb(tdb);
      const owned = await ownedMail(tdb, input, actor, "share");
      const message = await mailboxRow(tdb, owned.mail);
      if (
        !message ||
        message.orderMailId !== owned.mail.id ||
        ["excluded", "deleted"].includes(message.status) ||
        message.classification === "unrelated"
      )
        throw new Error("This Email is no longer retained for purchases.");
      // Pi claims the Email it reads so discovery never admits it twice.
      if (owned.importRunId && message.status === "pending")
        await tx
          .update(mailboxMessage)
          .set({ status: "researching", runId: owned.importRunId })
          .where(eq(mailboxMessage.id, message.id));
      const rows = await tx
        .select({
          id: orderMailAttachment.id,
          attachmentId: orderMailAttachment.providerAttachmentId,
          filename: orderMailAttachment.filename,
          mimeType: orderMailAttachment.mimeType,
          checksum: orderMailAttachment.checksum,
        })
        .from(orderMailAttachment)
        .where(eq(orderMailAttachment.orderMailId, owned.mail.id));
      return { ...owned, attachments: rows };
    },
  );
  const requested = input.attachmentId
    ? attachments.find((row) => row.attachmentId === input.attachmentId)
    : undefined;
  if (input.attachmentId && !requested)
    throw new Error("That attachment does not belong to this Email.");
  const original = requested
    ? await loadMailAttachmentOriginal(db, {
        orderMailId: mail.id,
        attachmentRef: requested.id,
      })
    : undefined;
  return {
    mailboxId: mail.mailboxId,
    messageId: mail.messageId,
    threadId: mail.threadId,
    checksum: mail.rawChecksum,
    sender: mail.sender,
    subject: mail.subject,
    receivedAt: mail.receivedAt?.toISOString() ?? null,
    content: mail.content,
    attachments: attachments.map(({ id: _id, ...row }) => row),
    originalAttachment: original
      ? researchAttachmentOriginal.parse({
          ...original,
          attachmentRef: requested?.attachmentId,
        })
      : undefined,
    boundToRun: importRunId !== null,
  };
}

/** Retained attachments become the Purchase's documents, once. */
async function attachRetainedSource(
  db: Database,
  input: { orderMailId: string; purchaseId: string; purchaseShortcode: string },
) {
  const rows = await getDb(db)
    .select()
    .from(orderMailAttachment)
    .where(eq(orderMailAttachment.orderMailId, input.orderMailId));
  for (const attachment of rows) {
    let imageId = attachment.imageId;
    if (!imageId && attachment.pendingObjectKey) {
      const bytes = await productionOrderMailAttachmentStorage.get(
        attachment.pendingObjectKey,
      );
      const attached = await attachFileToEntity(db, {
        entityKind: "purchase",
        entityId: input.purchaseShortcode,
        data: Buffer.from(bytes).toString("base64"),
        contentType: attachment.mimeType,
        filename: attachment.filename,
        idempotencyKey: `retained-mail:${attachment.id}`,
      });
      imageId = await resolveOrThrow(db, "image", attached.imageId);
      await getDb(db)
        .update(orderMailAttachment)
        .set({ imageId, updatedAt: new Date() })
        .where(eq(orderMailAttachment.id, attachment.id));
    }
    if (imageId)
      await getDb(db)
        .insert(entityAttachment)
        .values({
          entityKind: "purchase",
          entityId: parseEntityId("purchase", input.purchaseId),
          imageId,
          role: "attachment",
          idempotencyKey: `retained-mail:${attachment.id}`,
        })
        .onConflictDoNothing();
  }
}

/**
 * Record that an Email supports one lifecycle event of a Purchase. Keyed by
 * (Email, Purchase, event, checksum), so a replay adds nothing; a member's
 * earlier dismissal of this pairing wins over an automatic link.
 */
export async function linkOrderMail(
  db: Database,
  input: {
    mail: RetainedMail;
    purchaseId: string;
    event: MailEvent;
    actorUserId: string;
  },
) {
  const tx = getDb(db);
  const [chosen] = await tx
    .select({
      id: purchase.id,
      shortcode: purchase.shortcode,
      orderId: purchase.orderId,
      vendorId: purchase.vendorId,
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
        eq(purchase.id, parseEntityId("purchase", input.purchaseId)),
        notDeleted(purchase),
      ),
    )
    .for("update", { of: purchase })
    .limit(1);
  if (!chosen) throw new Error("That Purchase no longer exists.");
  if (
    chosen.accountPartyId &&
    chosen.accountPartyId !== input.mail.ledgerPartyId
  )
    throw new Error("The Email and the Purchase belong to different members.");
  const sourceKey = await sha256Hex(
    JSON.stringify({
      purchaseId: chosen.id,
      event: input.event,
      checksum: input.mail.rawChecksum,
    }),
  );
  const [created] = await tx
    .insert(orderMailEvent)
    .values({
      orderMailId: input.mail.id,
      event: input.event,
      orderId: chosen.orderId,
      sourceKey,
    })
    .onConflictDoNothing()
    .returning();
  const [event] = created
    ? [created]
    : await tx
        .select()
        .from(orderMailEvent)
        .where(
          and(
            eq(orderMailEvent.orderMailId, input.mail.id),
            eq(orderMailEvent.sourceKey, sourceKey),
          ),
        )
        .limit(1);
  if (!event) throw new Error("The Email event was not recorded.");
  const [dismissed] = await tx
    .select({ id: orderMailCandidateDecision.id })
    .from(orderMailCandidateDecision)
    .where(
      and(
        eq(orderMailCandidateDecision.eventId, event.id),
        eq(orderMailCandidateDecision.purchaseId, chosen.id),
        eq(orderMailCandidateDecision.decision, "dismissed"),
      ),
    )
    .limit(1);
  if (!dismissed) {
    // One accepted Purchase per event: an existing link elsewhere stays the
    // member's to change through review.
    const [other] = await tx
      .select({ purchaseId: orderMailCandidateDecision.purchaseId })
      .from(orderMailCandidateDecision)
      .where(
        and(
          eq(orderMailCandidateDecision.eventId, event.id),
          eq(orderMailCandidateDecision.decision, "linked"),
        ),
      )
      .limit(1);
    if (other && other.purchaseId !== chosen.id)
      throw new Error(
        "This Email event is already linked to another Purchase; review it before relinking.",
      );
    if (!other)
      await tx.insert(orderMailCandidateDecision).values({
        eventId: event.id,
        purchaseId: chosen.id,
        decision: "linked",
        evidenceChecksum: input.mail.rawChecksum,
        decidedByUserId: input.actorUserId,
      });
  }
  await ensureMailVendorAccount(db, {
    vendorId: chosen.vendorId,
    ledgerPartyId: input.mail.ledgerPartyId,
  });
  await attachRetainedSource(db, {
    orderMailId: input.mail.id,
    purchaseId: chosen.id,
    purchaseShortcode: chosen.shortcode,
  });
  return chosen;
}

/** Settle the Email's MailboxMessage and, under Pi, its Mail import target. */
export async function settleMail(
  db: Database,
  input: {
    mail: RetainedMail;
    importRunId: RunId | null;
    status: "completed" | "blocked";
    classification?: "unrelated";
    outcome: string;
  },
) {
  const tx = getDb(db);
  const settled: Partial<typeof mailboxMessage.$inferInsert> = {
    status: input.status,
    updatedAt: new Date(),
  };
  if (input.classification) settled.classification = input.classification;
  await tx
    .update(mailboxMessage)
    .set(settled)
    .where(
      and(
        eq(mailboxMessage.ledgerPartyId, input.mail.ledgerPartyId),
        eq(mailboxMessage.mailboxId, input.mail.mailboxId),
        eq(mailboxMessage.messageId, input.mail.messageId),
      ),
    );
  if (input.importRunId)
    await tx
      .update(runTarget)
      .set({
        state: input.status === "completed" ? "completed" : "unresolved",
        outcome: input.outcome,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(runTarget.runId, input.importRunId),
          eq(runTarget.workKey, input.mail.id),
        ),
      );
}

export async function resolveMail(
  db: Database,
  rawInput: MailResolveInput,
  actor: ActorContext,
  storage: OrderMailAttachmentStorage = productionOrderMailAttachmentStorage,
) {
  const input = mailResolveInput.parse(rawInput);
  const { disposition } = input;
  const settled = await withTransactionDatabase(db, async (tdb) => {
    const { mail, importRunId } = await ownedMail(tdb, input, actor, "update");
    if (mail.rawChecksum !== input.checksum)
      throw new Error(
        "This Email changed since it was read; read it again before resolving.",
      );
    if (disposition.kind === "linked") {
      const chosen = await linkOrderMail(tdb, {
        mail,
        purchaseId: await resolveOrThrow(
          tdb,
          "purchase",
          disposition.purchaseId,
        ),
        event: disposition.event,
        actorUserId: actor.userId,
      });
      await settleMail(tdb, {
        mail,
        importRunId,
        status: "completed",
        outcome: `linked:${disposition.event}`,
      });
      return {
        mail,
        purchaseId: chosen.shortcode,
        status: "completed" as const,
      };
    }
    if (disposition.kind === "unresolved") {
      await settleMail(tdb, {
        mail,
        importRunId,
        status: "blocked",
        outcome: disposition.reason,
      });
      return { mail, purchaseId: null, status: "blocked" as const };
    }
    await settleMail(tdb, {
      mail,
      importRunId,
      status: "completed",
      classification: "unrelated",
      outcome: `unrelated: ${disposition.reason}`,
    });
    return { mail, purchaseId: null, status: "completed" as const };
  });
  // Disposal runs after the disposition commits; a protected original (one a
  // reviewed decision or import already uses) is kept.
  if (disposition.kind === "unrelated")
    await clearUnrelatedOriginal(
      db,
      {
        ledgerPartyId: settled.mail.ledgerPartyId,
        mailboxId: settled.mail.mailboxId,
        messageId: settled.mail.messageId,
      },
      storage,
    );
  return mailResolveOut.parse({
    mailboxId: settled.mail.mailboxId,
    messageId: settled.mail.messageId,
    status: settled.status,
    disposition: disposition.kind,
    purchaseId: settled.purchaseId,
  });
}

/** Mail-sourced import commits record their confirmation link themselves. */
export async function linkImportedMail(
  db: Database,
  input: {
    ledgerPartyId: string;
    externalKey: string;
    checksum: string;
    purchaseId: string;
    actorUserId: string;
    runId: RunId;
  },
) {
  const match = /^gmail:(.+):([^:]+)$/u.exec(input.externalKey);
  if (!match) return;
  const [, mailboxId, messageId] = match;
  const [mail] = await getDb(db)
    .select()
    .from(orderMail)
    .where(
      and(
        eq(
          orderMail.ledgerPartyId,
          parseEntityId("ledgerParty", input.ledgerPartyId),
        ),
        eq(orderMail.mailboxId, mailboxId!),
        eq(orderMail.messageId, messageId!),
        eq(orderMail.rawChecksum, input.checksum),
      ),
    )
    .for("update")
    .limit(1);
  if (!mail) return;
  await linkOrderMail(db, {
    mail,
    purchaseId: input.purchaseId,
    event: "confirmation",
    actorUserId: input.actorUserId,
  });
  await settleMail(db, {
    mail,
    importRunId: await mailImportRun(db, input.runId),
    status: "completed",
    outcome: "imported",
  });
}
