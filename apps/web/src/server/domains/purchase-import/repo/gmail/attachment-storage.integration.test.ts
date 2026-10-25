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
 * - an upload failure publishes partial rows or loses retryable original evidence;
 * - a message deleted between listing and fetching fails the whole batch;
 * - a history event for a message Cubby never saved wedges the cursor;
 * - the cursor rewinds, or moves although another pass already moved it.
 *
 * Gmail, model verdicts and object storage are synthetic; retention writers are real.
 */
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  email as emailTable,
  imageProcessingOrphan,
  ledgerParty,
  emailRetrievalFailure,
  mailboxCursor,
  orderMail,
  orderMailAttachment,
  orderMailEvent,
} from "~/server/db/schema";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { syntheticMailImportRun } from "../../service/gmail/execution.fixtures";
import { ingestGmailMessages as acquireGmailMessages } from "../../service/gmail/ingest";
import { syntheticRetainedMail } from "../../service/gmail/retained-mail.fixtures";
import type { OrderMailAttachmentStorage } from "./attachment-storage";
import { originalChecksum } from "./checksum";
import { normalizeMessage } from "./normalize";
import {
  advanceMailboxCursor,
  loadGmailCursor,
  persistGmailEvents,
  readEmail,
  saveMailboxMetadata,
} from "./persistence";
import {
  GmailApiError,
  type GmailMessage,
  type GmailOrderMailEvent,
  type GmailProvider,
} from "./types";

const ingestGmailMessages: typeof acquireGmailMessages = (
  db,
  provider,
  input,
) =>
  acquireGmailMessages(db, provider, {
    ...input,
    relevance: input.relevance ?? (async () => ({ classification: "related" })),
  });

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
  sourceKey: `gmail:synthetic-google-subject:history:${messageId}:${kind}`,
  mailboxId: "synthetic-google-subject",
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
      mailboxId: "synthetic-google-subject",
      messageIds: ["msg-1"],
      storage,
    });

    expect(outcome).toMatchObject({
      saved: ["msg-1"],
      deleted: [],
    });
    const [row] = await attachments();
    expect(row?.key).toBeTruthy();
    expect(row?.checksum).toMatch(/^[0-9a-f]{64}$/);
    const object = objects.get(row?.key ?? "");
    expect(Buffer.from(object?.bytes ?? []).equals(PDF_BYTES)).toBe(true);
    expect(object?.contentType).toBe("application/pdf");
  });

  it("uploads before retained publication and keeps DB-only adoption afterward", async () => {
    const party = await seedParty();
    const { storage, objects } = memoryStorage();
    let puts = 0;
    await ingestGmailMessages(ctx.db, provider(), {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-google-subject",
      messageIds: ["msg-staged"],
      storage: {
        ...storage,
        put: async (key, bytes, contentType) => {
          puts += 1;
          await withTransactionDatabase(ctx.db, async (db) => {
            await getDb(db)
              .select({ id: ledgerParty.id })
              .from(ledgerParty)
              .where(eq(ledgerParty.id, party.id))
              .for("update", { noWait: true });
          });
          expect(await getDb(ctx.db).select().from(orderMail)).toHaveLength(0);
          expect(await attachments()).toHaveLength(0);
          await storage.put(key, bytes, contentType);
        },
      },
    });
    expect(puts).toBe(1);
    expect(objects.size).toBe(1);
    expect(await attachments()).toHaveLength(1);
  });

  it("invalidates created and changed metadata but leaves replayed Email and Job tuples unchanged", async () => {
    const party = await seedParty();
    const { mail } = normalizeMessage(
      "synthetic-google-subject",
      message("msg-metadata", 0),
    );
    const metadata = {
      ledgerPartyId: party.id,
      mail,
      checksum: "a".repeat(64),
      executionPolicy: "classification_only",
    } satisfies Parameters<typeof saveMailboxMetadata>[1];
    const identity = {
      ledgerPartyId: party.id,
      mailboxId: mail.mailboxId,
      messageId: mail.messageId,
    };
    // Captures move each family's JobInvalidation row; the execution Job
    // rows are never written by a capture.
    const jobs = async () =>
      (
        await getDb(ctx.db).execute(
          sql`SELECT key, generation, xmin::text AS xmin FROM "Job" WHERE kind = 'refresh.family' ORDER BY key`,
        )
      ).rows;
    const invalidations = async () =>
      (
        await getDb(ctx.db).execute(
          sql`SELECT key, revision::int, xmin::text AS xmin FROM "JobInvalidation" ORDER BY key`,
        )
      ).rows;
    const searchGeneration = async () =>
      (
        await getDb(ctx.db).execute(
          sql`SELECT revision::int FROM "JobInvalidation" WHERE key = 'refresh:search'`,
        )
      ).rows[0]?.revision;
    expect(await searchGeneration()).toBeUndefined();
    await saveMailboxMetadata(ctx.db, metadata);
    expect(await searchGeneration()).toBe(1);
    const originalEmail = await readEmail(ctx.db, identity);
    expect(originalEmail).not.toBeNull();
    const originalJobs = await jobs();
    const originalInvalidations = await invalidations();
    await saveMailboxMetadata(ctx.db, metadata);
    expect(await readEmail(ctx.db, identity)).toEqual(originalEmail);
    expect(await jobs()).toEqual(originalJobs);
    expect(await invalidations()).toEqual(originalInvalidations);

    await saveMailboxMetadata(ctx.db, {
      ...metadata,
      mail: {
        ...mail,
        headers: { ...mail.headers, subject: "Synthetic changed receipt" },
      },
    });
    const changedEmail = await readEmail(ctx.db, identity);
    expect(changedEmail).toEqual({
      ...originalEmail,
      subject: "Synthetic changed receipt",
      updatedAt: expect.any(Date),
    });
    expect(await searchGeneration()).toBe(2);
    expect(await jobs()).toEqual(originalJobs);
    await saveMailboxMetadata(ctx.db, {
      ...metadata,
      mail: {
        ...mail,
        headers: { ...mail.headers, subject: "Synthetic changed receipt" },
      },
      memberSearch: true,
    });
    expect(await readEmail(ctx.db, identity)).toEqual({
      ...changedEmail,
      updatedAt: expect.any(Date),
      searchOrigin: "member_search",
      searchExpiresAt: expect.any(Date),
    });
    expect(await searchGeneration()).toBe(3);

    // A later search changes only expiry; that remains source metadata and
    // must retain refresh intent even after the search origin is established.
    const expiresAt = new Date(Date.now() + 60_000 + 7 * 86_400_000);
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(expiresAt.getTime() - 7 * 86_400_000);
    try {
      await saveMailboxMetadata(ctx.db, {
        ...metadata,
        mail: {
          ...mail,
          headers: { ...mail.headers, subject: "Synthetic changed receipt" },
        },
        memberSearch: true,
      });
      expect((await readEmail(ctx.db, identity))?.searchExpiresAt).toEqual(
        expiresAt,
      );
      expect(await searchGeneration()).toBe(4);
    } finally {
      clock.mockRestore();
    }
  });

  it("cleans uploaded reservations when newer metadata refuses publication", async () => {
    const party = await seedParty();
    const { storage, objects } = memoryStorage();
    const normalized = normalizeMessage(
      "synthetic-google-subject",
      message("msg-raced"),
    );
    const outcome = await ingestGmailMessages(ctx.db, provider(), {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-google-subject",
      messageIds: ["msg-raced"],
      storage: {
        ...storage,
        put: async (key, bytes, contentType) => {
          await storage.put(key, bytes, contentType);
          await saveMailboxMetadata(ctx.db, {
            ledgerPartyId: party.id,
            mail: normalized.mail,
            checksum: await originalChecksum(normalized),
            executionPolicy: "classification_only",
          });
        },
      },
    });
    expect(outcome.saved).toEqual([]);
    expect(objects.size).toBe(0);
    expect(await attachments()).toEqual([]);
    expect(await getDb(ctx.db).select().from(imageProcessingOrphan)).toEqual(
      [],
    );
  });

  it("retains preparation and cleanup errors while attempting every reserved key", async () => {
    const party = await seedParty();
    const { storage } = memoryStorage();
    const uploadError = new Error("Synthetic partial PUT failure");
    const cleanupError = new Error("Synthetic deletion failure");
    let deleted = 0;
    await expect(
      ingestGmailMessages(
        ctx.db,
        provider({ getMessage: async (id) => message(id, 2) }),
        {
          ledgerPartyId: party.id,
          mailboxId: "synthetic-google-subject",
          messageIds: ["msg-failed-staging"],
          storage: {
            ...storage,
            put: async () => {
              throw uploadError;
            },
            delete: async () => {
              deleted += 1;
              throw cleanupError;
            },
          },
        },
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AggregateError &&
        error.cause === uploadError &&
        error.errors.length === 3 &&
        error.errors[0] === uploadError &&
        error.errors.slice(1).every((failure) => failure === cleanupError),
    );
    expect(deleted).toBe(2);
    expect(await attachments()).toEqual([]);
    expect(await getDb(ctx.db).select().from(orderMail)).toEqual([]);
    expect(
      await getDb(ctx.db).select().from(imageProcessingOrphan),
    ).toHaveLength(2);
  });

  it("preserves metadata-only attachments without inventing uploaded bytes", async () => {
    const party = await seedParty();
    const { storage, objects } = memoryStorage();
    const outcome = await ingestGmailMessages(
      ctx.db,
      provider({ getAttachment: async () => ({}) }),
      {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-google-subject",
        messageIds: ["msg-missing"],
        storage,
      },
    );
    expect(outcome.saved).toEqual(["msg-missing"]);
    expect(await attachments()).toEqual([
      expect.objectContaining({ key: null, checksum: expect.any(String) }),
    ]);
    expect(objects.size).toBe(0);
    expect(await getDb(ctx.db).select().from(imageProcessingOrphan)).toEqual(
      [],
    );
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
      mailboxId: "synthetic-google-subject",
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
    const mail = await syntheticRetainedMail(ctx.db, {
      ledgerPartyId: party.id,
      messageId: "msg-legacy",
      mailboxId: "synthetic-google-subject",
      sender: "orders@forgewear.example",
      subject: "Receipt",
      receivedAt: new Date("2026-08-31T00:00:00.000Z"),
      rawChecksum: "legacy",
    });
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
        mailboxId: "synthetic-google-subject",
        messageIds: ["msg-legacy"],
        storage,
      },
    );

    expect(await attachments()).toEqual([
      {
        id: legacy?.id,
        key: "order-mail-attachment/legacy",
        checksum: "legacy",
        providerAttachmentId:
          "gmail:synthetic-google-subject:msg-legacy:attachment:1",
      },
    ]);
    // Relevance reads the original once; retention adopts the existing object.
    expect(fetches).toBe(1);
    expect(objects.size).toBe(0);
  });

  it("bounds transient attachment payloads across consecutive messages", async () => {
    const party = await seedParty();
    const { storage } = memoryStorage();
    const fourMiB = Buffer.alloc(4 * 1024 * 1024, 7).toString("base64url");
    let held = 0;
    let peak = 0;
    const gmail = provider({
      getMessage: async (id) => {
        const original = message(id, 2);
        for (const part of original.payload?.parts ?? [])
          if (part.body) part.body.size = 4 * 1024 * 1024;
        return original;
      },
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
      mailboxId: "synthetic-google-subject",
      messageIds: Array.from({ length: 2 }, (_, index) => `msg-${index}`),
      storage: counting,
    });

    expect(outcome.saved).toHaveLength(2);
    expect(await attachments()).toHaveLength(4);
    expect(peak).toBeGreaterThanOrEqual(1);
    expect(peak).toBeLessThanOrEqual(2);
    expect(held).toBe(0);
  });

  it("leaves a failed upload unpublished and stores it on the retry without changing prior evidence", async () => {
    const party = await seedParty();
    const { objects, storage } = memoryStorage();
    const input = {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-google-subject",
      messageIds: ["msg-1"],
    };

    await ingestGmailMessages(ctx.db, provider(), {
      ...input,
      messageIds: ["msg-kept"],
      storage,
    });
    const beforeAttachments = await attachments();
    const beforeEmails = await getDb(ctx.db).select().from(emailTable);
    const beforeOriginals = await getDb(ctx.db).select().from(orderMail);
    const beforeObjects = new Map(objects);

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
    expect(await attachments()).toEqual(beforeAttachments);
    expect(await getDb(ctx.db).select().from(emailTable)).toEqual(beforeEmails);
    expect(await getDb(ctx.db).select().from(orderMail)).toEqual(
      beforeOriginals,
    );
    expect(objects).toEqual(beforeObjects);

    await ingestGmailMessages(ctx.db, provider(), { ...input, storage });
    const after = await attachments();
    const row = after.find(
      (candidate) =>
        !beforeAttachments.some((prior) => prior.id === candidate.id),
    );
    expect(after).toHaveLength(beforeAttachments.length + 1);
    expect(row?.key).toBeTruthy();
    expect(
      Buffer.from(objects.get(row?.key ?? "")?.bytes ?? []).equals(PDF_BYTES),
    ).toBe(true);
    expect(objects.size).toBe(beforeObjects.size + 1);
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
      mailboxId: "synthetic-google-subject",
      messageIds: ["msg-1", "msg-gone"],
      storage,
    });

    expect(outcome).toMatchObject({
      saved: ["msg-1"],
      deleted: ["msg-gone"],
      excluded: [],
      blocked: [],
      unrelated: [],
    });
    expect(outcome.orderMailIds).toHaveLength(1);
    const [deletedEmail] = await getDb(ctx.db)
      .select()
      .from(emailTable)
      .where(eq(emailTable.messageId, "msg-gone"));
    expect(deletedEmail).toMatchObject({
      status: "deleted",
      classification: null,
      orderMailId: null,
    });
    const failures = await getDb(ctx.db).select().from(emailRetrievalFailure);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      emailId: deletedEmail?.id,
      httpStatus: 404,
      error: "Not Found",
    });
  });

  it("stores no original or attachments when capable interpretation rejects a message", async () => {
    const party = await seedParty();
    const { objects, storage } = memoryStorage();

    const outcome = await ingestGmailMessages(ctx.db, provider(), {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-google-subject",
      messageIds: ["msg-1"],
      storage,
      runId: await syntheticMailImportRun(ctx.db, ctx.actor, {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-google-subject",
      }),
      relevance: async () => ({ classification: "unrelated" }),
    });

    expect(outcome.unrelated).toEqual(["msg-1"]);
    expect(await getDb(ctx.db).select().from(orderMail)).toEqual([]);
    expect(objects.size).toBe(0);
  });

  it("records history for saved messages and counts the rest as dropped", async () => {
    const party = await seedParty();
    const { storage } = memoryStorage();
    await ingestGmailMessages(ctx.db, provider(), {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-google-subject",
      messageIds: ["msg-1"],
      storage,
    });

    const result = await persistGmailEvents(ctx.db, {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-google-subject",
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
    const cursor = () =>
      loadGmailCursor(ctx.db, {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-google-subject",
      });

    expect(
      await advanceMailboxCursor(ctx.db, {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-google-subject",
        from: null,
        to: "500",
        polledAt,
      }),
    ).toBe(true);
    // A stale pass that started from the old cursor cannot overwrite it.
    expect(
      await advanceMailboxCursor(ctx.db, {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-google-subject",
        from: null,
        to: "450",
        polledAt,
      }),
    ).toBe(false);
    expect(
      await advanceMailboxCursor(ctx.db, {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-google-subject",
        from: "500",
        to: "490",
        polledAt,
      }),
    ).toBe(true);
    expect(await cursor()).toMatchObject({ historyId: "500" });
    await advanceMailboxCursor(ctx.db, {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-google-subject",
      from: "500",
      to: "600",
      polledAt,
    });
    expect(await cursor()).toMatchObject({ historyId: "600" });
    expect(
      await getDb(ctx.db)
        .select({ lastPolledAt: mailboxCursor.lastPolledAt })
        .from(mailboxCursor)
        .where(eq(mailboxCursor.ledgerPartyId, party.id)),
    ).toEqual([{ lastPolledAt: polledAt }]);
  });
});
