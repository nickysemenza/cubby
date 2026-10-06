import { parseEntityId } from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { account } from "~/server/db/auth.schema";
import {
  mailboxCursor,
  orderMail,
  orderMailAttachment,
  orderMailEvent,
} from "~/server/db/schema";
import { getDb, withTransaction } from "~/server/repo/database-helpers";

import {
  orderMailAttachmentKey,
  type OrderMailAttachmentStorage,
} from "./attachment-storage";
import { maxHistoryId } from "./sync";
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

class GmailPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailPersistenceError";
  }
}

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

/** Upsert one message row by `(ledgerPartyId, messageId)`; returns its id. */
export const upsertOrderMail = async (
  db: Database,
  ledgerPartyId: string,
  mail: GmailOrderMail,
): Promise<string> => {
  const content = {
    snippet: mail.snippet,
    bodyText: mail.bodyText,
    bodyHtml: mail.bodyHtml,
  };
  const fields = {
    threadId: mail.threadId,
    historyId: mail.historyId,
    sender: header(mail, "from"),
    subject: header(mail, "subject"),
    receivedAt: dateFromInternalDate(mail.internalDate),
    rawChecksum: await sha256Hex(JSON.stringify(mail)),
    content,
  };
  const [row] = await getDb(db)
    .insert(orderMail)
    .values({
      ledgerPartyId: parseEntityId("ledgerParty", ledgerPartyId),
      messageId: mail.messageId,
      ...fields,
    })
    .onConflictDoUpdate({
      target: [orderMail.ledgerPartyId, orderMail.messageId],
      set: { ...fields, updatedAt: new Date() },
    })
    .returning({ id: orderMail.id });
  if (!row) throw new GmailPersistenceError("Gmail mail upsert returned no id");
  return row.id;
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
            AND a."providerAttachmentId" NOT LIKE 'gmail:%'
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

/**
 * Store one attachment: its row, then its bytes in object storage, one
 * attachment at a time so a batch never holds more than one payload.
 *
 * Identity is the MIME part (`sourceKey`), not Gmail's attachment id, which
 * Gmail re-mints on every fetch — keyed on it, a replayed message would add a
 * row and an object each time. A row that already has bytes (or a Purchase
 * image) is skipped before any fetch. The upload follows the row because its
 * key embeds the row id; an upload failure leaves the row keyless, and the
 * replay stores it while Gmail still has the bytes.
 */
export const storeOrderMailAttachment = async (
  db: Database,
  input: {
    orderMailId: string;
    attachment: GmailOrderMailAttachment;
    fetchData: () => Promise<string | undefined>;
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
  const key = orderMailAttachmentKey(row.id);
  await input.storage.put(key, bytes, input.attachment.mimeType);
  await database
    .update(orderMailAttachment)
    .set({ pendingObjectKey: key })
    .where(eq(orderMailAttachment.id, row.id));
};

/**
 * Record history changes for messages Cubby saved. An event for a message it
 * never saved (deleted before it was fetched, or never listed) is dropped and
 * counted: rejecting it would hold the mailbox cursor back forever.
 */
export const persistGmailEvents = async (
  db: Database,
  input: { ledgerPartyId: string; events: readonly GmailOrderMailEvent[] },
): Promise<{ saved: number; dropped: number }> => {
  if (input.events.length === 0) return { saved: 0, dropped: 0 };
  const ledgerPartyId = parseEntityId("ledgerParty", input.ledgerPartyId);
  return withTransaction(db, async (tx) => {
    const known = new Map(
      (
        await tx
          .select({ messageId: orderMail.messageId, id: orderMail.id })
          .from(orderMail)
          .where(
            and(
              eq(orderMail.ledgerPartyId, ledgerPartyId),
              inArray(orderMail.messageId, [
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
      .values({ ledgerPartyId, provider, historyId: null })
      .onConflictDoNothing();
    const [current] = await tx
      .select({ historyId: mailboxCursor.historyId })
      .from(mailboxCursor)
      .where(
        and(
          eq(mailboxCursor.ledgerPartyId, ledgerPartyId),
          eq(mailboxCursor.provider, provider),
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
        ),
      );
    return true;
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
