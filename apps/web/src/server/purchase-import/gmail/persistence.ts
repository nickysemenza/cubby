import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, eq, inArray } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { account } from "~/server/db/auth.schema";
import {
  mailboxCursor,
  orderMail,
  orderMailAttachment,
  orderMailEvent,
} from "~/server/db/schema";
import { getDb, withTransaction } from "~/server/repo/database-helpers";

import type {
  GmailAccountTokenPatch,
  GmailAccountTokenRecord,
  GmailAccountTokenStore,
} from "./tokens";
import type {
  GmailOrderMail,
  GmailOrderMailAttachment,
  GmailSyncResult,
} from "./types";

export const loadGmailCursor = async (
  db: Database,
  input: { ledgerPartyId: string; provider?: string },
): Promise<{ historyId: string | null }> => {
  const row = await db
    .clientForRepository()
    .select({ historyId: mailboxCursor.historyId })
    .from(mailboxCursor)
    .where(
      and(
        eq(
          mailboxCursor.ledgerPartyId,
          parseEntityId("ledgerParty", input.ledgerPartyId),
        ),
        eq(mailboxCursor.provider, input.provider ?? "gmail"),
      ),
    )
    .limit(1);
  return { historyId: row[0]?.historyId ?? null };
};

const sha256 = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const dateFromInternalDate = (value: string | null): Date => {
  if (!value)
    throw new GmailPersistenceError("Gmail message has no internal date");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new GmailPersistenceError(
      "Gmail message has an invalid internal date",
    );
  }
  return date;
};

const header = (mail: GmailOrderMail, name: string): string =>
  mail.headers[name.toLowerCase()]?.trim() || "(unknown)";

const attachmentProviderId = (attachment: GmailOrderMailAttachment): string =>
  attachment.attachmentId?.trim() || `inline:${attachment.sourceKey}`;

const attachmentChecksum = async (
  attachment: GmailOrderMailAttachment,
): Promise<string> =>
  sha256(
    JSON.stringify({
      sourceKey: attachment.sourceKey,
      dataBase64Url: attachment.dataBase64Url ?? null,
      size: attachment.size,
    }),
  );

class GmailPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailPersistenceError";
  }
}

export type GmailSyncPersistenceResult = {
  messageIds: readonly string[];
  eventCount: number;
  attachmentCount: number;
};

const upsertMessage = async (
  tx: DrizzleTransaction,
  ledgerPartyId: ReturnType<typeof parseEntityId<"ledgerParty">>,
  mail: GmailOrderMail,
): Promise<string> => {
  const [row] = await tx
    .insert(orderMail)
    .values({
      ledgerPartyId,
      messageId: mail.messageId,
      threadId: mail.threadId,
      historyId: mail.historyId,
      sender: header(mail, "from"),
      subject: header(mail, "subject"),
      receivedAt: dateFromInternalDate(mail.internalDate),
      rawChecksum: await sha256(JSON.stringify(mail)),
      content: {
        snippet: mail.snippet,
        bodyText: mail.bodyText,
        bodyHtml: mail.bodyHtml,
      },
    })
    .onConflictDoUpdate({
      target: [orderMail.ledgerPartyId, orderMail.messageId],
      set: {
        threadId: mail.threadId,
        historyId: mail.historyId,
        sender: header(mail, "from"),
        subject: header(mail, "subject"),
        receivedAt: dateFromInternalDate(mail.internalDate),
        rawChecksum: await sha256(JSON.stringify(mail)),
        content: {
          snippet: mail.snippet,
          bodyText: mail.bodyText,
          bodyHtml: mail.bodyHtml,
        },
        updatedAt: new Date(),
      },
    })
    .returning({ id: orderMail.id });
  if (!row) throw new GmailPersistenceError("Gmail mail upsert returned no id");
  return row.id;
};

/**
 * Persist a normalized sync as one unit. The cursor is written last in the
 * same transaction, so a failed attachment/event write is replayed safely.
 * Deletion-only history for an unknown message is rejected rather than
 * inventing a received date or silently advancing past evidence.
 */
export const persistGmailSyncResult = async (
  db: Database,
  input: {
    ledgerPartyId: string;
    provider?: string;
    polledAt?: Date;
    advanceCursor?: boolean;
    result: GmailSyncResult;
  },
): Promise<GmailSyncPersistenceResult> => {
  const ledgerPartyId = parseEntityId("ledgerParty", input.ledgerPartyId);
  const provider = input.provider ?? "gmail";
  const polledAt = input.polledAt ?? new Date();

  return withTransaction(db, async (tx) => {
    const ids = new Map<string, string>();
    for (const mail of input.result.messages) {
      ids.set(mail.messageId, await upsertMessage(tx, ledgerPartyId, mail));
    }

    const referencedMessageIds = [
      ...new Set(input.result.events.map((event) => event.messageId)),
    ];
    if (referencedMessageIds.length > 0) {
      const existing = await tx
        .select({ messageId: orderMail.messageId, id: orderMail.id })
        .from(orderMail)
        .where(
          and(
            eq(orderMail.ledgerPartyId, ledgerPartyId),
            inArray(orderMail.messageId, referencedMessageIds),
          ),
        );
      for (const row of existing) ids.set(row.messageId, row.id);
    }

    const unresolved = input.result.events.filter(
      (event) => !ids.has(event.messageId),
    );
    if (unresolved.length > 0) {
      throw new GmailPersistenceError(
        `Gmail history references ${unresolved.length} unknown message(s); cursor was not advanced`,
      );
    }

    for (const event of input.result.events) {
      const orderMailId = ids.get(event.messageId);
      if (!orderMailId)
        throw new GmailPersistenceError("Missing Gmail mail id");
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
    }

    for (const attachment of input.result.attachments) {
      const orderMailId = ids.get(attachment.messageId);
      if (!orderMailId) {
        throw new GmailPersistenceError(
          `Gmail attachment references unknown message ${attachment.messageId}`,
        );
      }
      await tx
        .insert(orderMailAttachment)
        .values({
          orderMailId,
          providerAttachmentId: attachmentProviderId(attachment),
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          checksum: await attachmentChecksum(attachment),
          pendingDataBase64Url: attachment.dataBase64Url ?? null,
        })
        .onConflictDoUpdate({
          target: [
            orderMailAttachment.orderMailId,
            orderMailAttachment.providerAttachmentId,
          ],
          set: {
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            checksum: await attachmentChecksum(attachment),
            pendingDataBase64Url: attachment.dataBase64Url ?? null,
            updatedAt: new Date(),
          },
        });
    }

    if (input.advanceCursor !== false) {
      await tx
        .insert(mailboxCursor)
        .values({
          ledgerPartyId,
          provider,
          historyId: input.result.cursor.historyId,
          lastPolledAt: polledAt,
        })
        .onConflictDoUpdate({
          target: [mailboxCursor.ledgerPartyId, mailboxCursor.provider],
          set: {
            historyId: input.result.cursor.historyId,
            lastPolledAt: polledAt,
            updatedAt: new Date(),
          },
        });
    }

    return {
      messageIds: [...ids.keys()].sort(),
      eventCount: input.result.events.length,
      attachmentCount: input.result.attachments.length,
    };
  });
};

/** Advance only after classification and attachment processing has completed. */
export const advanceGmailCursor = async (
  db: Database,
  input: {
    ledgerPartyId: string;
    provider?: string;
    historyId: string | null;
    polledAt: Date;
  },
): Promise<void> => {
  const database = getDb(db);
  const ledgerPartyId = parseEntityId("ledgerParty", input.ledgerPartyId);
  const provider = input.provider ?? "gmail";
  await database
    .insert(mailboxCursor)
    .values({
      ledgerPartyId,
      provider,
      historyId: input.historyId,
      lastPolledAt: input.polledAt,
    })
    .onConflictDoUpdate({
      target: [mailboxCursor.ledgerPartyId, mailboxCursor.provider],
      set: {
        historyId: input.historyId,
        lastPolledAt: input.polledAt,
        updatedAt: new Date(),
      },
    });
};

/** Better Auth account-table adapter; token refresh itself remains injectable. */
export const createBetterAuthGmailAccountStore = (
  db: Database,
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
      .where(and(eq(account.userId, userId), eq(account.providerId, "google")))
      .limit(1);
    return row[0] ?? null;
  },
  async updateGoogleAccount(userId, patch: GmailAccountTokenPatch) {
    const database = db.clientForRepository();
    const where = and(
      eq(account.userId, userId),
      eq(account.providerId, "google"),
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
        .where(where);
      return;
    }
    await database
      .update(account)
      .set({
        accessToken: patch.accessToken,
        accessTokenExpiresAt: patch.accessTokenExpiresAt,
        updatedAt: new Date(),
      })
      .where(where);
  },
});
