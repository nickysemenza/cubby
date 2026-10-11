import type { EmailExecutionPolicy } from "@cubby/schemas/email-fields";
import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  mailboxCoverage,
  retainedMailContent,
  MAILBOX_RESEARCH_VERSION,
  type MailboxCoverage,
  type MailboxClassification,
  type MailboxClassificationStage,
  type EmailStatus,
} from "@cubby/schemas/mailbox-research";
import { sha256Hex } from "@cubby/shared/sha256";
import {
  and,
  arrayContains,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  ne,
  sql,
} from "drizzle-orm";

import { describeErrorCauses } from "~/lib/error-diagnostics";
import type { Database } from "~/server/db";
import { account } from "~/server/db/auth.schema";
import {
  mailboxCursor,
  email as emailTable,
  orderMail,
  orderMailAttachment,
  orderMailEvent,
  importSourceClaim,
  run,
} from "~/server/db/schema";
import {
  getDb,
  databaseForTransaction,
  notDeleted,
  withTransaction,
  withTransactionDatabase,
} from "~/server/repo/database-helpers";
import { runAfterCommit } from "~/server/repo/database-helpers/core";
import { hasAcceptedEmailAssociation } from "~/server/repo/email";
import {
  reserveMailAttachmentUpload,
  lockMailAttachmentUpload,
  finalizeMailAttachmentUpload,
  cleanupAbandonedMailAttachmentUploads,
} from "~/server/repo/mail-attachment-uploads";
import {
  readRetainedMail,
  retainedMailJoin,
} from "~/server/repo/retained-mail";
import { findOrCreateWithShortcode } from "~/server/repo/shortcode-utils";

import {
  assertMailSourceIdentityReady,
  HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION,
  mailSourceIdentityBlocked,
} from "../mail-source-identity";
import { readImportSourceClaimFamily } from "../source-claim-family";
import { deferClassificationRefresh } from "./admitted-source";
import {
  orderMailAttachmentKey,
  type OrderMailAttachmentStorage,
} from "./attachment-storage";
import { maxHistoryId } from "./sync";
import { GmailAuthorizationError } from "./tokens";
import type {
  GmailAccountTokenPatch,
  GmailAccountTokenRecord,
  GmailAccountTokenStore,
} from "./tokens";
import type {
  GmailOrderMail,
  GmailOrderMailAttachment,
  GmailOrderMailEvent,
} from "./types";

export const loadGmailCursor = async (
  db: Database,
  input: { ledgerPartyId: string; mailboxId: string; provider?: string },
): Promise<{ historyId: string | null; coverage: MailboxCoverage | null }> => {
  const [row] = await getDb(db)
    .select({
      historyId: mailboxCursor.historyId,
      coverage: mailboxCursor.coverage,
    })
    .from(mailboxCursor)
    .where(mailboxWhere(input))
    .limit(1);
  return {
    historyId: row?.historyId ?? null,
    coverage: row?.coverage ? mailboxCoverage.parse(row.coverage) : null,
  };
};

const mailboxWhere = (input: {
  ledgerPartyId: string;
  mailboxId: string;
  provider?: string;
}) =>
  and(
    eq(
      mailboxCursor.ledgerPartyId,
      parseEntityId("ledgerParty", input.ledgerPartyId),
    ),
    eq(mailboxCursor.provider, input.provider ?? "gmail"),
    eq(mailboxCursor.mailboxId, input.mailboxId),
  );

/** Compare-and-swap the complete coverage, including page tokens, under its row lock. */
export async function checkpointMailboxCoverage(
  db: Database,
  input: {
    ledgerPartyId: string;
    mailboxId: string;
    from: MailboxCoverage | null;
    to: MailboxCoverage;
  },
): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    await tx
      .insert(mailboxCursor)
      .values({
        ledgerPartyId: parseEntityId("ledgerParty", input.ledgerPartyId),
        provider: "gmail",
        mailboxId: input.mailboxId,
        historyId: null,
      })
      .onConflictDoNothing();
    const [current] = await tx
      .select({ coverage: mailboxCursor.coverage })
      .from(mailboxCursor)
      .where(mailboxWhere(input))
      .for("update")
      .limit(1);
    if (
      JSON.stringify(
        current?.coverage ? mailboxCoverage.parse(current.coverage) : null,
      ) !== JSON.stringify(input.from)
    )
      return false;
    await tx
      .update(mailboxCursor)
      .set({
        coverage: input.to,
        historyId: input.to.history.historyId,
        lastPolledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(mailboxWhere(input));
    return true;
  });
}

const messageWhere = (input: {
  ledgerPartyId: string;
  mailboxId: string;
  messageId: string;
}) =>
  and(
    eq(
      emailTable.ledgerPartyId,
      parseEntityId("ledgerParty", input.ledgerPartyId),
    ),
    eq(emailTable.provider, "gmail"),
    eq(emailTable.mailboxId, input.mailboxId),
    eq(emailTable.messageId, input.messageId),
  );
export async function readEmail(
  db: Database,
  input: { ledgerPartyId: string; mailboxId: string; messageId: string },
) {
  const [row] = await getDb(db)
    .select()
    .from(emailTable)
    .where(messageWhere(input))
    .limit(1);
  return row ?? null;
}
export async function saveEmail(
  db: Database,
  input: {
    ledgerPartyId: string;
    mailboxId: string;
    messageId: string;
    checksum: string;
    classification: MailboxClassification;
    classificationStage?: MailboxClassificationStage;
    classificationReason?: string;
    status: EmailStatus;
    orderMailId?: string | null;
  },
) {
  const fields = {
    checksum: input.checksum,
    classification: input.classification,
    classificationStage: input.classificationStage ?? null,
    classificationReason: input.classificationReason ?? null,
    classificationVersion: MAILBOX_RESEARCH_VERSION,
    status: input.status,
    orderMailId: input.orderMailId,
  };
  await withTransaction(db, async (tx) => {
    const { row, created } = await findOrCreateWithShortcode(tx, "email", {
      where: messageWhere(input),
      values: () => ({
        ledgerPartyId: parseEntityId("ledgerParty", input.ledgerPartyId),
        mailboxId: input.mailboxId,
        provider: "gmail",
        messageId: input.messageId,
        ...fields,
      }),
    });
    if (created) return;
    // Routine routing and provider removal cannot resolve historical ownership.
    await tx
      .update(emailTable)
      .set({ ...fields, updatedAt: new Date() })
      .where(
        and(
          eq(emailTable.id, row.id),
          or(
            isNull(emailTable.classificationVersion),
            ne(
              emailTable.classificationVersion,
              HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION,
            ),
          ),
        ),
      );
  });
}

/** A provider removal is a status observation, never a replacement classification or checksum. */
export async function markEmailRemoved(
  db: Database,
  input: {
    ledgerPartyId: string;
    mailboxId: string;
    messageId: string;
    status: "deleted" | "excluded";
  },
) {
  await withTransaction(db, async (tx) => {
    const { row } = await findOrCreateWithShortcode(tx, "email", {
      where: messageWhere(input),
      values: () => ({
        ledgerPartyId: parseEntityId("ledgerParty", input.ledgerPartyId),
        provider: "gmail",
        mailboxId: input.mailboxId,
        messageId: input.messageId,
        checksum: input.status,
        status: input.status,
      }),
    });
    if (row.classificationVersion === HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION)
      return;
    await tx
      .update(emailTable)
      .set({ status: input.status })
      .where(eq(emailTable.id, row.id));
  });
}

/** Headers survive content disposal; only an explicit member search renews its cache. */
export async function saveMailboxMetadata(
  db: Database,
  input: {
    ledgerPartyId: string;
    mail: GmailOrderMail;
    checksum: string;
    executionPolicy: EmailExecutionPolicy;
    memberSearch?: boolean;
  },
) {
  const identity = {
    ledgerPartyId: input.ledgerPartyId,
    mailboxId: input.mail.mailboxId,
    messageId: input.mail.messageId,
  };
  await withTransaction(db, async (tx) => {
    const { row } = await findOrCreateWithShortcode(tx, "email", {
      where: messageWhere(identity),
      values: () => ({
        ledgerPartyId: parseEntityId("ledgerParty", input.ledgerPartyId),
        provider: "gmail",
        mailboxId: identity.mailboxId,
        messageId: identity.messageId,
        checksum: input.checksum,
        status: "pending",
      }),
    });
    const fields = mailboxMetadataFields(input, row);
    const changed =
      (
        [
          "orderMailId",
          "sender",
          "subject",
          "threadId",
          "historyId",
          "executionPolicy",
          "searchOrigin",
        ] as const
      ).some((key) => fields[key] !== row[key]) ||
      fields.receivedAt?.getTime() !== row.receivedAt?.getTime() ||
      fields.searchExpiresAt?.getTime() !== row.searchExpiresAt?.getTime();
    if (changed)
      await tx
        .update(emailTable)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(emailTable.id, row.id));
  });
}

function mailboxMetadataFields(
  input: Parameters<typeof saveMailboxMetadata>[1],
  row: typeof emailTable.$inferSelect,
) {
  return {
    orderMailId: row.orderMailId,
    sender: input.mail.headers.from?.trim() || row.sender || null,
    subject: input.mail.headers.subject?.trim() || row.subject || null,
    receivedAt: dateFromInternalDate(input.mail.internalDate) ?? row.receivedAt,
    threadId: input.mail.threadId ?? row.threadId,
    historyId: input.mail.historyId ?? row.historyId,
    executionPolicy: input.executionPolicy,
    searchOrigin: input.memberSearch
      ? ("member_search" as const)
      : (row.searchOrigin ?? ("discovery" as const)),
    searchExpiresAt: input.memberSearch
      ? new Date(Date.now() + 7 * 86_400_000)
      : row.searchExpiresAt,
  };
}

/** Content disposal keeps identity, checksums and history; accepted evidence remains protected. */
export async function clearUnrelatedOriginal(
  db: Database,
  input: { ledgerPartyId: string; mailboxId: string; messageId: string },
  storage: OrderMailAttachmentStorage,
): Promise<{ orderMailId: string; checksum: string } | null> {
  return withTransaction(db, async (tx) => {
    const [original] = await readRetainedMail(
      tx,
      {
        ledgerPartyIds: [parseEntityId("ledgerParty", input.ledgerPartyId)],
        mailboxId: input.mailboxId,
        messageId: input.messageId,
      },
      "update",
    );
    if (!original) return null;
    const protectedOriginal = {
      orderMailId: original.id,
      checksum: original.rawChecksum,
    };
    if (await mailSourceIdentityBlocked(tx, original)) return protectedOriginal;
    if (await hasAcceptedEmailAssociation(tx, input)) return protectedOriginal;
    const attachments = await tx
      .select({
        id: orderMailAttachment.id,
        key: orderMailAttachment.pendingObjectKey,
        imageId: orderMailAttachment.imageId,
      })
      .from(orderMailAttachment)
      .where(eq(orderMailAttachment.orderMailId, original.id))
      .orderBy(asc(orderMailAttachment.id))
      .for("update");
    for (const attachment of attachments)
      if (attachment.key && !attachment.imageId) {
        const key = attachment.key;
        await tx
          .update(orderMailAttachment)
          .set({
            pendingObjectKey: null,
            pendingDeleteKeys: sql`array_append(${orderMailAttachment.pendingDeleteKeys}, ${key})`,
          })
          .where(eq(orderMailAttachment.id, attachment.id));
        await runAfterCommit(databaseForTransaction(tx), async (committedDb) =>
          deleteRetiredAttachmentKey(committedDb, storage, {
            id: attachment.id,
            key,
          }),
        );
      }
    await tx
      .update(orderMail)
      .set({
        content: {
          snippet: null,
          bodyText: null,
          bodyHtml: null,
          headers: original.content.headers,
        },
      })
      .where(eq(orderMail.id, original.id));
    await tx
      .update(emailTable)
      .set({ contentClearedAt: new Date() })
      .where(messageWhere(input));
    return null;
  });
}

/** Only the exact retired upload is disposable; its durable receipt survives errors/crashes. */
async function deleteRetiredAttachmentKey(
  db: Database,
  storage: OrderMailAttachmentStorage,
  retired: Pick<typeof orderMailAttachment.$inferSelect, "id"> & {
    key: string;
  },
) {
  const [pending] = await getDb(db)
    .select({ key: orderMailAttachment.pendingObjectKey })
    .from(orderMailAttachment)
    .where(
      and(
        eq(orderMailAttachment.id, retired.id),
        arrayContains(orderMailAttachment.pendingDeleteKeys, [retired.key]),
      ),
    )
    .limit(1);
  if (!pending || pending.key === retired.key) return;
  await storage.delete(retired.key);
  await getDb(db)
    .update(orderMailAttachment)
    .set({
      pendingDeleteKeys: sql`array_remove(${orderMailAttachment.pendingDeleteKeys}, ${retired.key})`,
    })
    .where(eq(orderMailAttachment.id, retired.id));
}

/** A correction can restore readable bytes while unrelated retired uploads still need disposal. */
async function retryRetiredAttachmentKeys(
  db: Database,
  storage: OrderMailAttachmentStorage,
) {
  const pending = await getDb(db)
    .select({
      id: orderMailAttachment.id,
      keys: orderMailAttachment.pendingDeleteKeys,
    })
    .from(orderMailAttachment)
    .where(sql`cardinality(${orderMailAttachment.pendingDeleteKeys}) > 0`)
    .orderBy(asc(orderMailAttachment.createdAt), asc(orderMailAttachment.id));
  const failures: unknown[] = [];
  for (const row of pending)
    for (const key of row.keys) {
      try {
        await deleteRetiredAttachmentKey(db, storage, { id: row.id, key });
      } catch (error) {
        failures.push(error);
      }
    }
  return failures;
}

/**
 * Durable retry for disposal: an unrelated Email whose original
 * survived (disposal failed after its disposition committed) is disposed of
 * again; a protected original is kept, as at resolve time.
 */
export async function disposeUnrelatedOriginals(
  db: Database,
  storage: OrderMailAttachmentStorage,
) {
  const failures = await retryRetiredAttachmentKeys(db, storage);
  try {
    await cleanupAbandonedMailAttachmentUploads(db, storage);
  } catch (error) {
    failures.push(error);
  }
  const retained = await getDb(db)
    .select({
      ledgerPartyId: emailTable.ledgerPartyId,
      mailboxId: emailTable.mailboxId,
      messageId: emailTable.messageId,
    })
    .from(emailTable)
    .where(
      and(
        eq(emailTable.classification, "unrelated"),
        isNotNull(emailTable.orderMailId),
        isNull(emailTable.contentClearedAt),
      ),
    );
  for (const message of retained) {
    try {
      await clearUnrelatedOriginal(db, message, storage);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      failures
        .flatMap((error) =>
          describeErrorCauses(error).causes.map((cause) => cause.message),
        )
        .join("\n"),
    );
  return retained.length;
}

/** Expiry disposes abandoned member-search caches; assigned import evidence stays frozen. */
export async function disposeExpiredSearchOriginals(
  db: Database,
  storage: OrderMailAttachmentStorage,
  now = new Date(),
) {
  const expired = await getDb(db)
    .select({ id: emailTable.id, runId: emailTable.runId })
    .from(emailTable)
    .where(
      and(
        eq(emailTable.searchOrigin, "member_search"),
        lte(emailTable.searchExpiresAt, now),
        isNull(emailTable.contentClearedAt),
      ),
    );
  let cleared = 0;
  const failures: unknown[] = [];
  for (const candidate of expired) {
    try {
      const disposed = await withTransactionDatabase(db, async (tx) => {
        // Mail reads and controls lock Run before Email. A changed assignment is
        // preserved for the next pass instead of acquiring another Run out of order.
        if (candidate.runId)
          await getDb(tx)
            .select({ id: run.id })
            .from(run)
            .where(eq(run.id, candidate.runId))
            .for("share");
        const [email] = await getDb(tx)
          .select()
          .from(emailTable)
          .where(
            and(
              eq(emailTable.id, candidate.id),
              eq(emailTable.searchOrigin, "member_search"),
              lte(emailTable.searchExpiresAt, now),
              isNull(emailTable.contentClearedAt),
            ),
          )
          .for("update")
          .limit(1);
        if (
          !email ||
          email.runId !== candidate.runId ||
          (await deferClassificationRefresh(
            tx,
            "classification_only",
            email,
          )) ||
          (await hasAcceptedEmailAssociation(tx, email))
        )
          return false;
        if (await clearUnrelatedOriginal(tx, email, storage)) return false;
        await getDb(tx)
          .update(emailTable)
          .set({ contentClearedAt: now })
          .where(eq(emailTable.id, email.id));
        return true;
      });
      if (disposed) cleared += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      failures
        .flatMap((error) =>
          describeErrorCauses(error).causes.map((cause) => cause.message),
        )
        .join("\n"),
    );
  return cleared;
}

class GmailPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailPersistenceError";
  }
}

const dateFromInternalDate = (value: string | null): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new GmailPersistenceError(
      "Gmail message has an invalid internal date",
    );
  }
  return date;
};

/** Email serializes shell acquisition; retries update its content pointer in place. */
export const upsertOrderMail = async (
  db: Database,
  ledgerPartyId: string,
  mail: GmailOrderMail,
  originalChecksum?: string,
): Promise<string> => {
  const ownerId = parseEntityId("ledgerParty", ledgerPartyId);
  const fields = {
    rawChecksum: originalChecksum ?? (await sha256Hex(JSON.stringify(mail))),
    content: retainedMailContent.parse({
      snippet: mail.snippet,
      bodyText: mail.bodyText,
      bodyHtml: mail.bodyHtml,
      headers: mail.headers,
    }),
  };
  return withTransaction(db, async (tx) => {
    const [email] = await tx
      .select()
      .from(emailTable)
      .where(
        and(
          messageWhere({
            ledgerPartyId,
            mailboxId: mail.mailboxId,
            messageId: mail.messageId,
          }),
          notDeleted(emailTable),
        ),
      )
      .for("update")
      .limit(1);
    if (!email)
      throw new GmailPersistenceError("Gmail original has no live Email owner");
    const [existing] = email.orderMailId
      ? await readRetainedMail(
          tx,
          {
            ledgerPartyIds: [ownerId],
            mailboxId: mail.mailboxId,
            messageId: mail.messageId,
            orderMailIds: [email.orderMailId],
          },
          "update",
        )
      : [];
    if (email.orderMailId && !existing)
      throw new GmailPersistenceError(
        "Gmail Email original pointer is outside its owner",
      );
    if (existing) await assertMailSourceIdentityReady(tx, existing);
    const [row] = existing
      ? await tx
          .update(orderMail)
          .set({ ...fields, updatedAt: new Date() })
          .where(eq(orderMail.id, existing.id))
          .returning()
      : await tx
          .insert(orderMail)
          .values({ ledgerPartyId: ownerId, ...fields })
          .returning();
    if (!row)
      throw new GmailPersistenceError("Gmail mail upsert returned no id");
    await assertMailSourceIdentityReady(tx, {
      ...row,
      mailboxId: email.mailboxId,
      messageId: email.messageId,
    });
    await tx
      .update(emailTable)
      .set({ orderMailId: row.id })
      .where(eq(emailTable.id, email.id));
    const family = await readImportSourceClaimFamily(
      tx,
      {
        ledgerPartyId: row.ledgerPartyId,
        kind: "mail_message",
        externalKey: `gmail:${email.mailboxId}:${email.messageId}`,
      },
      { lock: "update", writable: true },
    );
    if (family && family.root.checksum !== row.rawChecksum)
      await tx
        .update(importSourceClaim)
        .set({ checksum: row.rawChecksum, updatedAt: new Date() })
        .where(eq(importSourceClaim.id, family.root.id));
    return row.id;
  });
};

/**
 * Rows saved before part identity are keyed by Gmail's attachment id, which
 * changes on every fetch. Re-key the oldest such row of this message with the
 * same filename and type to the part, keeping its id, stored bytes and image
 * link, so a re-fetched legacy message neither duplicates the row nor stores
 * (or later attaches) its bytes twice. True when the adopted row needs no
 * fetch.
 */
const adoptLegacyAttachment = async (
  database: ReturnType<typeof getDb>,
  input: { orderMailId: string; attachment: GmailOrderMailAttachment },
): Promise<boolean> => {
  const [adopted] = await database
    .update(orderMailAttachment)
    .set({
      providerAttachmentId: input.attachment.sourceKey,
      updatedAt: new Date(),
    })
    .where(
      eq(
        orderMailAttachment.id,
        sql`(SELECT a.id FROM "OrderMailAttachment" a
          WHERE a."orderMailId" = ${input.orderMailId}
            AND (a."providerAttachmentId" NOT LIKE 'gmail:%' OR a."providerAttachmentId" LIKE 'gmail:me:%')
            AND a.filename = ${input.attachment.filename}
            AND a."mimeType" = ${input.attachment.mimeType}
          ORDER BY a."createdAt", a.id LIMIT 1)`,
      ),
    )
    .returning({
      pendingObjectKey: orderMailAttachment.pendingObjectKey,
      imageId: orderMailAttachment.imageId,
    });
  return Boolean(adopted?.pendingObjectKey || adopted?.imageId);
};

/** Stage only missing bytes; adoption itself remains inside the publication transaction. */
export async function attachmentHasRetainedBytes(
  db: Database,
  input: { orderMailId: string; attachment: GmailOrderMailAttachment },
) {
  const rows = await getDb(db)
    .select()
    .from(orderMailAttachment)
    .where(eq(orderMailAttachment.orderMailId, input.orderMailId))
    .orderBy(asc(orderMailAttachment.createdAt), asc(orderMailAttachment.id));
  const row =
    rows.find(
      (part) => part.providerAttachmentId === input.attachment.sourceKey,
    ) ??
    rows.find(
      (part) =>
        (!part.providerAttachmentId.startsWith("gmail:") ||
          part.providerAttachmentId.startsWith("gmail:me:")) &&
        part.filename === input.attachment.filename &&
        part.mimeType === input.attachment.mimeType,
    );
  return Boolean(row?.pendingObjectKey || row?.imageId);
}

/** Register only missing staged payloads before publication can PUT any bytes.
 * Reservations outlive enclosing rollbacks; unused attempts are reaped daily. */
export async function reserveGmailAttachmentUploads(
  db: Database,
  input: {
    orderMailId: string | null;
    attachments: readonly GmailOrderMailAttachment[];
    payloads: ReadonlyMap<string, string>;
  },
): Promise<ReadonlyMap<string, string>> {
  const keys = new Map<string, string>();
  for (const attachment of input.attachments) {
    if (!(attachment.dataBase64Url ?? input.payloads.get(attachment.sourceKey)))
      continue;
    if (
      input.orderMailId &&
      (await attachmentHasRetainedBytes(db, {
        orderMailId: input.orderMailId,
        attachment,
      }))
    )
      continue;
    const attemptId = crypto.randomUUID();
    const key = `${orderMailAttachmentKey(crypto.randomUUID())}/${attemptId}`;
    await reserveMailAttachmentUpload(db, { key, attemptId });
    keys.set(attachment.sourceKey, key);
  }
  return keys;
}

/** Store staged originals under a durable per-upload reservation. Existing
 * current/promoted keys are read verbatim and skipped before any PUT. */
export const storeOrderMailAttachment = async (
  db: Database,
  input: {
    orderMailId: string;
    attachment: GmailOrderMailAttachment;
    fetchData: () => Promise<string | undefined>;
    uploadKey?: string;
    storage: OrderMailAttachmentStorage;
  },
): Promise<void> => {
  const database = getDb(db);
  const { orderMailId } = input;
  const providerAttachmentId = input.attachment.sourceKey;
  const [existing] = await database
    .select({
      pendingObjectKey: orderMailAttachment.pendingObjectKey,
      imageId: orderMailAttachment.imageId,
    })
    .from(orderMailAttachment)
    .where(
      and(
        eq(orderMailAttachment.orderMailId, orderMailId),
        eq(orderMailAttachment.providerAttachmentId, providerAttachmentId),
      ),
    )
    .limit(1);
  if (existing?.pendingObjectKey || existing?.imageId) return;
  if (!existing && (await adoptLegacyAttachment(database, input))) return;
  const data = await input.fetchData();
  const bytes = data ? Buffer.from(data, "base64url") : null;
  const checksum = await sha256Hex(
    bytes ?? JSON.stringify({ sourceKey: providerAttachmentId, data: null }),
  );
  const fields = {
    filename: input.attachment.filename,
    mimeType: input.attachment.mimeType,
    checksum,
  };
  const [row] = await database
    .insert(orderMailAttachment)
    .values({ orderMailId, providerAttachmentId, ...fields })
    .onConflictDoUpdate({
      target: [
        orderMailAttachment.orderMailId,
        orderMailAttachment.providerAttachmentId,
      ],
      set: { ...fields, updatedAt: new Date() },
    })
    .returning({ id: orderMailAttachment.id });
  if (!row) throw new GmailPersistenceError("Attachment upsert had no id");
  if (!bytes) return;
  const key = input.uploadKey;
  if (!key)
    throw new GmailPersistenceError(
      "Attachment upload has no durable reservation",
    );
  await lockMailAttachmentUpload(db, key);
  await input.storage.put(key, bytes, input.attachment.mimeType);
  await database
    .update(orderMailAttachment)
    .set({ pendingObjectKey: key })
    .where(eq(orderMailAttachment.id, row.id));
  await finalizeMailAttachmentUpload(db, key);
};

/**
 * Record history changes for messages Cubby saved. An event for a message it
 * never saved (deleted before it was fetched, or never listed) is dropped and
 * counted: rejecting it would hold the mailbox cursor back forever.
 */
export const persistGmailEvents = async (
  db: Database,
  input: {
    ledgerPartyId: string;
    mailboxId: string;
    events: readonly GmailOrderMailEvent[];
  },
): Promise<{ saved: number; dropped: number }> => {
  if (input.events.length === 0) return { saved: 0, dropped: 0 };
  const ledgerPartyId = parseEntityId("ledgerParty", input.ledgerPartyId);
  return withTransaction(db, async (tx) => {
    const known = new Map(
      (
        await tx
          .select({ messageId: emailTable.messageId, id: orderMail.id })
          .from(orderMail)
          .innerJoin(emailTable, retainedMailJoin)
          .where(
            and(
              eq(orderMail.ledgerPartyId, ledgerPartyId),
              eq(emailTable.provider, "gmail"),
              notDeleted(emailTable),
              eq(emailTable.mailboxId, input.mailboxId),
              inArray(emailTable.messageId, [
                ...new Set(input.events.map((event) => event.messageId)),
              ]),
            ),
          )
      ).map((row) => [row.messageId, row.id]),
    );
    let saved = 0;
    for (const event of input.events) {
      const orderMailId = known.get(event.messageId);
      if (!orderMailId) continue;
      await tx
        .insert(orderMailEvent)
        .values({
          orderMailId,
          event: event.kind,
          occurredAt: null,
          sourceKey: event.sourceKey,
          payload: {
            mailboxId: event.mailboxId,
            historyId: event.historyId,
            messageId: event.messageId,
            threadId: event.threadId,
            labelIds: event.labelIds,
          },
        })
        .onConflictDoNothing();
      saved += 1;
    }
    return { saved, dropped: input.events.length - saved };
  });
};

/**
 * Move a mailbox cursor from the position a pass started at. Returns false
 * when another pass already moved it, so a retried or stale pass can never
 * rewind it; the stored id is the later of the two either way.
 */
export const advanceMailboxCursor = async (
  db: Database,
  input: {
    ledgerPartyId: string;
    provider?: string;
    mailboxId: string;
    from: string | null;
    to: string | null;
    polledAt: Date;
  },
): Promise<boolean> => {
  const ledgerPartyId = parseEntityId("ledgerParty", input.ledgerPartyId);
  const provider = input.provider ?? "gmail";
  const next = maxHistoryId(input.from, input.to ?? undefined);
  return withTransaction(db, async (tx) => {
    // The row must exist before it can be locked: two first passes would
    // otherwise both see no row and the later upsert could rewind the other.
    await tx
      .insert(mailboxCursor)
      .values({
        ledgerPartyId,
        provider,
        mailboxId: input.mailboxId,
        historyId: null,
      })
      .onConflictDoNothing();
    const [current] = await tx
      .select({ historyId: mailboxCursor.historyId })
      .from(mailboxCursor)
      .where(
        and(
          eq(mailboxCursor.ledgerPartyId, ledgerPartyId),
          eq(mailboxCursor.provider, provider),
          eq(mailboxCursor.mailboxId, input.mailboxId),
        ),
      )
      .for("update")
      .limit(1);
    if ((current?.historyId ?? null) !== input.from) return false;
    await tx
      .update(mailboxCursor)
      .set({
        historyId: next,
        lastPolledAt: input.polledAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(mailboxCursor.ledgerPartyId, ledgerPartyId),
          eq(mailboxCursor.provider, provider),
          eq(mailboxCursor.mailboxId, input.mailboxId),
        ),
      );
    return true;
  });
};

/** Better Auth account-table adapter; token refresh itself remains injectable. */
export const createBetterAuthGmailAccountStore = (
  db: Database,
  mailboxId?: string,
): GmailAccountTokenStore => ({
  async findGoogleAccount(userId): Promise<GmailAccountTokenRecord | null> {
    const row = await db
      .clientForRepository()
      .select({
        userId: account.userId,
        providerId: account.providerId,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        accessTokenExpiresAt: account.accessTokenExpiresAt,
      })
      .from(account)
      .where(
        and(
          eq(account.userId, userId),
          eq(account.providerId, "google"),
          mailboxId ? eq(account.accountId, mailboxId) : undefined,
        ),
      )
      .orderBy(account.id)
      .limit(1);
    return row[0] ?? null;
  },
  async updateGoogleAccount(userId, patch: GmailAccountTokenPatch) {
    const database = db.clientForRepository();
    const where = and(
      eq(account.userId, userId),
      eq(account.providerId, "google"),
      mailboxId ? eq(account.accountId, mailboxId) : undefined,
    );
    const [selected] = await database
      .select({ id: account.id })
      .from(account)
      .where(where)
      .orderBy(account.id)
      .limit(1);
    if (!selected)
      throw new GmailAuthorizationError(
        "The connected Google account was removed during token refresh.",
      );
    if (patch.refreshToken) {
      await database
        .update(account)
        .set({
          accessToken: patch.accessToken,
          accessTokenExpiresAt: patch.accessTokenExpiresAt,
          refreshToken: patch.refreshToken,
          updatedAt: new Date(),
        })
        .where(eq(account.id, selected.id));
      return;
    }
    await database
      .update(account)
      .set({
        accessToken: patch.accessToken,
        accessTokenExpiresAt: patch.accessTokenExpiresAt,
        updatedAt: new Date(),
      })
      .where(eq(account.id, selected.id));
  },
});
