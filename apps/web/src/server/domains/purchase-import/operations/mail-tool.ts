import {
  assessmentSubjects,
  mailImportOutcome,
} from "@cubby/schemas/assessment";
import type { ActorContext } from "@cubby/schemas/context";
/**
 * The public `mail` tool: read a member's retained Email and record what it
 * means for their Purchases. Pi's Mail import and a member's Claude/Codex
 * session call the same functions; Pi's calls are additionally bound to the
 * Emails its Mail import Run admitted.
 */
import {
  parseEntityId,
  parseShortcodeFor,
  type RunId,
  type UserId,
} from "@cubby/schemas/identifiers";
import {
  mailImportOutcomesInput,
  mailImportOutcomesOut,
} from "@cubby/schemas/mail-import-outcome";
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
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { z } from "zod";

import type { DecisionPort } from "~/server/ai/decision-model";
import type { Database } from "~/server/db";
import { account } from "~/server/db/auth.schema";
import {
  databaseForTransaction,
  getDb,
  withTransaction,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import {
  assessment,
  assessmentState,
  entityAttachment,
  ledgerParty,
  email as emailTable,
  orderMail,
  orderMailAttachment,
  assessmentEmailLink,
  orderMailEvent,
  purchase,
  runOperation,
  run as runTable,
  vendorAccount,
} from "~/server/db/schema";
import { readEmailFinancialAssociations } from "~/server/domains/email/repo/email-financial-associations";
import {
  readEmailAcceptedSourceOrders,
  readEmailPurchaseAssociations,
} from "~/server/domains/email/repo/email-purchase-associations";
import { attachFileToEntity } from "~/server/domains/image/repo/image-storage";
import {
  readRetainedMail,
  retainedMailJoin,
  type RetainedMail,
} from "~/server/domains/mail/repo/retained-mail";
import { GmailApiError } from "~/server/domains/purchase-import/repo/gmail/types";
import {
  assertMailRunMembership,
  assertMailRunReadAuthority,
} from "~/server/domains/purchase-import/repo/mail-run-membership";
import { recordShipmentEvidence } from "~/server/domains/shipment/repo/evidence";
import { createAppError } from "~/server/errors/app-error";
import { isSerializationFailure } from "~/server/errors/db-errors";
import { publishEmailLinkDecision } from "~/server/generic/assessment/repo/assessment-email-link";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import { loadMailAttachmentOriginal } from "../repo/gmail/attachment-original";
import {
  productionOrderMailAttachmentStorage,
  type OrderMailAttachmentStorage,
} from "../repo/gmail/attachment-storage";
import { ensureMailVendorAccount } from "../repo/gmail/mail-account";
import { recordEmailClassificationObservation } from "../repo/gmail/observations";
import { clearUnrelatedOriginal } from "../repo/gmail/persistence";
import { gmailProviderForUser } from "../repo/gmail/provider";
import { fitMailRead, mailReadContent } from "../repo/gmail/read-content";
import { GMAIL_PAGE_SIZE } from "../repo/gmail/sync";
import { GmailAuthorizationError } from "../repo/gmail/tokens";
import {
  assertMailFinancialEvidenceCurrent,
  type PreparedMailFinancialEvent,
} from "../repo/mail-financial-event";
import {
  recordMailFinancialEvidence,
  reconcileMailRefundReview,
} from "../repo/mail-financial-review";
import {
  importedMailJudgment,
  linkedMailJudgment,
  publishMailImportOutcome,
} from "../repo/mail-outcome/assessment";
import { ingestGmailMessages } from "../service/gmail/ingest";
import { prepareMailFinancialEvent } from "../service/mail-financial-event";
import {
  attachmentEvidenceFingerprint,
  prepareMailAttachmentDecisions,
  type PreparedMailAttachmentDecisions,
} from "./mail-attachment-purpose";
import {
  applyMailSourceAdmissions,
  mailAttributedToRecipient,
  prepareMailSourceAdmissions,
  type MailSourceAdmission,
} from "./mail-source-admission";

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
    throw createAppError(
      "MAIL_REQUEST_REFUSED",
      `This Mail import Run is no longer running (${row.deletedAt ? "deleted" : row.retiredAt ? "retired" : row.status}).`,
    );
  return row.id;
}

/**
 * The member's own retained Email. A Mail import Run may read its member's
 * Emails from the mailboxes it admitted but write only the Emails on its
 * roster; a member may touch any Email from their mailboxes.
 */
async function ownedMail(
  db: Database,
  ref: MailMessageRef,
  actor: ActorContext,
  lock: "update" | "share",
  access: "read" | "write" = "write",
): Promise<{
  mail: RetainedMail;
  importRunId: RunId | null;
  admitted: boolean;
}> {
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
    throw createAppError(
      "EMAIL_NOT_FOUND",
      `No retained Email ${ref.messageId} in mailbox ${ref.mailboxId} belongs to this member.`,
    );
  if (!importRunId) return { mail, importRunId, admitted: false };
  if (access === "read")
    return {
      mail,
      importRunId,
      ...(await assertMailRunReadAuthority(tx, importRunId, mail)),
    };
  await assertMailRunMembership(tx, importRunId, mail.id);
  return { mail, importRunId, admitted: true };
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
  if (!message)
    throw createAppError("EMAIL_NOT_FOUND", "The Email no longer exists.");
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

/** Read predictions separately so the original can be graded blind first. */
export async function readMailImportOutcomes(
  db: Database,
  raw: z.input<typeof mailImportOutcomesInput>,
  actor: ActorContext,
) {
  const input = mailImportOutcomesInput.parse(raw);
  const parties = await memberPartyIds(db, actor.userId);
  const [source] = parties.length
    ? await getDb(db)
        .select({ id: emailTable.id })
        .from(emailTable)
        .where(
          and(
            inArray(emailTable.ledgerPartyId, parties),
            eq(emailTable.provider, "gmail"),
            eq(emailTable.mailboxId, input.mailboxId),
            eq(emailTable.messageId, input.messageId),
            notDeleted(emailTable),
          ),
        )
        .limit(1)
    : [];
  if (!source)
    throw createAppError(
      "EMAIL_NOT_FOUND",
      "No Email in this mailbox belongs to this member.",
    );
  const rows = await getDb(db)
    .select({
      assessmentId: assessment.id,
      judgment: assessment.judgment,
      producer: assessment.producer,
      producerRun: runTable.shortcode,
      subject: assessment.subject,
      createdAt: assessment.createdAt,
    })
    .from(assessment)
    .innerJoin(assessmentState, eq(assessmentState.id, assessment.id))
    .leftJoin(runTable, eq(runTable.id, assessmentState.runId))
    .where(
      and(
        eq(assessmentState.family, "mail_import_outcome"),
        eq(assessmentState.entity, "email"),
        eq(assessmentState.recordId, source.id),
      ),
    )
    .orderBy(desc(assessment.createdAt), desc(assessment.id))
    .offset(input.offset)
    .limit(input.limit + 1);
  return mailImportOutcomesOut.parse({
    items: rows.slice(0, input.limit).map((row) => ({
      ...row,
      producer: row.producer
        ? {
            ...row.producer,
            runId: row.producer.runId ? row.producerRun : null,
          }
        : null,
      checksum: assessmentSubjects.mail_import_outcome.parse(row.subject)
        .checksum,
      createdAt: row.createdAt.toISOString(),
    })),
    nextOffset: rows.length > input.limit ? input.offset + input.limit : null,
  });
}

export async function readMail(
  db: Database,
  rawInput: MailReadInput,
  actor: ActorContext,
) {
  const input = mailReadInput.parse(rawInput);
  // A Run's coordinator reads compact text only: raw HTML pages cost ~30k
  // tokens each and stay in its context. Members keep includeHtml.
  if (actor.runId && input.includeHtml)
    throw createAppError(
      "MAIL_READ_HTML_RUN",
      "Run reads return compact text only; continue a long body with offset set to the previous nextOffset.",
    );
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
      const { readEmailOriginalTransient } =
        await import("../repo/gmail/real-time");
      return fitMailRead(
        mailReadOut.parse({
          ...(await readEmailOriginalTransient(db, input, actor)),
          ...(await associationsForMail(db, source.email)),
        }),
      );
    }
  }
  const { mail, attachments, admitted } = await withTransactionDatabase(
    db,
    async (tdb) => {
      const tx = getDb(tdb);
      const owned = await ownedMail(tdb, input, actor, "share", "read");
      const message = await mailboxRow(tdb, owned.mail);
      if (
        !message ||
        message.orderMailId !== owned.mail.id ||
        ["excluded", "deleted"].includes(message.status) ||
        message.classification === "unrelated"
      )
        throw createAppError(
          "MAIL_EVIDENCE_STALE",
          "This Email is no longer retained for purchases.",
        );
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
    throw createAppError(
      "MAIL_REQUEST_REFUSED",
      "That attachment does not belong to this Email.",
    );
  const original = requested
    ? await loadMailAttachmentOriginal(db, {
        orderMailId: mail.id,
        attachmentRef: requested.id,
      })
    : undefined;
  const read = mailReadOut.parse({
    mailboxId: mail.mailboxId,
    messageId: mail.messageId,
    threadId: mail.threadId,
    checksum: mail.rawChecksum,
    sender: mail.sender,
    subject: mail.subject,
    receivedAt: mail.receivedAt?.toISOString() ?? null,
    content: mailReadContent(mail.content, input),
    attachments: attachments.map(({ id: _id, ...row }) => row),
    originalAttachment: original,
    boundToRun: admitted,
    ...(await associationsForMail(db, mail)),
  });
  return fitMailRead(read);
}

/** Retained evidence files become Purchase documents; printable labels stay with the Email. */
async function attachRetainedSource(
  db: Database,
  input: {
    orderMailId: string;
    purchaseId: string;
    purchaseShortcode: string;
    prepared: PreparedMailAttachmentDecisions;
  },
) {
  const rows = await getDb(db)
    .select()
    .from(orderMailAttachment)
    .where(eq(orderMailAttachment.orderMailId, input.orderMailId));
  if (rows.length !== input.prepared.decisions.size)
    throw createAppError(
      "MAIL_EVIDENCE_STALE",
      "Email attachments changed after their purpose was reviewed; retry the link.",
    );
  for (const attachment of rows) {
    const decision = input.prepared.decisions.get(attachment.id);
    if (
      !decision ||
      decision.fingerprint !== attachmentEvidenceFingerprint(attachment)
    )
      throw createAppError(
        "MAIL_EVIDENCE_STALE",
        "Email attachment evidence changed after its purpose was reviewed; retry the link.",
      );
  }
  for (const attachment of rows) {
    if (!input.prepared.decisions.get(attachment.id)?.promote) continue;
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
async function linkOrderMail(
  db: Database,
  input: {
    mail: RetainedMail;
    purchaseId: string;
    event: MailEvent;
    actorUserId: string;
    /**
     * `agent` for a `purchase_import.mail_resolve` session or Pi, `import` for a commit,
     * `heuristic` for a Mail import rule (`rule` names its revision and Run).
     */
    proposedBy: "agent" | "import" | "heuristic";
    rule?: { revision: string; runId: RunId };
    /**
     * False for an Email whose transaction is not attributed to its
     * recipient: it may evidence the Purchase, but a forwarded copy never
     * establishes the recipient's Vendor relationship.
     */
    attributed?: boolean;
    attachmentDecisions: PreparedMailAttachmentDecisions;
  },
) {
  if (input.mail.rawChecksum !== input.attachmentDecisions.mailChecksum)
    throw createAppError(
      "MAIL_EVIDENCE_STALE",
      "Email evidence changed after its attachment purposes were reviewed; retry the link.",
    );
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
  if (!chosen)
    throw createAppError(
      "PURCHASE_NOT_FOUND",
      "That Purchase no longer exists.",
    );
  if (
    chosen.accountPartyId &&
    chosen.accountPartyId !== input.mail.ledgerPartyId
  )
    throw createAppError(
      "MAIL_REQUEST_REFUSED",
      "The Email and the Purchase belong to different members.",
    );
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
    .select({ id: assessmentEmailLink.id })
    .from(assessmentEmailLink)
    .innerJoin(
      orderMailEvent,
      eq(orderMailEvent.id, assessmentEmailLink.eventId),
    )
    .where(
      and(
        eq(orderMailEvent.orderMailId, input.mail.id),
        eq(assessmentEmailLink.purchaseId, chosen.id),
        eq(assessmentEmailLink.decision, "dismissed"),
      ),
    )
    .limit(1);
  if (dismissed)
    throw createAppError(
      "MAIL_REQUEST_REFUSED",
      "A member dismissed this Email for that Purchase; review the Email before linking it.",
    );
  // One accepted Purchase per event: an existing link elsewhere stays the
  // member's to change through review.
  const [other] = await tx
    .select({ purchaseId: assessmentEmailLink.purchaseId })
    .from(assessmentEmailLink)
    .where(
      and(
        eq(assessmentEmailLink.eventId, event.id),
        eq(assessmentEmailLink.decision, "linked"),
      ),
    )
    .limit(1);
  if (other && other.purchaseId !== chosen.id)
    throw createAppError(
      "MAIL_REQUEST_REFUSED",
      "This Email event is already linked to another Purchase; review it before relinking.",
    );
  if (!other)
    await publishEmailLinkDecision(
      db,
      {
        eventId: event.id,
        purchaseId: chosen.id,
        decision: "linked",
        evidenceChecksum: input.mail.rawChecksum,
        decidedByUserId: input.actorUserId,
        proposedBy: input.proposedBy,
      },
      "automatic",
      undefined,
      input.rule,
    );
  if (input.attributed !== false)
    await ensureMailVendorAccount(db, {
      vendorId: chosen.vendorId,
      ledgerPartyId: input.mail.ledgerPartyId,
    });
  await attachRetainedSource(db, {
    orderMailId: input.mail.id,
    purchaseId: chosen.id,
    purchaseShortcode: chosen.shortcode,
    prepared: input.attachmentDecisions,
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
    /** The Mail import rule revision that applied a classification. */
    ruleRevision?: string;
    judgment?: z.infer<typeof mailImportOutcome>;
  },
  actor?: ActorContext,
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
      throw createAppError(
        "MAIL_EVIDENCE_STALE",
        "Email assignment changed before settlement.",
      );
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
      throw createAppError(
        "MAIL_EVIDENCE_STALE",
        "Email assignment changed before settlement.",
      );
    if (
      !input.mail.id &&
      (originalEmail.checksum !== input.mail.rawChecksum ||
        originalEmail.classification !== "unrelated" ||
        originalEmail.orderMailId !== null)
    )
      throw createAppError(
        "MAIL_EVIDENCE_STALE",
        "This disposed Email changed; read it again before resolving.",
      );
    const settled: Partial<typeof emailTable.$inferInsert> = {
      status: input.status,
      updatedAt: new Date(),
    };
    if (input.classification) {
      settled.classification = input.classification;
      settled.classificationStage = "resolution";
      settled.classificationReason = input.detail;
    }
    if (
      input.classification &&
      needsResolutionObservation(
        originalEmail,
        input.classification,
        input.detail,
      )
    )
      await recordEmailClassificationObservation(
        databaseForTransaction(tx),
        {
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
          promptVersion: input.ruleRevision ?? null,
        },
        actor,
      );
    const settledEmails = await tx
      .update(emailTable)
      .set(settled)
      .where(identity)
      .returning({ id: emailTable.id });
    if (input.importRunId && input.mail.id) {
      if (settledEmails.length !== 1)
        throw createAppError(
          "MAIL_EVIDENCE_STALE",
          "Email assignment changed before settlement.",
        );
      const emailId = settledEmails[0]!.id;
      const judgment =
        input.judgment ??
        mailImportOutcome.parse(
          input.status === "blocked"
            ? { kind: "unresolved", reason: input.detail }
            : input.classification === "unrelated"
              ? {
                  kind: "unrelated",
                  reason: input.detail.replace(/^unrelated: /u, ""),
                }
              : input.detail.startsWith("linked:")
                ? {
                    kind: "linked",
                    event: input.detail.slice("linked:".length),
                    purchases: [],
                  }
                : { kind: "linked", event: "financial", purchases: [] },
        );
      await publishMailImportOutcome(databaseForTransaction(tx), {
        emailId,
        runId: input.importRunId,
        checksum: input.mail.rawChecksum,
        judgment,
        ruleRevision: input.ruleRevision,
      });
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
  decisionPort?: DecisionPort,
  /**
   * A Mail import rule settling the Email for its Run. It links only a
   * Purchase on the Email owner's own account at that Vendor, so recipient
   * attribution cannot change the write and is not judged.
   */
  rule?: { revision: string },
) {
  const input = mailResolveInput.parse(rawInput);
  const { disposition } = input;
  let attachmentDecisions: PreparedMailAttachmentDecisions | undefined;
  let admissions: MailSourceAdmission[] = [];
  let financialEvent: PreparedMailFinancialEvent | undefined;
  if (disposition.kind === "financial" && actor.runId) {
    const { mail } = await ownedMail(db, input, actor, "share");
    const message = await mailboxRow(db, mail);
    if (!message || mail.rawChecksum !== input.checksum)
      throw createAppError(
        "MAIL_EVIDENCE_STALE",
        "This Email changed since it was read; read it again before resolving.",
      );
    const prepared = await prepareMailFinancialEvent(
      db,
      { emailId: parseEntityId("email", message.id) },
      actor,
      { decide: decisionPort },
    );
    if (prepared.status !== "verified")
      throw createAppError(
        "MAIL_REQUEST_REFUSED",
        `Cubby cannot verify this Email's financial event: ${prepared.reason} Resolve it unresolved for member review.`,
      );
    financialEvent = prepared.preparation;
  }
  if (disposition.kind === "linked") {
    const { mail, importRunId } = await ownedMail(
      db,
      input,
      actor,
      "share",
      "read",
    );
    if (mail.rawChecksum !== input.checksum)
      throw createAppError(
        "MAIL_EVIDENCE_STALE",
        "This Email changed since it was read; read it again before resolving.",
      );
    if (disposition.via && !importRunId)
      throw createAppError(
        "MAIL_REQUEST_REFUSED",
        "via admits connecting Emails to a Mail import Run; this Email is not on one, so link it without via.",
      );
    if (importRunId && !rule)
      admissions = await prepareMailSourceAdmissions(
        db,
        importRunId,
        [{ ...input, via: disposition.via }],
        actor,
        decisionPort,
      );
    attachmentDecisions = await prepareMailAttachmentDecisions(
      db,
      mail,
      actor,
      decisionPort,
    );
  }
  const settled = await withTransactionDatabase(db, async (tdb) => {
    if (disposition.kind === "unrelated") {
      const disposed = await disposedUnrelatedMail(tdb, input, actor);
      if (disposed) {
        // A model's disposed negative is not yet the member's reviewed decision.
        if (!actor.runId)
          await settleMail(
            tdb,
            {
              mail: disposed,
              importRunId: null,
              status: "completed",
              classification: "unrelated",
              detail: `unrelated: ${disposition.reason}`,
            },
            actor,
          );
        return {
          mail: disposed,
          purchaseIds: [],
          status: "completed" as const,
        };
      }
    }
    const importRun = await mailImportRun(tdb, actor.runId);
    if (importRun)
      await applyMailSourceAdmissions(tdb, importRun, admissions, {
        requireAttribution: false,
      });
    const { mail, importRunId } = await ownedMail(tdb, input, actor, "update");
    if (mail.rawChecksum !== input.checksum)
      throw createAppError(
        "MAIL_EVIDENCE_STALE",
        "This Email changed since it was read; read it again before resolving.",
      );
    if (disposition.kind === "linked") {
      if (!attachmentDecisions)
        throw createAppError(
          "MAIL_REQUEST_REFUSED",
          "Email attachment purposes were not reviewed.",
        );
      const ids = await Promise.all(
        disposition.purchaseIds.map((code) =>
          resolveOrThrow(tdb, "purchase", code),
        ),
      );
      if (new Set(ids).size !== ids.length)
        throw createAppError(
          "MAIL_REQUEST_REFUSED",
          "Purchase links must resolve to distinct Purchases.",
        );
      const targets = await getDb(tdb)
        .select({
          id: purchase.id,
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
        .where(and(inArray(purchase.id, ids), notDeleted(purchase)))
        .orderBy(purchase.id)
        .for("update", { of: purchase });
      if (targets.length !== ids.length)
        throw createAppError(
          "PURCHASE_NOT_FOUND",
          "A reviewed Purchase no longer exists.",
        );
      if (
        targets.some(
          (row) =>
            row.accountPartyId && row.accountPartyId !== mail.ledgerPartyId,
        )
      )
        throw createAppError(
          "MAIL_REQUEST_REFUSED",
          "The Email and a Purchase belong to different members.",
        );
      const [dismissed] = await getDb(tdb)
        .select({ id: assessmentEmailLink.id })
        .from(assessmentEmailLink)
        .innerJoin(
          orderMailEvent,
          eq(orderMailEvent.id, assessmentEmailLink.eventId),
        )
        .where(
          and(
            eq(orderMailEvent.orderMailId, mail.id),
            inArray(assessmentEmailLink.purchaseId, ids),
            eq(assessmentEmailLink.decision, "dismissed"),
          ),
        )
        .limit(1);
      if (dismissed)
        throw createAppError(
          "MAIL_REQUEST_REFUSED",
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
            proposedBy: rule ? "heuristic" : "agent",
            rule:
              rule && importRunId
                ? { revision: rule.revision, runId: importRunId }
                : undefined,
            attachmentDecisions,
            attributed: mailAttributedToRecipient(
              admissions.find((admission) => admission.mail.id === mail.id),
            ),
          }),
        );
      if (disposition.shipments?.length) {
        const message = await mailboxRow(tdb, mail);
        if (!message)
          throw createAppError(
            "EMAIL_NOT_FOUND",
            "The reviewed Email no longer exists.",
          );
        for (const packet of disposition.shipments)
          await recordShipmentEvidence(
            tdb,
            {
              source: {
                kind: "email",
                emailId: parseShortcodeFor("email", message.shortcode),
                checksum: input.checksum,
              },
              purchaseId: packet.purchaseId,
              shipments: packet.shipments,
            },
            actor,
          );
      }
      if (disposition.event === "refunded") {
        const message = await mailboxRow(tdb, mail);
        if (!message)
          throw createAppError(
            "EMAIL_NOT_FOUND",
            "The reviewed Email no longer exists.",
          );
        // The reviewed refund set explains every refunded Purchase this
        // Email/checksum links, including links from earlier resolutions.
        const refunded = await getDb(tdb)
          .selectDistinct({ purchaseId: assessmentEmailLink.purchaseId })
          .from(assessmentEmailLink)
          .innerJoin(
            orderMailEvent,
            eq(orderMailEvent.id, assessmentEmailLink.eventId),
          )
          .where(
            and(
              eq(orderMailEvent.orderMailId, mail.id),
              eq(orderMailEvent.event, "refunded"),
              isNull(orderMailEvent.supersededAt),
              eq(assessmentEmailLink.decision, "linked"),
              eq(assessmentEmailLink.evidenceChecksum, input.checksum),
            ),
          );
        await reconcileMailRefundReview(
          tdb,
          {
            emailId: parseEntityId("email", message.id),
            checksum: input.checksum,
            purchaseIds: refunded.map((row) => row.purchaseId),
            review: disposition.settlement,
          },
          actor,
        );
      }
      await settleMail(
        tdb,
        {
          mail,
          importRunId,
          status: "completed",
          detail: `linked:${disposition.event}`,
          ruleRevision: rule?.revision,
          judgment: await linkedMailJudgment(tdb, {
            purchaseIds: ids,
            event: disposition.event,
          }),
        },
        actor,
      );
      return {
        mail,
        purchaseIds: chosen.map((row) => row.shortcode),
        status: "completed" as const,
      };
    }
    if (disposition.kind === "financial") {
      const message = await mailboxRow(tdb, mail);
      if (!message)
        throw createAppError(
          "EMAIL_NOT_FOUND",
          "The reviewed Email no longer exists.",
        );
      const emailId = parseEntityId("email", message.id);
      await recordMailFinancialEvidence(
        tdb,
        {
          emailId,
          checksum: input.checksum,
          transactionId: disposition.transactionId,
          reason: disposition.reason,
          review: disposition.review,
          event: financialEvent
            ? await assertMailFinancialEvidenceCurrent(
                tdb,
                financialEvent,
                actor,
              )
            : undefined,
        },
        actor,
      );
      await settleMail(
        tdb,
        {
          mail,
          importRunId,
          status: "completed",
          detail: `financial:${disposition.transactionId}`,
        },
        actor,
      );
      return { mail, purchaseIds: [], status: "completed" as const };
    }
    if (disposition.kind === "unresolved") {
      await settleMail(
        tdb,
        {
          mail,
          importRunId,
          status: "blocked",
          detail: disposition.reason,
        },
        actor,
      );
      return { mail, purchaseIds: [], status: "blocked" as const };
    }
    await settleMail(
      tdb,
      {
        mail,
        importRunId,
        status: "completed",
        classification: "unrelated",
        detail: `unrelated: ${disposition.reason}`,
        ruleRevision: rule?.revision,
      },
      actor,
    );
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
 * Link every Purchase reached by one Email commit, then publish its complete
 * outcome once. An attachment links its parent Email by the Email's checksum.
 */
export async function linkImportedMail(
  db: Database,
  input: {
    mail: RetainedMail;
    purchases: { event: MailEvent; purchaseId: string }[];
    actorUserId: string;
    runId: RunId;
    attachmentDecisions: PreparedMailAttachmentDecisions;
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
    throw createAppError(
      "MAIL_EVIDENCE_STALE",
      "The imported Email changed or was disposed of; read it again.",
    );
  for (const target of input.purchases)
    await linkOrderMail(db, {
      mail: { ...input.mail, ...mail },
      purchaseId: target.purchaseId,
      event: target.event,
      actorUserId: input.actorUserId,
      proposedBy: "import",
      attachmentDecisions: input.attachmentDecisions,
    });
  await settleMail(db, {
    mail: { ...input.mail, ...mail },
    importRunId: await mailImportRun(db, input.runId),
    status: "completed",
    detail: "imported",
    judgment: await importedMailJudgment(
      db,
      input.purchases.map((target) =>
        parseEntityId("purchase", target.purchaseId),
      ),
    ),
  });
}

/**
 * Scoped live Gmail search for a missing original. Spam and Trash are
 * excluded; under Pi's Mail import Run matches are classified exactly as
 * discovery would, while a member's own search retains each new match as an `uncertain`
 * candidate with durable classification work, preserving an existing decided Relevance. Search never advances mailbox coverage.
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
    throw createAppError(
      "MAIL_REQUEST_REFUSED",
      "That Google mailbox is not connected to this member.",
    );
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
    // Pi uses its existing Run. Member searches atomically enqueue classification
    // with each retained original, so a funding stop has durable work to resume.
    if (actor.runId) ingest.runId = actor.runId;
    else ingest.searchActor = actor;
    // One message at a time: a contention failure that outlasts the write's own
    // retries (the global Email-evidence lock, refresh Job rows) skips only that
    // message instead of failing the whole search.
    const retryableMessageIds: string[] = [];
    for (const messageId of messageIds) {
      try {
        await ingestGmailMessages(db, provider, {
          ...ingest,
          messageIds: [messageId],
        });
      } catch (error) {
        if (!isSerializationFailure(error)) throw error;
        retryableMessageIds.push(messageId);
      }
    }
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
            holderRun: runTable.shortcode,
            holderStatus: runTable.status,
          })
          .from(emailTable)
          .innerJoin(orderMail, retainedMailJoin)
          .leftJoin(runTable, eq(runTable.id, emailTable.runId))
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
      messages: retained.map(({ holderRun, holderStatus, ...row }) => ({
        mailboxId,
        ...row,
        receivedAt: row.receivedAt?.toISOString() ?? null,
        heldBy:
          holderRun && holderStatus
            ? { run: holderRun, status: holderStatus }
            : null,
      })),
      retryableMessageIds,
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
