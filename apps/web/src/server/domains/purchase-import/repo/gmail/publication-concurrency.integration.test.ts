/** Async discovery must yield to explicit admission; member locks follow owner order. */
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { pollUntil } from "@cubby/shared/retry";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import { account } from "~/server/db/auth.schema";
import {
  databaseForTransaction,
  getDb,
  withTransaction,
} from "~/server/db/helpers";
import {
  email as emailTable,
  ledgerParty,
  orderMail,
  orderMailAttachment,
  emailCandidateObservation,
} from "~/server/db/schema";
import { startMailImport } from "~/server/domains/purchase-import/repo/mail-import-run";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { syntheticMailImportRun } from "../../service/gmail/execution.fixtures";
import { ingestGmailMessages } from "../../service/gmail/ingest";
import { syntheticRetainedMail } from "../../service/gmail/retained-mail.fixtures";
import { loadMailAttachmentOriginal } from "./attachment-original";
import {
  productionOrderMailAttachmentStorage,
  type OrderMailAttachmentStorage,
} from "./attachment-storage";
import { originalChecksum } from "./checksum";
import { normalizeMessage } from "./normalize";
import { disposeUnrelatedOriginals } from "./persistence";
import * as providers from "./provider";
import { exactMemberEmail } from "./real-time";
import { correctEmailRelevance } from "./relevance-correction";
import type { GmailMessage, GmailProvider } from "./types";

function signal<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Gmail final publication concurrency", () => {
  const ctx = withTestDb();
  afterEach(() => vi.restoreAllMocks());
  async function fixture() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic publication member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const mailboxId = "synthetic-publication-mailbox";
    const messageId = "synthetic-publication-message";
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      providerId: "google",
      accountId: mailboxId,
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    const source = await syntheticRetainedMail(ctx.db, {
      ledgerPartyId: party.id,
      mailboxId,
      messageId,
      sender: null,
      subject: null,
      receivedAt: null,
      rawChecksum: "a".repeat(64),
      content: {
        snippet: null,
        bodyText: "Synthetic frozen original",
        bodyHtml: null,
      },
    });
    const message: GmailMessage = {
      id: messageId,
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          {
            partId: "body",
            mimeType: "text/plain",
            body: {
              data: Buffer.from("Synthetic changed evidence").toString(
                "base64url",
              ),
            },
          },
          {
            partId: "pdf",
            filename: "synthetic.pdf",
            mimeType: "application/pdf",
            body: { attachmentId: "synthetic-pdf", size: 3 },
          },
        ],
      },
    };
    const part = normalizeMessage(mailboxId, message).attachments[0];
    if (!part) throw new Error("Synthetic attachment descriptor missing");
    await getDb(ctx.db)
      .insert(orderMailAttachment)
      .values({
        orderMailId: source.id,
        providerAttachmentId: part.sourceKey,
        filename: part.filename,
        mimeType: part.mimeType,
        checksum: "b".repeat(64),
        pendingObjectKey: "synthetic-existing-cache",
      });
    await getDb(ctx.db)
      .update(emailTable)
      .set({
        classification: "related",
        classificationVersion: "synthetic-prior",
        status: "pending",
      })
      .where(eq(emailTable.orderMailId, source.id));
    const discovery = await insertWithShortcode(ctx.db, "run", {
      purpose: "mail_discovery",
      trigger: "manual",
      status: "running",
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
      actorName: party.name,
      actorEmail: "publication@example.test",
      actorLedgerPartyShortcode: party.shortcode,
      input: {
        mailboxId,
        scopedQueries: [],
        executionPolicy: "classification_only",
      },
    });
    const provider: GmailProvider = {
      getMessage: async () => message,
      getAttachment: vi.fn(async () => ({
        data: Buffer.from("new").toString("base64url"),
        size: 3,
      })),
      getProfile: async () => ({ historyId: "100" }),
      listMessages: async () => ({}),
      listHistory: async () => ({}),
    };
    const storage = {
      put: vi.fn(async () => undefined),
      get: vi.fn(async () => new Uint8Array([1, 2, 3])),
      delete: vi.fn(async () => undefined),
    };
    return {
      party,
      source,
      discovery,
      provider,
      storage,
      mailboxId,
      messageId,
    };
  }
  async function state() {
    return {
      emails: await getDb(ctx.db).select().from(emailTable),
      originals: await getDb(ctx.db).select().from(orderMail),
      attachments: await getDb(ctx.db).select().from(orderMailAttachment),
    };
  }
  it.each(["related", "unrelated"] as const)(
    "preserves explicit admission that commits during %s triage without publishing saved work or preview",
    async (classification) => {
      const f = await fixture();
      const entered = signal<void>();
      const release = signal<void>();
      const preview = vi.fn(async () => undefined);
      const choose = vi.fn(async () => {
        throw new Error("Admitted evidence cannot request a candidate choice");
      });
      const pending = ingestGmailMessages(ctx.db, f.provider, {
        ledgerPartyId: f.party.id,
        mailboxId: f.mailboxId,
        messageIds: [f.messageId],
        runId: f.discovery.id,
        storage: f.storage,
        triage: async () => {
          entered.resolve();
          await release.promise;
          return classification;
        },
        candidateChoice: choose,
        onCandidatePreview: preview,
      });
      try {
        await entered.promise;
        const queue = { send: vi.fn(async () => undefined) };
        const admitted = await startMailImport(
          ctx.db,
          {
            ledgerPartyId: f.party.id,
            userId: ctx.actor.userId,
            mailboxId: f.mailboxId,
            messageIds: [f.source.id],
          },
          queue,
        );
        expect(admitted).toHaveLength(1);
        const before = await state();
        expect(before.emails[0]).toMatchObject({
          status: "researching",
          runId: admitted[0]?.runId,
          checksum: f.source.rawChecksum,
        });
        release.resolve();
        const result = await pending;
        expect(await state()).toEqual(before);
        expect(result).toMatchObject({
          saved: [],
          orderMailIds: [],
          candidatePreviews: [],
          unrelated: [],
          blocked: [],
        });
        expect(
          await getDb(ctx.db).select().from(emailCandidateObservation),
        ).toEqual([]);
        expect(preview).not.toHaveBeenCalled();
        expect(choose).not.toHaveBeenCalled();
        expect(f.storage.put).not.toHaveBeenCalled();
        expect(f.storage.delete).not.toHaveBeenCalled();
        expect(f.provider.getAttachment).not.toHaveBeenCalled();
        expect(queue.send).toHaveBeenCalledTimes(1);
      } finally {
        release.resolve();
        await Promise.allSettled([pending]);
      }
    },
  );
  it("preserves a newer same-checksum member resolution while unrelated triage is paused", async () => {
    const f = await fixture();
    const checksum = await originalChecksum(
      normalizeMessage(f.mailboxId, await f.provider.getMessage(f.messageId)),
    );
    await getDb(ctx.db)
      .update(emailTable)
      .set({ checksum })
      .where(eq(emailTable.orderMailId, f.source.id));
    await getDb(ctx.db)
      .update(orderMail)
      .set({ rawChecksum: checksum })
      .where(eq(orderMail.id, f.source.id));
    const [email] = await getDb(ctx.db)
      .select()
      .from(emailTable)
      .where(eq(emailTable.orderMailId, f.source.id));
    if (!email) throw new Error("Synthetic member resolution Email missing");
    vi.spyOn(providers, "gmailProviderForUser").mockResolvedValue(f.provider);
    vi.spyOn(productionOrderMailAttachmentStorage, "put").mockImplementation(
      f.storage.put,
    );
    vi.spyOn(productionOrderMailAttachmentStorage, "delete").mockImplementation(
      f.storage.delete,
    );
    const entered = signal<void>();
    const release = signal<void>();
    const preview = vi.fn(async () => undefined);
    const pending = ingestGmailMessages(ctx.db, f.provider, {
      ledgerPartyId: f.party.id,
      mailboxId: f.mailboxId,
      messageIds: [f.messageId],
      runId: f.discovery.id,
      storage: f.storage,
      onCandidatePreview: preview,
      triage: async () => {
        entered.resolve();
        await release.promise;
        return "unrelated";
      },
    });
    try {
      await entered.promise;
      await correctEmailRelevance(
        ctx.db,
        {
          id: parseShortcodeFor("email", email.shortcode),
          expectedChecksum: checksum,
          reviewedChecksum: checksum,
          classification: "related",
          reason: "Synthetic member verified this exact original",
        },
        ctx.actor,
      );
      const before = await state();
      expect(before.emails[0]).toMatchObject({
        checksum,
        runId: null,
        classification: "related",
        classificationStage: "resolution",
        classificationReason: "Synthetic member verified this exact original",
      });
      expect(before.originals[0]?.content?.bodyText).toBe(
        "Synthetic changed evidence",
      );
      f.storage.put.mockClear();
      f.storage.delete.mockClear();
      release.resolve();
      expect(await pending).toMatchObject({
        saved: [],
        orderMailIds: [],
        candidatePreviews: [],
        unrelated: [],
        blocked: [],
      });
      expect(await state()).toEqual(before);
      expect(preview).not.toHaveBeenCalled();
      expect(f.storage.put).not.toHaveBeenCalled();
      expect(f.storage.delete).not.toHaveBeenCalled();
      expect(
        await getDb(ctx.db).select().from(emailCandidateObservation),
      ).toEqual([]);
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
  });
  it("takes the member owner lock before Email so admission can lock its source while a correction waits", async () => {
    const f = await fixture();
    const ownerReady = signal<void>();
    const readerPid = signal<number>();
    const before = await state();
    const owner = withTransaction(ctx.db, async (tx) => {
      await tx
        .select()
        .from(ledgerParty)
        .where(eq(ledgerParty.id, f.party.id))
        .for("no key update");
      ownerReady.resolve();
      const pid = await readerPid.promise;
      await pollUntil(
        async () => {
          const r = await tx.execute<{ blocked: boolean }>(
            sql`SELECT cardinality(pg_blocking_pids(${pid})) > 0 AS blocked`,
          );
          return r.rows[0]?.blocked ? true : undefined;
        },
        {
          label: "member original reader blocked on owning party",
          timeoutMs: 5000,
          intervalMs: 25,
        },
      );
      const [source] = await tx
        .select()
        .from(emailTable)
        .where(eq(emailTable.orderMailId, f.source.id))
        .for("update", { noWait: true });
      if (!source) throw new Error("Synthetic admission Email missing");
    });
    await ownerReady.promise;
    const reader = withTransaction(ctx.db, async (tx) => {
      const pid = await tx.execute<{ pid: number }>(
        sql`SELECT pg_backend_pid() AS pid`,
      );
      if (!pid.rows[0]) throw new Error("Synthetic reader session missing");
      readerPid.resolve(pid.rows[0].pid);
      return exactMemberEmail(
        databaseForTransaction(tx),
        { mailboxId: f.mailboxId, messageId: f.messageId },
        ctx.actor,
        "update",
      );
    });
    try {
      await Promise.all([owner, reader]);
      expect(await state()).toEqual(before);
    } finally {
      await Promise.allSettled([owner, reader]);
    }
  });
  async function disposalFixture(keyless = false) {
    const f = await fixture();
    const checksum = await originalChecksum(
      normalizeMessage(f.mailboxId, await f.provider.getMessage(f.messageId)),
    );
    await getDb(ctx.db)
      .update(emailTable)
      .set({ checksum })
      .where(eq(emailTable.orderMailId, f.source.id));
    await getDb(ctx.db)
      .update(orderMail)
      .set({ rawChecksum: checksum })
      .where(eq(orderMail.id, f.source.id));
    const [attachment] = await getDb(ctx.db)
      .select()
      .from(orderMailAttachment)
      .where(eq(orderMailAttachment.orderMailId, f.source.id));
    const [email] = await getDb(ctx.db)
      .select()
      .from(emailTable)
      .where(eq(emailTable.orderMailId, f.source.id));
    if (!attachment || !email)
      throw new Error("Synthetic disposal evidence missing");
    const retiredKey = `order-mail-attachment/${attachment.id}`;
    await getDb(ctx.db)
      .update(orderMailAttachment)
      .set({ pendingObjectKey: keyless ? null : retiredKey })
      .where(eq(orderMailAttachment.id, attachment.id));
    const objects = new Map<string, Uint8Array>();
    if (!keyless) objects.set(retiredKey, Buffer.from("old"));
    const storage: OrderMailAttachmentStorage = {
      put: async (key, bytes) => {
        objects.set(key, Uint8Array.from(bytes));
      },
      get: async (key) => {
        const bytes = objects.get(key);
        if (!bytes)
          throw new Error("Synthetic retained attachment object missing");
        return bytes;
      },
      delete: async (key) => {
        objects.delete(key);
      },
    };
    vi.spyOn(providers, "gmailProviderForUser").mockResolvedValue(f.provider);
    vi.spyOn(productionOrderMailAttachmentStorage, "put").mockImplementation(
      storage.put,
    );
    vi.spyOn(productionOrderMailAttachmentStorage, "delete").mockImplementation(
      storage.delete,
    );
    const input = {
      id: parseShortcodeFor("email", email.shortcode),
      expectedChecksum: checksum,
      reviewedChecksum: checksum,
      classification: "related" as const,
      reason: "Synthetic member restored reviewed evidence",
    };
    const read = () =>
      loadMailAttachmentOriginal(
        ctx.db,
        { orderMailId: f.source.id, attachmentRef: attachment.id },
        storage.get,
      );
    return {
      ...f,
      email,
      attachment,
      checksum,
      retiredKey,
      objects,
      storage,
      input,
      read,
    };
  }
  describe("attachment disposal publication", () => {
    it("keeps corrected bytes readable when an older committed cleanup deletes its captured legacy key later", async () => {
      const f = await disposalFixture();
      const entered = signal<string>();
      const release = signal<void>();
      const importRun = await syntheticMailImportRun(ctx.db, ctx.actor, {
        ledgerPartyId: f.party.id,
        mailboxId: f.mailboxId,
      });
      const pending = ingestGmailMessages(ctx.db, f.provider, {
        ledgerPartyId: f.party.id,
        mailboxId: f.mailboxId,
        messageIds: [f.messageId],
        runId: importRun,
        triage: async () => "unrelated",
        relevance: async () => ({ classification: "unrelated" }),
        storage: {
          ...f.storage,
          delete: async (key) => {
            entered.resolve(key);
            await release.promise;
            await f.storage.delete(key);
          },
        },
      });
      try {
        const key = await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error(
              "Synthetic unrelated fixture completed without retiring attachment bytes",
            );
          }),
        ]);
        expect(key).toBe(f.retiredKey);
        const [cleared] = await getDb(ctx.db)
          .select()
          .from(orderMailAttachment)
          .where(eq(orderMailAttachment.id, f.attachment.id));
        expect(cleared?.pendingObjectKey).toBeNull();
        await correctEmailRelevance(ctx.db, f.input, ctx.actor);
        const before = await state();
        expect(before.attachments).toHaveLength(1);
        expect(before.attachments[0]?.id).toBe(f.attachment.id);
        expect((await f.read()).dataBase64).toBe(
          Buffer.from("new").toString("base64"),
        );
        release.resolve();
        await pending;
        expect((await f.read()).dataBase64).toBe(
          Buffer.from("new").toString("base64"),
        );
        const after = await state();
        expect(after.emails).toEqual(before.emails);
        expect(after.originals).toEqual(before.originals);
        expect(after.attachments[0]?.pendingObjectKey).toBe(
          before.attachments[0]?.pendingObjectKey,
        );
        expect(f.objects.has(f.retiredKey)).toBe(false);
      } finally {
        release.resolve();
        await Promise.allSettled([pending]);
      }
    });
    it("keeps a newer committed correction readable when failed-upload rollback cleanup runs later on the same attachment row", async () => {
      const f = await disposalFixture(true);
      const entered = signal<string>();
      const release = signal<void>();
      let firstUpload = true;
      vi.spyOn(productionOrderMailAttachmentStorage, "put").mockImplementation(
        async (key, bytes) => {
          await f.storage.put(key, bytes, "application/pdf");
          if (firstUpload) {
            firstUpload = false;
            throw new Error("Synthetic upload failed after storing bytes");
          }
        },
      );
      vi.spyOn(
        productionOrderMailAttachmentStorage,
        "delete",
      ).mockImplementation(async (key) => {
        entered.resolve(key);
        await release.promise;
        await f.storage.delete(key);
      });
      const failed = correctEmailRelevance(ctx.db, f.input, ctx.actor);
      try {
        const failedKey = await entered.promise;
        const [rolledBack] = await getDb(ctx.db)
          .select()
          .from(orderMailAttachment)
          .where(eq(orderMailAttachment.id, f.attachment.id));
        expect(rolledBack?.pendingObjectKey).toBeNull();
        await correctEmailRelevance(ctx.db, f.input, ctx.actor);
        const before = await state();
        expect(before.attachments).toHaveLength(1);
        expect(before.attachments[0]?.id).toBe(f.attachment.id);
        expect((await f.read()).dataBase64).toBe(
          Buffer.from("new").toString("base64"),
        );
        release.resolve();
        await expect(failed).rejects.toThrow(
          "Synthetic upload failed after storing bytes",
        );
        expect((await f.read()).dataBase64).toBe(
          Buffer.from("new").toString("base64"),
        );
        expect(await state()).toEqual(before);
        expect(f.objects.has(failedKey)).toBe(false);
      } finally {
        release.resolve();
        await Promise.allSettled([failed]);
      }
    });
    it("daily cleanup retries a failed postcommit retired-key deletion after correction without deleting the restored bytes", async () => {
      const f = await disposalFixture();
      const deleted: string[] = [];
      let firstDelete = true;
      const storage: OrderMailAttachmentStorage = {
        ...f.storage,
        delete: async (key) => {
          deleted.push(key);
          if (firstDelete) {
            firstDelete = false;
            throw new Error("Synthetic retired-key storage outage");
          }
          await f.storage.delete(key);
        },
      };
      const importRun = await syntheticMailImportRun(ctx.db, ctx.actor, {
        ledgerPartyId: f.party.id,
        mailboxId: f.mailboxId,
      });
      await expect(
        ingestGmailMessages(ctx.db, f.provider, {
          ledgerPartyId: f.party.id,
          mailboxId: f.mailboxId,
          messageIds: [f.messageId],
          runId: importRun,
          triage: async () => "unrelated",
          relevance: async () => ({ classification: "unrelated" }),
          storage,
        }),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({
          message: "Synthetic retired-key storage outage",
        }),
      });
      const cleared = await state();
      expect(cleared.emails[0]).toMatchObject({
        classification: "unrelated",
        status: "completed",
      });
      expect(cleared.originals[0]?.content?.bodyText).toBeNull();
      expect(cleared.attachments[0]?.pendingObjectKey).toBeNull();
      expect(f.objects.has(f.retiredKey)).toBe(true);
      await correctEmailRelevance(ctx.db, f.input, ctx.actor);
      const before = await state();
      await disposeUnrelatedOriginals(ctx.db, storage);
      expect(deleted).toEqual([f.retiredKey, f.retiredKey]);
      expect(f.objects.has(f.retiredKey)).toBe(false);
      expect((await f.read()).dataBase64).toBe(
        Buffer.from("new").toString("base64"),
      );
      const after = await state();
      expect(after.emails).toEqual(before.emails);
      expect(after.originals).toEqual(before.originals);
      expect(after.attachments[0]?.pendingObjectKey).toBe(
        before.attachments[0]?.pendingObjectKey,
      );
      await disposeUnrelatedOriginals(ctx.db, storage);
      expect(deleted).toEqual([f.retiredKey, f.retiredKey]);
    });
    it("daily cleanup isolates an oldest failed key while acknowledging later keys and clearing another unrelated original", async () => {
      const f = await disposalFixture();
      const laterKey = "synthetic-later-retired-cache";
      const unrelatedKey = "synthetic-other-unrelated-cache";
      f.objects.set(laterKey, Buffer.from("old"));
      f.objects.set(unrelatedKey, Buffer.from("old"));
      await getDb(ctx.db)
        .update(orderMailAttachment)
        .set({
          pendingObjectKey: null,
          pendingDeleteKeys: [f.retiredKey, laterKey],
          createdAt: new Date("2001-01-01T00:00:00Z"),
        })
        .where(eq(orderMailAttachment.id, f.attachment.id));
      const other = await syntheticRetainedMail(ctx.db, {
        ledgerPartyId: f.party.id,
        mailboxId: f.mailboxId,
        messageId: "synthetic-independent-unrelated",
        rawChecksum: "c".repeat(64),
        content: {
          snippet: null,
          bodyText: "Synthetic independent unrelated content",
          bodyHtml: null,
        },
      });
      await getDb(ctx.db)
        .update(emailTable)
        .set({ classification: "unrelated", status: "completed" })
        .where(eq(emailTable.orderMailId, other.id));
      await getDb(ctx.db)
        .insert(orderMailAttachment)
        .values({
          orderMailId: other.id,
          providerAttachmentId: "synthetic-independent-part",
          filename: "synthetic-other.pdf",
          mimeType: "application/pdf",
          checksum: "d".repeat(64),
          pendingObjectKey: unrelatedKey,
        });
      const deleted: string[] = [];
      await expect(
        disposeUnrelatedOriginals(ctx.db, {
          ...f.storage,
          delete: async (key) => {
            deleted.push(key);
            if (key === f.retiredKey)
              throw new Error("Synthetic oldest cache deletion failed");
            await f.storage.delete(key);
          },
        }),
      ).rejects.toThrow("Synthetic oldest cache deletion failed");
      expect(f.objects.has(laterKey)).toBe(false);
      expect(f.objects.has(unrelatedKey)).toBe(false);
      expect(f.objects.has(f.retiredKey)).toBe(true);
      expect(deleted).toEqual(
        expect.arrayContaining([f.retiredKey, laterKey, unrelatedKey]),
      );
      const [pending] = await getDb(ctx.db)
        .select()
        .from(orderMailAttachment)
        .where(eq(orderMailAttachment.id, f.attachment.id));
      expect(pending?.pendingDeleteKeys).toEqual([f.retiredKey]);
      const [cleared] = await getDb(ctx.db)
        .select()
        .from(orderMail)
        .where(eq(orderMail.id, other.id));
      expect(cleared?.content?.bodyText).toBeNull();
      const [email] = await getDb(ctx.db)
        .select()
        .from(emailTable)
        .where(eq(emailTable.orderMailId, other.id));
      expect(email?.contentClearedAt).toBeInstanceOf(Date);
    });
  });
});
