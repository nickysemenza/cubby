/**
 * Gmail ingestion stores one message at a time and streams each attachment
 * straight to object storage; Postgres keeps only the key.
 *
 * Failure modes these scenarios guard:
 * - a batch holds every attachment payload at once (the Worker's 128 MB limit
 *   broke on 32 messages with 4 MiB attachments);
 * - the bytes land in the database again instead of only the storage key;
 * - the stored object differs from what Gmail returned;
 * - a replayed message (a Workflow step retry) refetches bytes or duplicates
 *   rows, including when Gmail mints a new attachment id on every fetch;
 * - an upload failure loses the bytes for good instead of leaving the
 *   attachment keyless for the retry to store;
 * - a message deleted between listing and fetching fails the whole batch;
 * - a history event for a message Cubby never saved wedges the cursor;
 * - the cursor rewinds, or moves although another pass already moved it.
 *
 * Only the S3 seam and the Gmail provider are faked.
 */
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  mailboxCursor,
  orderMail,
  orderMailAttachment,
  orderMailEvent,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import type { OrderMailAttachmentStorage } from "./attachment-storage";
import { ingestGmailMessages } from "./ingest";
import {
  advanceMailboxCursor,
  loadGmailCursor,
  persistGmailEvents,
} from "./persistence";
import {
  GmailApiError,
  type GmailMessage,
  type GmailOrderMailEvent,
  type GmailProvider,
} from "./types";

const PDF_BYTES = Buffer.from("%PDF-1.4 synthetic invoice bytes ÿ\u0000");

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

const message = (id: string, attachments = 1): GmailMessage => ({
  id,
  threadId: `thread-${id}`,
  historyId: "400",
  internalDate: "1788220800000",
  labelIds: ["INBOX"],
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: "orders@forgewear.example" },
      { name: "Subject", value: `Receipt ${id}` },
    ],
    parts: Array.from({ length: attachments }, (_, index) => ({
      partId: String(index + 1),
      filename: `invoice-${index + 1}.pdf`,
      mimeType: "application/pdf",
      // Gmail mints a fresh attachment id on every messages.get.
      body: {
        attachmentId: `att-${id}-${index}-${crypto.randomUUID()}`,
        size: PDF_BYTES.length,
      },
    })),
  },
});

const provider = (overrides: Partial<GmailProvider> = {}): GmailProvider => ({
  getProfile: async () => ({ historyId: "500" }),
  listMessages: async () => ({ messages: [] }),
  getMessage: async (id) => message(id),
  listHistory: async () => ({ historyId: "500" }),
  getAttachment: async () => ({
    data: PDF_BYTES.toString("base64url"),
    size: PDF_BYTES.length,
  }),
  ...overrides,
});

const event = (
  messageId: string,
  kind: GmailOrderMailEvent["kind"],
): GmailOrderMailEvent => ({
  sourceKey: `gmail:me:history:${messageId}:${kind}`,
  mailboxId: "me",
  historyId: "450",
  messageId,
  threadId: null,
  kind,
  labelIds: [],
});

describe("Gmail ingestion and attachment storage", () => {
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
        providerAttachmentId: orderMailAttachment.providerAttachmentId,
      })
      .from(orderMailAttachment);

  it("stores the bytes in object storage and only the key in the database", async () => {
    const party = await seedParty();
    const { objects, storage } = memoryStorage();

    const outcome = await ingestGmailMessages(ctx.db, provider(), {
      ledgerPartyId: party.id,
      mailboxId: "me",
      messageIds: ["msg-1"],
      storage,
    });

    expect(outcome).toEqual({ saved: ["msg-1"], deleted: [], rejected: [] });
    const [row] = await attachments();
    expect(row?.key).toBe(`order-mail-attachment/${row?.id}`);
    expect(row?.checksum).toMatch(/^[0-9a-f]{64}$/);
    const object = objects.get(row?.key ?? "");
    expect(Buffer.from(object?.bytes ?? []).equals(PDF_BYTES)).toBe(true);
    expect(object?.contentType).toBe("application/pdf");
  });

  it("keeps one row and never refetches stored bytes when a message replays", async () => {
    const party = await seedParty();
    const { objects, storage } = memoryStorage();
    let fetches = 0;
    const gmail = provider({
      getAttachment: async () => {
        fetches += 1;
        return { data: PDF_BYTES.toString("base64url") };
      },
    });
    const input = {
      ledgerPartyId: party.id,
      mailboxId: "me",
      messageIds: ["msg-1"],
      storage,
    };

    await ingestGmailMessages(ctx.db, gmail, input);
    const [first] = await attachments();
    await ingestGmailMessages(ctx.db, gmail, input);

    expect(await attachments()).toEqual([first]);
    expect(objects.size).toBe(1);
    expect(fetches).toBe(1);
  });

  // Rows saved before part identity carry Gmail's (unstable) attachment id.
  it("adopts a legacy attachment row instead of storing the bytes again", async () => {
    const party = await seedParty();
    const { objects, storage } = memoryStorage();
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: party.id,
        messageId: "msg-legacy",
        sender: "orders@forgewear.example",
        subject: "Receipt",
        receivedAt: new Date("2026-08-31T00:00:00.000Z"),
        rawChecksum: "legacy",
      })
      .returning({ id: orderMail.id });
    if (!mail) throw new Error("test setup: legacy mail");
    const [legacy] = await getDb(ctx.db)
      .insert(orderMailAttachment)
      .values({
        orderMailId: mail.id,
        providerAttachmentId: "ANGjdJ-legacy-attachment-id",
        filename: "invoice-1.pdf",
        mimeType: "application/pdf",
        checksum: "legacy",
        pendingObjectKey: "order-mail-attachment/legacy",
      })
      .returning({ id: orderMailAttachment.id });
    let fetches = 0;

    await ingestGmailMessages(
      ctx.db,
      provider({
        getAttachment: async () => {
          fetches += 1;
          return { data: PDF_BYTES.toString("base64url") };
        },
      }),
      {
        ledgerPartyId: party.id,
        mailboxId: "me",
        messageIds: ["msg-legacy"],
        storage,
      },
    );

    expect(await attachments()).toEqual([
      {
        id: legacy?.id,
        key: "order-mail-attachment/legacy",
        checksum: "legacy",
        providerAttachmentId: "gmail:me:msg-legacy:attachment:1",
      },
    ]);
    expect(fetches).toBe(0);
    expect(objects.size).toBe(0);
  });

  it("holds at most one attachment payload at a time across a large batch", async () => {
    const party = await seedParty();
    const { storage } = memoryStorage();
    const fourMiB = Buffer.alloc(4 * 1024 * 1024, 7).toString("base64url");
    let held = 0;
    let peak = 0;
    const gmail = provider({
      getMessage: async (id) => message(id, 2),
      getAttachment: async () => {
        held += 1;
        peak = Math.max(peak, held);
        return { data: fourMiB };
      },
    });
    const counting: OrderMailAttachmentStorage = {
      ...storage,
      put: async (key, bytes, contentType) => {
        await storage.put(key, bytes, contentType);
        held -= 1;
      },
    };

    const outcome = await ingestGmailMessages(ctx.db, gmail, {
      ledgerPartyId: party.id,
      mailboxId: "me",
      messageIds: Array.from({ length: 32 }, (_, index) => `msg-${index}`),
      storage: counting,
    });

    expect(outcome.saved).toHaveLength(32);
    expect(await attachments()).toHaveLength(64);
    expect(peak).toBe(1);
  });

  it("leaves a failed upload keyless and stores it on the retry", async () => {
    const party = await seedParty();
    const { objects, storage } = memoryStorage();
    const input = {
      ledgerPartyId: party.id,
      mailboxId: "me",
      messageIds: ["msg-1"],
    };

    await expect(
      ingestGmailMessages(ctx.db, provider(), {
        ...input,
        storage: {
          ...storage,
          put: async () => {
            throw new Error("synthetic storage outage");
          },
        },
      }),
    ).rejects.toThrow("synthetic storage outage");
    expect((await attachments()).map((row) => row.key)).toEqual([null]);

    await ingestGmailMessages(ctx.db, provider(), { ...input, storage });
    const [row] = await attachments();
    expect(row?.key).toBe(`order-mail-attachment/${row?.id}`);
    expect(objects.size).toBe(1);
  });

  it("skips a message deleted between listing and fetching", async () => {
    const party = await seedParty();
    const { storage } = memoryStorage();
    const gmail = provider({
      getMessage: async (id) => {
        if (id === "msg-gone")
          throw new GmailApiError({ status: 404, message: "Not Found" });
        return message(id);
      },
    });

    const outcome = await ingestGmailMessages(ctx.db, gmail, {
      ledgerPartyId: party.id,
      mailboxId: "me",
      messageIds: ["msg-1", "msg-gone"],
      storage,
    });

    expect(outcome).toEqual({
      saved: ["msg-1"],
      deleted: ["msg-gone"],
      rejected: [],
    });
  });

  it("saves nothing for a message the caller rejects", async () => {
    const party = await seedParty();
    const { objects, storage } = memoryStorage();

    const outcome = await ingestGmailMessages(ctx.db, provider(), {
      ledgerPartyId: party.id,
      mailboxId: "me",
      messageIds: ["msg-1"],
      storage,
      accept: () => false,
    });

    expect(outcome.rejected).toEqual(["msg-1"]);
    expect(await getDb(ctx.db).select().from(orderMail)).toEqual([]);
    expect(objects.size).toBe(0);
  });

  it("records history for saved messages and counts the rest as dropped", async () => {
    const party = await seedParty();
    const { storage } = memoryStorage();
    await ingestGmailMessages(ctx.db, provider(), {
      ledgerPartyId: party.id,
      mailboxId: "me",
      messageIds: ["msg-1"],
      storage,
    });

    const result = await persistGmailEvents(ctx.db, {
      ledgerPartyId: party.id,
      events: [
        event("msg-1", "labels_added"),
        event("msg-never-saved", "message_deleted"),
      ],
    });

    expect(result).toEqual({ saved: 1, dropped: 1 });
    expect(await getDb(ctx.db).select().from(orderMailEvent)).toHaveLength(1);
  });

  it("moves the cursor only from the pass's own starting point, never backwards", async () => {
    const party = await seedParty();
    const polledAt = new Date("2026-10-05T12:00:00.000Z");
    const cursor = () => loadGmailCursor(ctx.db, { ledgerPartyId: party.id });

    expect(
      await advanceMailboxCursor(ctx.db, {
        ledgerPartyId: party.id,
        from: null,
        to: "500",
        polledAt,
      }),
    ).toBe(true);
    // A stale pass that started from the old cursor cannot overwrite it.
    expect(
      await advanceMailboxCursor(ctx.db, {
        ledgerPartyId: party.id,
        from: null,
        to: "450",
        polledAt,
      }),
    ).toBe(false);
    expect(
      await advanceMailboxCursor(ctx.db, {
        ledgerPartyId: party.id,
        from: "500",
        to: "490",
        polledAt,
      }),
    ).toBe(true);
    expect(await cursor()).toEqual({ historyId: "500" });
    await advanceMailboxCursor(ctx.db, {
      ledgerPartyId: party.id,
      from: "500",
      to: "600",
      polledAt,
    });
    expect(await cursor()).toEqual({ historyId: "600" });
    expect(
      await getDb(ctx.db)
        .select({ lastPolledAt: mailboxCursor.lastPolledAt })
        .from(mailboxCursor)
        .where(eq(mailboxCursor.ledgerPartyId, party.id)),
    ).toEqual([{ lastPolledAt: polledAt }]);
  });
});
