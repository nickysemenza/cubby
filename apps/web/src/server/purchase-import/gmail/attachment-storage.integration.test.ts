/**
 * Order-mail attachment bytes live in object storage, never in Postgres.
 *
 * Failure modes these scenarios guard:
 * - a sync stores the bytes in the database again (base64 column) instead of
 *   only the storage key;
 * - the stored object differs from what Gmail returned (re-encoding, truncation);
 * - the upload fails after the cursor advanced, so the bytes are lost for good
 *   (upload happens inside the sync transaction: failure rolls everything back);
 * - an attachment synced without data gets a dangling key.
 *
 * Only the S3 seam is faked, with an in-memory store.
 */
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  mailboxCursor,
  orderMail,
  orderMailAttachment,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import type { OrderMailAttachmentStorage } from "./attachment-storage";
import { persistGmailSyncResult } from "./persistence";
import type { GmailOrderMailAttachment, GmailSyncResult } from "./types";

const PDF_BYTES = Buffer.from("%PDF-1.4 synthetic invoice bytes ÿ\u0000");
const PDF_BASE64URL = PDF_BYTES.toString("base64url");

const memoryStorage = () => {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const storage: OrderMailAttachmentStorage = {
    put: async (key, bytes, contentType) => {
      objects.set(key, { bytes: new Uint8Array(bytes), contentType });
    },
    get: async (key) => {
      const object = objects.get(key);
      if (!object) throw new Error(`missing object ${key}`);
      return object.bytes;
    },
    delete: async (key) => {
      objects.delete(key);
    },
  };
  return { objects, storage };
};

const syncResult = (data: string | undefined): GmailSyncResult => {
  const attachment: GmailOrderMailAttachment = {
    sourceKey: "gmail:me:msg-1:attachment:1",
    mailboxId: "me",
    messageId: "msg-1",
    attachmentId: "att-1",
    filename: "invoice.pdf",
    mimeType: "application/pdf",
    size: PDF_BYTES.length,
  };
  if (data !== undefined) attachment.dataBase64Url = data;
  return {
    mode: "incremental",
    reason: "incremental",
    cursor: { historyId: "500" },
    messages: [
      {
        sourceKey: "gmail:me:msg-1",
        mailboxId: "me",
        messageId: "msg-1",
        threadId: "thread-1",
        historyId: "400",
        internalDate: "2026-09-01T00:00:00.000Z",
        labelIds: [],
        headers: { from: "orders@forgewear.example", subject: "Receipt" },
        snippet: null,
        bodyText: null,
        bodyHtml: null,
      },
    ],
    events: [],
    attachments: [attachment],
  };
};

describe("order mail attachment storage", () => {
  const ctx = withTestDb();

  const seedParty = () =>
    insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Attachment storage member",
      kind: "member",
      userId: ctx.actor.userId,
    });

  const attachments = () =>
    getDb(ctx.db)
      .select({
        id: orderMailAttachment.id,
        key: orderMailAttachment.pendingObjectKey,
        checksum: orderMailAttachment.checksum,
      })
      .from(orderMailAttachment);

  it("stores the bytes in object storage and only the key in the database", async () => {
    const party = await seedParty();
    const { objects, storage } = memoryStorage();

    await persistGmailSyncResult(ctx.db, {
      ledgerPartyId: party.id,
      result: syncResult(PDF_BASE64URL),
      storage,
    });

    const [row] = await attachments();
    expect(row?.key).toBe(`order-mail-attachment/${row?.id}`);
    expect(row?.checksum).toMatch(/^[0-9a-f]{64}$/);
    const object = objects.get(row?.key ?? "");
    expect(Buffer.from(object?.bytes ?? []).equals(PDF_BYTES)).toBe(true);
    expect(object?.contentType).toBe("application/pdf");
    expect(objects.size).toBe(1);
  });

  it("keeps the existing key when the same attachment syncs again", async () => {
    const party = await seedParty();
    const { objects, storage } = memoryStorage();
    const input = {
      ledgerPartyId: party.id,
      result: syncResult(PDF_BASE64URL),
      storage,
    };

    await persistGmailSyncResult(ctx.db, input);
    const [first] = await attachments();
    await persistGmailSyncResult(ctx.db, input);
    const rows = await attachments();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe(first?.key);
    expect(objects.size).toBe(1);
  });

  it("rolls the whole sync back, cursor included, when the upload fails", async () => {
    const party = await seedParty();
    const storage: OrderMailAttachmentStorage = {
      ...memoryStorage().storage,
      put: async () => {
        throw new Error("synthetic storage outage");
      },
    };

    await expect(
      persistGmailSyncResult(ctx.db, {
        ledgerPartyId: party.id,
        result: syncResult(PDF_BASE64URL),
        storage,
      }),
    ).rejects.toThrow("synthetic storage outage");

    expect(await attachments()).toEqual([]);
    expect(await getDb(ctx.db).select().from(orderMail)).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(mailboxCursor)
        .where(eq(mailboxCursor.ledgerPartyId, party.id)),
    ).toEqual([]);
  });

  it("leaves no key and uploads nothing for an attachment synced without data", async () => {
    const party = await seedParty();
    const { objects, storage } = memoryStorage();

    await persistGmailSyncResult(ctx.db, {
      ledgerPartyId: party.id,
      result: syncResult(undefined),
      storage,
    });

    expect((await attachments()).map((row) => row.key)).toEqual([null]);
    expect(objects.size).toBe(0);
  });
});
