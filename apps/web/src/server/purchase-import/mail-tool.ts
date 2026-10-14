import type { ActorContext } from "@cubby/schemas/context";
/**
 * The public `mail` tool: read a member's retained Email and record what it
 * means for their Purchases. Pi's Mail import and a member's Claude/Codex
 * session call the same functions; Pi's calls are additionally bound to the
 * Emails its Mail import Run admitted.
 */
import { emailClassificationObservationInput } from "@cubby/schemas/email-observations";
import {
  parseEntityId,
  parseShortcodeFor,
  runEntityId,
  type RunId,
  type UserId,
} from "@cubby/schemas/identifiers";
import {
  mailReadInput,
  mailReadOut,
  mailSearchInput,
  mailSearchOut,
  mailResolveInput,
  mailResolveOut,
  type MailEvent,
  type MailMessageRef,
  type MailReadInput,
  type MailResolveInput,
  type MailSearchInput,
} from "@cubby/schemas/mailbox-research";
import { runTargetOutcomeReceipt } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import type { Database } from "~/server/db";
import { account } from "~/server/db/auth.schema";
import {
  emailClassificationObservation,
  entityAttachment,
  ledgerParty,
  email as emailTable,
  orderMail,
  orderMailAttachment,
  orderMailCandidateDecision,
  orderMailEvent,
  purchase,
  runOperation,
  run as runTable,
  vendorAccount,
} from "~/server/db/schema";
import {
  getDb,
  withTransaction,
  notDeleted,
  withTransactionDatabase,
} from "~/server/repo/database-helpers";
import { readEmailFinancialAssociations } from "~/server/repo/email-financial-associations";
import {
  readEmailAcceptedSourceOrders,
  readEmailPurchaseAssociations,
} from "~/server/repo/email-purchase-associations";
import {
  readRetainedMail,
  retainedMailJoin,
  type RetainedMail,
} from "~/server/repo/retained-mail";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { attachFileToEntity } from "~/server/services/image-storage.service";

import { loadMailAttachmentOriginal } from "./gmail/attachment-original";
import {
  productionOrderMailAttachmentStorage,
  type OrderMailAttachmentStorage,
} from "./gmail/attachment-storage";
import { ingestGmailMessages } from "./gmail/ingest";
import { ensureMailVendorAccount } from "./gmail/mail-account";
import { snapshotStoredEmailPrediction } from "./gmail/observations";
import { clearUnrelatedOriginal } from "./gmail/persistence";
import { gmailProviderForUser } from "./gmail/provider";
import { GMAIL_PAGE_SIZE } from "./gmail/sync";
import { GmailAuthorizationError } from "./gmail/tokens";
import { GmailApiError } from "./gmail/types";
import { recordMailFinancialReview } from "./mail-financial-review";
import {
  assertMailRunMembership,
  readMailRunSources,
} from "./mail-run-membership";

async function memberPartyIds(db: Database, userId: UserId) {
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

/**
 * The Mail import Run this call executes under, when Pi is the caller. The
 * Run is share-locked so a concurrent cancel waits for this transaction, and a
 * cancelled, finished, retired or deleted Run refuses the call.
 */
async function mailImportRun(db: Database, runId: RunId | null) {
  if (!runId) return null;
  const [row] = await getDb(db)
    .select({
      id: runTable.id,
      purpose: runTable.purpose,
      status: runTable.status,
      retiredAt: runTable.retiredAt,
      deletedAt: runTable.deletedAt,
    })
    .from(runTable)
    .where(eq(runTable.id, runId))
    .for("share")
    .limit(1);
  if (row?.purpose !== "mail_import") return null;
  if (row.status !== "running" || row.retiredAt || row.deletedAt)
    throw new Error(
      `This Mail import Run is no longer running (${row.deletedAt ? "deleted" : row.retiredAt ? "retired" : row.status}).`,
    );
  return row.id;
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
  const importRunId = await mailImportRun(db, actor.runId);
  const parties = await memberPartyIds(db, actor.userId);
  if (parties.length === 0)
    throw new Error("Only a household member can read retained Email.");
  const [mail] = await readRetainedMail(
    db,
    {
      ledgerPartyIds: parties,
      mailboxId: ref.mailboxId,
      messageId: ref.messageId,
    },
    lock,
  );
  if (!mail)
    throw new Error(
      `No retained Email ${ref.messageId} in mailbox ${ref.mailboxId} belongs to this member.`,
    );
  if (importRunId) await assertMailRunMembership(tx, importRunId, mail.id);

  return { mail, importRunId };
}

async function mailboxRow(db: Database, mail: RetainedMail) {
  const [row] = await getDb(db)
    .select()
    .from(emailTable)
    .where(
      and(
        eq(emailTable.ledgerPartyId, mail.ledgerPartyId),
        eq(emailTable.provider, "gmail"),
        eq(emailTable.orderMailId, mail.id),
        notDeleted(emailTable),
        eq(emailTable.mailboxId, mail.mailboxId),
        eq(emailTable.messageId, mail.messageId),
      ),
    )
    .for("update")
    .limit(1);
  return row;
}

async function associationsForMail(
  db: Database,
  mail: Pick<RetainedMail, "ledgerPartyId" | "mailboxId" | "messageId">,
) {
  const [message] = await getDb(db)
    .select({ id: emailTable.id, shortcode: emailTable.shortcode })
    .from(emailTable)
    .where(
      and(
        eq(emailTable.ledgerPartyId, mail.ledgerPartyId),
        eq(emailTable.provider, "gmail"),
        eq(emailTable.mailboxId, mail.mailboxId),
        eq(emailTable.messageId, mail.messageId),
        notDeleted(emailTable),
      ),
    )
    .limit(1);
  if (!message) throw new Error("The Email no longer exists.");
  const id = parseEntityId("email", message.id);
  const purchases = await readEmailPurchaseAssociations(db, id);
  return {
    id: parseShortcodeFor("email", message.shortcode),
    purchaseIds: purchases.map((row) => row.shortcode),
    purchaseAssociations: purchases.map((row) => ({
      purchaseId: row.shortcode,
      purchaseDeleted: row.purchaseDeleted,
      kind: row.kind,
    })),
    acceptedSourceOrders: await readEmailAcceptedSourceOrders(db, id),
    financialAssociations: await readEmailFinancialAssociations(db, id),
  };
}

export async function readMail(
  db: Database,
  rawInput: MailReadInput,
  actor: ActorContext,
) {
  const input = mailReadInput.parse(rawInput);
  if (!actor.runId) {
    const parties = await memberPartyIds(db, actor.userId);
    const [source] = await getDb(db)
      .select({ email: emailTable, originalId: orderMail.id })
      .from(emailTable)
      .leftJoin(orderMail, retainedMailJoin)
      .where(
        and(
          inArray(emailTable.ledgerPartyId, parties),
          eq(emailTable.provider, "gmail"),
          eq(emailTable.mailboxId, input.mailboxId),
          eq(emailTable.messageId, input.messageId),
          notDeleted(emailTable),
        ),
      )
      .limit(1);
    if (
      source &&
      (!source.originalId ||
        source.email.classification === "unrelated" ||
        source.email.contentClearedAt)
    ) {
      const { readEmailOriginalTransient } = await import("./gmail/real-time");
      return mailReadOut.parse({
        ...(await readEmailOriginalTransient(db, input, actor)),
        ...(await associationsForMail(db, source.email)),
      });
    }
  }
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
  return mailReadOut.parse({
    mailboxId: mail.mailboxId,
    messageId: mail.messageId,
    threadId: mail.threadId,
    checksum: mail.rawChecksum,
    sender: mail.sender,
    subject: mail.subject,
    receivedAt: mail.receivedAt?.toISOString() ?? null,
    content: mail.content,
    attachments: attachments.map(({ id: _id, ...row }) => row),
    originalAttachment: original,
    boundToRun: importRunId !== null,
    ...(await associationsForMail(db, mail)),
  });
}

function isPrintableShippingLabel(
  filename: string,
  subject: RetainedMail["subject"],
) {
  const name = filename.replace(/[._-]+/g, " ");
  // Accounting evidence in a label Email still belongs on the Purchase.
  if (/\b(?:receipt|invoice)\b/i.test(name)) return false;
  const labelPurpose = /\b(?:shipping|postage|return)\s*labels?\b/i;
  return (
    labelPurpose.test(name) ||
    (/\blabels?\b/i.test(name) && labelPurpose.test(subject ?? ""))
  );
}

/** Retained evidence files become Purchase documents; printable labels stay with the Email. */
async function attachRetainedSource(
  db: Database,
  input: {
    orderMailId: string;
    purchaseId: string;
    purchaseShortcode: string;
    subject: RetainedMail["subject"];
  },
) {
  const rows = await getDb(db)
    .select()
    .from(orderMailAttachment)
    .where(eq(orderMailAttachment.orderMailId, input.orderMailId));
  for (const attachment of rows) {
    if (isPrintableShippingLabel(attachment.filename, input.subject)) continue;
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
 * dismissal of this Email for the Purchase refuses the link.
 */
export async function linkOrderMail(
  db: Database,
  input: {
    mail: RetainedMail;
    purchaseId: string;
    event: MailEvent;
    actorUserId: string;
    /** `agent` for a `mail.resolve` session or Pi, `import` for a commit. */
    proposedBy: "agent" | "import";
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
  // A member's dismissal of this Email for this Purchase, on any of its
  // events, wins over a later automatic or session link.
  const [dismissed] = await tx
    .select({ id: orderMailCandidateDecision.id })
    .from(orderMailCandidateDecision)
    .innerJoin(
      orderMailEvent,
      eq(orderMailEvent.id, orderMailCandidateDecision.eventId),
    )
    .where(
      and(
        eq(orderMailEvent.orderMailId, input.mail.id),
        eq(orderMailCandidateDecision.purchaseId, chosen.id),
        eq(orderMailCandidateDecision.decision, "dismissed"),
      ),
    )
    .limit(1);
  if (dismissed)
    throw new Error(
      "A member dismissed this Email for that Purchase; review the Email before linking it.",
    );
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
      proposedBy: input.proposedBy,
    });
  await ensureMailVendorAccount(db, {
    vendorId: chosen.vendorId,
    ledgerPartyId: input.mail.ledgerPartyId,
  });
  await attachRetainedSource(db, {
    orderMailId: input.mail.id,
    purchaseId: chosen.id,
    purchaseShortcode: chosen.shortcode,
    subject: input.mail.subject,
  });
  return chosen;
}

function needsResolutionObservation(
  email: typeof emailTable.$inferSelect,
  classification: "unrelated" | undefined,
  reason: string,
) {
  return (
    classification !== undefined &&
    (email.classification !== classification ||
      email.classificationStage !== "resolution" ||
      email.classificationReason !== reason)
  );
}

/** Classification overrides preserve the prior prediction and append resolution history. */
export async function settleMail(
  db: Database,
  input: {
    mail: Pick<
      RetainedMail,
      "ledgerPartyId" | "mailboxId" | "messageId" | "rawChecksum"
    > &
      Partial<Pick<RetainedMail, "id">>;
    importRunId: RunId | null;
    status: "completed" | "blocked";
    classification?: "unrelated";
    /** What settled the Email: an import, a link, or the member-facing gap. */
    detail: string;
  },
) {
  if (input.importRunId && !input.mail.id)
    throw new Error(
      "A delegated Email settlement requires its retained source.",
    );
  return withTransaction(db, async (tx) => {
    const identity = and(
      eq(emailTable.ledgerPartyId, input.mail.ledgerPartyId),
      eq(emailTable.mailboxId, input.mail.mailboxId),
      eq(emailTable.messageId, input.mail.messageId),
      notDeleted(emailTable),
      input.importRunId ? eq(emailTable.runId, input.importRunId) : undefined,
    );
    const [initialEmail] = await tx
      .select()
      .from(emailTable)
      .where(identity)
      .limit(1);
    if (!initialEmail)
      throw new Error("Email assignment changed before settlement.");
    const [ownerRun] = initialEmail.runId
      ? await tx
          .select({ id: runTable.id, ledgerPartyId: runTable.ledgerPartyId })
          .from(runTable)
          .where(eq(runTable.id, initialEmail.runId))
          .for("update")
      : [];
    const [originalEmail] = await tx
      .select()
      .from(emailTable)
      .where(identity)
      .for("update");
    if (!originalEmail || originalEmail.runId !== initialEmail.runId)
      throw new Error("Email assignment changed before settlement.");
    if (
      !input.mail.id &&
      (originalEmail.checksum !== input.mail.rawChecksum ||
        originalEmail.classification !== "unrelated" ||
        originalEmail.orderMailId !== null)
    )
      throw new Error(
        "This disposed Email changed; read it again before resolving.",
      );
    const previous = input.classification
      ? await snapshotStoredEmailPrediction(tx, originalEmail)
      : null;
    const settled: Partial<typeof emailTable.$inferInsert> = {
      status: input.status,
      updatedAt: new Date(),
    };
    if (input.classification) {
      settled.classification = input.classification;
      settled.classificationStage = "resolution";
      settled.classificationReason = input.detail;
    }
    const settledEmails = await tx
      .update(emailTable)
      .set(settled)
      .where(identity)
      .returning({ id: emailTable.id });
    if (
      input.classification &&
      needsResolutionObservation(
        originalEmail,
        input.classification,
        input.detail,
      )
    ) {
      await tx.insert(emailClassificationObservation).values({
        ...emailClassificationObservationInput.parse({
          emailId: originalEmail.id,
          runId:
            ownerRun?.ledgerPartyId === originalEmail.ledgerPartyId
              ? ownerRun.id
              : null,
          checksum: originalEmail.checksum,
          classification: input.classification,
          stage: "resolution",
          reason: input.detail,
          classificationVersion: originalEmail.classificationVersion,
        }),
        createdAt: new Date(
          Math.max(Date.now(), (previous?.createdAt.getTime() ?? 0) + 1),
        ),
      });
    }
    if (input.importRunId && input.mail.id) {
      if (settledEmails.length !== 1)
        throw new Error("Email assignment changed before settlement.");
      const emailId = settledEmails[0]!.id;
      const fingerprint = await sha256Hex(
        JSON.stringify({
          emailId,
          checksum: input.mail.rawChecksum,
          status: input.status,
          classification: input.classification ?? null,
          detail: input.detail,
        }),
      );
      const now = new Date();
      await tx
        .insert(runOperation)
        .values({
          runId: input.importRunId,
          operationId: `mail-outcome:${emailId}:${fingerprint}`,
          kind: "target_outcome",
          state: "completed",
          inputFingerprint: fingerprint,
          startedAt: now,
          completedAt: now,
          result: runTargetOutcomeReceipt.parse({
            target: {
              entityKind: "email",
              entityId: emailId,
              workKey: input.mail.id,
              state: input.status === "completed" ? "completed" : "unresolved",
              outcome: input.status === "completed" ? "verified" : "ambiguous",
              warning: input.status === "blocked" ? input.detail : null,
              diff: null,
              completedAt: now.toISOString(),
              targetFingerprint: input.mail.rawChecksum,
            },
          }),
        })
        .onConflictDoNothing({
          target: [runOperation.runId, runOperation.operationId],
        });
    }
  });
}

/**
 * A repeated `unrelated` resolve whose original was already disposed of
 * replays from the Email: the retained Email it names is gone.
 */
async function disposedUnrelatedMail(
  db: Database,
  input: MailResolveInput,
  actor: ActorContext,
) {
  await mailImportRun(db, actor.runId);
  const [message] = await getDb(db)
    .select({
      ledgerPartyId: emailTable.ledgerPartyId,
      mailboxId: emailTable.mailboxId,
      messageId: emailTable.messageId,
      rawChecksum: emailTable.checksum,
    })
    .from(emailTable)
    .where(
      and(
        inArray(
          emailTable.ledgerPartyId,
          await memberPartyIds(db, actor.userId),
        ),
        eq(emailTable.mailboxId, input.mailboxId),
        eq(emailTable.messageId, input.messageId),
        eq(emailTable.checksum, input.checksum),
        eq(emailTable.classification, "unrelated"),
        isNull(emailTable.orderMailId),
      ),
    )
    .limit(1);
  return message;
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
    if (disposition.kind === "unrelated") {
      const disposed = await disposedUnrelatedMail(tdb, input, actor);
      if (disposed) {
        // A model's disposed negative is not yet the member's reviewed decision.
        if (!actor.runId)
          await settleMail(tdb, {
            mail: disposed,
            importRunId: null,
            status: "completed",
            classification: "unrelated",
            detail: `unrelated: ${disposition.reason}`,
          });
        return {
          mail: disposed,
          purchaseIds: [],
          status: "completed" as const,
        };
      }
    }
    const { mail, importRunId } = await ownedMail(tdb, input, actor, "update");
    if (mail.rawChecksum !== input.checksum)
      throw new Error(
        "This Email changed since it was read; read it again before resolving.",
      );
    if (disposition.kind === "linked") {
      if (disposition.settlement && disposition.event !== "refunded")
        throw new Error(
          "Settlement evidence requires a refunded lifecycle event.",
        );
      const ids = await Promise.all(
        disposition.purchaseIds.map((code) =>
          resolveOrThrow(tdb, "purchase", code),
        ),
      );
      if (new Set(ids).size !== ids.length)
        throw new Error("Purchase links must resolve to distinct Purchases.");
      const targets = await getDb(tdb)
        .select({
          id: purchase.id,
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
        .where(and(inArray(purchase.id, ids), notDeleted(purchase)))
        .orderBy(purchase.id)
        .for("update", { of: purchase });
      if (targets.length !== ids.length)
        throw new Error("A reviewed Purchase no longer exists.");
      if (
        targets.some(
          (row) =>
            row.accountPartyId && row.accountPartyId !== mail.ledgerPartyId,
        )
      )
        throw new Error(
          "The Email and a Purchase belong to different members.",
        );
      const [dismissed] = await getDb(tdb)
        .select({ id: orderMailCandidateDecision.id })
        .from(orderMailCandidateDecision)
        .innerJoin(
          orderMailEvent,
          eq(orderMailEvent.id, orderMailCandidateDecision.eventId),
        )
        .where(
          and(
            eq(orderMailEvent.orderMailId, mail.id),
            inArray(orderMailCandidateDecision.purchaseId, ids),
            eq(orderMailCandidateDecision.decision, "dismissed"),
          ),
        )
        .limit(1);
      if (dismissed)
        throw new Error(
          "A member dismissed this Email for a reviewed Purchase.",
        );
      const chosen = [];
      for (const id of [...ids].sort())
        chosen.push(
          await linkOrderMail(tdb, {
            mail,
            purchaseId: id,
            event: disposition.event,
            actorUserId: actor.userId,
            proposedBy: "agent",
          }),
        );
      if (disposition.settlement) {
        const message = await mailboxRow(tdb, mail);
        if (!message) throw new Error("The reviewed Email no longer exists.");
        await recordMailFinancialReview(
          tdb,
          {
            emailId: parseEntityId("email", message.id),
            checksum: input.checksum,
            purchaseIds: ids,
            review: disposition.settlement,
          },
          actor,
        );
      }
      await settleMail(tdb, {
        mail,
        importRunId,
        status: "completed",
        detail: `linked:${disposition.event}`,
      });
      return {
        mail,
        purchaseIds: chosen.map((row) => row.shortcode),
        status: "completed" as const,
      };
    }
    if (disposition.kind === "unresolved") {
      await settleMail(tdb, {
        mail,
        importRunId,
        status: "blocked",
        detail: disposition.reason,
      });
      return { mail, purchaseIds: [], status: "blocked" as const };
    }
    await settleMail(tdb, {
      mail,
      importRunId,
      status: "completed",
      classification: "unrelated",
      detail: `unrelated: ${disposition.reason}`,
    });
    return { mail, purchaseIds: [], status: "completed" as const };
  });
  // Disposal runs after the disposition commits; a protected original (one a
  // reviewed decision or import already uses) is kept. A disposal lost here
  // is retried by the daily catch-up (disposeUnrelatedOriginals).
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
    purchaseIds: settled.purchaseIds,
    financialAssociations: (await associationsForMail(db, settled.mail))
      .financialAssociations,
  });
}

/**
 * A mail-sourced import commit links its Email for the event it records. An
 * attachment's commit links its parent Email, by the Email's own checksum.
 */
export async function linkImportedMail(
  db: Database,
  input: {
    mail: RetainedMail;
    event: MailEvent;
    purchaseId: string;
    actorUserId: string;
    runId: RunId;
  },
) {
  const [mail] = await getDb(db)
    .select()
    .from(orderMail)
    .where(
      and(
        eq(orderMail.id, input.mail.id),
        eq(orderMail.rawChecksum, input.mail.rawChecksum),
      ),
    )
    .for("update")
    .limit(1);
  if (!mail)
    throw new Error(
      "The imported Email changed or was disposed of; read it again.",
    );
  await linkOrderMail(db, {
    mail: { ...input.mail, ...mail },
    purchaseId: input.purchaseId,
    event: input.event,
    actorUserId: input.actorUserId,
    proposedBy: "import",
  });
  await settleMail(db, {
    mail: { ...input.mail, ...mail },
    importRunId: await mailImportRun(db, input.runId),
    status: "completed",
    detail: "imported",
  });
}

/**
 * Pi's next admitted Email. Each Email stays the current item until
 * `mail.resolve` or a mail-sourced commit settles its target.
 */
export async function claimMailImportWork(db: Database, runId: string) {
  const id = runEntityId.parse(runId);
  const database = getDb(db);
  const [current] = await database
    .select({ shortcode: runTable.shortcode, status: runTable.status })
    .from(runTable)
    .where(eq(runTable.id, id))
    .limit(1);
  if (!current) throw new Error("Mail import Run was not found");
  if (current.status !== "running") return { kind: "none" as const };
  const pending = (await readMailRunSources(database, id))
    .filter(
      (source) =>
        source.owned &&
        source.unchanged &&
        source.email.status === "researching",
    )
    .map(({ email }) => ({
      mailboxId: email.mailboxId,
      messageId: email.messageId,
      sender: email.sender,
      subject: email.subject,
      receivedAt: email.receivedAt,
    }));
  const [next] = pending;
  if (!next) return { kind: "none" as const };
  return {
    kind: "email" as const,
    runId: current.shortcode,
    remaining: pending.length,
    email: { ...next, receivedAt: next.receivedAt?.toISOString() ?? null },
  };
}

/**
 * Scoped live Gmail search for a missing original. Spam and Trash are
 * excluded; under Pi's Mail import Run matches are classified exactly as
 * discovery would, while a member's own search retains each new match as an `uncertain`
 * candidate for the caller to settle with `mail.resolve` and leaves an Email
 * with a decided Relevance as it is. Search never advances mailbox coverage.
 */
export async function searchMail(
  db: Database,
  rawInput: MailSearchInput,
  actor: ActorContext,
) {
  const input = mailSearchInput.parse(rawInput);
  // Before any Gmail fetch or classification spends against the Run.
  await mailImportRun(db, actor.runId);
  const database = getDb(db);
  const connected = await database
    .select({ mailboxId: account.accountId })
    .from(account)
    .where(
      and(eq(account.userId, actor.userId), eq(account.providerId, "google")),
    )
    .orderBy(asc(account.id));
  const mailboxId =
    input.mailboxId ??
    (connected.length === 1 ? connected[0]?.mailboxId : undefined);
  if (!mailboxId)
    return {
      status: "mailbox_required" as const,
      mailboxes: connected.map((row) => row.mailboxId),
      messages: [],
      nextPageToken: null,
    };
  if (!connected.some((row) => row.mailboxId === mailboxId))
    throw new Error("That Google mailbox is not connected to this member.");
  const [party] = await memberPartyIds(db, actor.userId);
  if (!party) throw new Error("Only a household member can search Email.");
  try {
    const provider = await gmailProviderForUser(db, actor.userId, mailboxId);
    const request: Parameters<typeof provider.listMessages>[0] = {
      query: `(${input.query}) -in:spam -in:trash`,
      maxResults: GMAIL_PAGE_SIZE,
    };
    if (input.pageToken) request.pageToken = input.pageToken;
    const listed = await provider.listMessages(request);
    const messageIds = [
      ...new Set(listed.messages?.map((message) => message.id) ?? []),
    ];
    const ingest: Parameters<typeof ingestGmailMessages>[2] = {
      ledgerPartyId: party,
      mailboxId,
      messageIds,
    };
    // Pi's paid classification is billed to its Run; a member without a Run
    // gets rules only and judges each candidate through `mail.resolve`.
    if (actor.runId) ingest.runId = actor.runId;
    else ingest.callerJudges = true;
    await ingestGmailMessages(db, provider, ingest);
    const retained = messageIds.length
      ? await database
          .select({
            id: emailTable.shortcode,
            checksum: emailTable.checksum,
            messageId: emailTable.messageId,
            classification: emailTable.classification,
            status: emailTable.status,
            threadId: emailTable.threadId,
            sender: emailTable.sender,
            subject: emailTable.subject,
            receivedAt: emailTable.receivedAt,
          })
          .from(emailTable)
          .innerJoin(orderMail, retainedMailJoin)
          .where(
            and(
              eq(emailTable.ledgerPartyId, party),
              eq(emailTable.provider, "gmail"),
              notDeleted(emailTable),
              eq(emailTable.mailboxId, mailboxId),
              inArray(emailTable.messageId, messageIds),
            ),
          )
      : [];
    return mailSearchOut.parse({
      status: "ok",
      mailboxes: [mailboxId],
      messages: retained.map((row) => ({
        mailboxId,
        ...row,
        receivedAt: row.receivedAt?.toISOString() ?? null,
      })),
      nextPageToken: listed.nextPageToken ?? null,
    });
  } catch (error) {
    const reconnect =
      error instanceof GmailAuthorizationError ||
      (error instanceof GmailApiError &&
        (error.status === 401 ||
          (error.status === 403 &&
            error.reason === "insufficientPermissions")));
    if (!reconnect) throw error;
    return {
      status: "gmail_reconnect_required" as const,
      mailboxes: [mailboxId],
      messages: [],
      nextPageToken: null,
    };
  }
}
