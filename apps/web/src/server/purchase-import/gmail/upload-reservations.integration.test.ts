/** Upload reservations must outlive rollback, failed cleanup and an interrupted publication.
 * Only the Gmail and object-store boundaries are replaced; ownership, transactions,
 * orphan discovery and current-original reads use persisted production paths. */
import { correctEmailRelevanceInput } from "@cubby/schemas/email-actions";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withConnection } from "~/server/db";
import { account } from "~/server/db/auth.schema";
import {
  email as emailTable,
  orderMailAttachment,
  imageProcessingOrphan,
} from "~/server/db/schema";
import {
  databaseForTransaction,
  getDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { claimImageProcessingOrphans } from "~/server/repo/image-processing";
import {
  reserveMailAttachmentUpload,
  cleanupAbandonedMailAttachmentUploads,
  MAIL_ATTACHMENT_UPLOAD_REASON,
} from "~/server/repo/mail-attachment-uploads";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { loadMailAttachmentOriginal } from "./attachment-original";
import {
  productionOrderMailAttachmentStorage,
  type OrderMailAttachmentStorage,
} from "./attachment-storage";
import { originalChecksum } from "./checksum";
import { normalizeMessage } from "./normalize";
import * as providers from "./provider";
import { correctEmailRelevance } from "./relevance-correction";
import { syntheticRetainedMail } from "./retained-mail.fixtures";
import type { GmailMessage, GmailProvider } from "./types";

describe("durable Mail attachment upload reservations", () => {
  const ctx = withTestDb();
  afterEach(() => vi.restoreAllMocks());
  const old = new Date("2001-01-01T00:00:00Z");
  async function fixture() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic upload member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const mailboxId = "synthetic-upload-mailbox";
    const message: GmailMessage = {
      id: "synthetic-upload-message",
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          {
            partId: "body",
            mimeType: "text/plain",
            body: {
              data: Buffer.from("Synthetic reviewed upload original").toString(
                "base64url",
              ),
            },
          },
          {
            partId: "pdf",
            mimeType: "application/pdf",
            filename: "synthetic.pdf",
            body: { attachmentId: "synthetic-upload-part", size: 3 },
          },
        ],
      },
    };
    const normalized = normalizeMessage(mailboxId, message);
    const checksum = await originalChecksum(normalized);
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: mailboxId,
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    const source = await syntheticRetainedMail(ctx.db, {
      ledgerPartyId: party.id,
      mailboxId,
      messageId: message.id,
      rawChecksum: checksum,
      content: {
        snippet: null,
        bodyText: "Synthetic previous retained original",
        bodyHtml: null,
      },
    });
    const part = normalized.attachments[0];
    if (!part) throw new Error("Synthetic upload descriptor missing");
    const [attachment] = await getDb(ctx.db)
      .insert(orderMailAttachment)
      .values({
        orderMailId: source.id,
        providerAttachmentId: part.sourceKey,
        filename: part.filename,
        mimeType: part.mimeType,
        checksum: "a".repeat(64),
      })
      .returning();
    const [email] = await getDb(ctx.db)
      .select()
      .from(emailTable)
      .where(eq(emailTable.orderMailId, source.id));
    if (!attachment || !email)
      throw new Error("Synthetic upload source missing");
    const provider: GmailProvider = {
      getMessage: async () => message,
      getAttachment: async () => ({
        data: Buffer.from("new").toString("base64url"),
        size: 3,
      }),
      getProfile: async () => ({ historyId: "1" }),
      listMessages: async () => ({}),
      listHistory: async () => ({}),
    };
    vi.spyOn(providers, "gmailProviderForUser").mockResolvedValue(provider);
    const objects = new Map<string, Uint8Array>();
    const storage: OrderMailAttachmentStorage = {
      put: async (key, bytes) => {
        objects.set(key, Uint8Array.from(bytes));
      },
      get: async (key) => {
        const bytes = objects.get(key);
        if (!bytes) throw new Error("Synthetic upload object missing");
        return bytes;
      },
      delete: async (key) => {
        objects.delete(key);
      },
    };
    const put = vi
      .spyOn(productionOrderMailAttachmentStorage, "put")
      .mockImplementation(storage.put);
    const remove = vi
      .spyOn(productionOrderMailAttachmentStorage, "delete")
      .mockImplementation(storage.delete);
    const input = correctEmailRelevanceInput.parse({
      id: email.shortcode,
      expectedChecksum: checksum,
      reviewedChecksum: checksum,
      classification: "related",
      reason: "Synthetic member reviewed this upload",
    });
    const read = () =>
      loadMailAttachmentOriginal(
        ctx.db,
        { orderMailId: source.id, attachmentRef: attachment.id },
        storage.get,
      );
    return { source, attachment, input, objects, storage, put, remove, read };
  }
  it("finds a rolled-back PUT after immediate cleanup fails and reaps it without deleting a later committed original", async () => {
    const f = await fixture();
    f.put.mockImplementation(async (key, bytes, type) => {
      await f.storage.put(key, bytes, type);
      throw new Error("Synthetic publication upload interrupted");
    });
    f.remove.mockRejectedValue(
      new Error("Synthetic immediate cleanup unavailable"),
    );
    await expect(
      correctEmailRelevance(ctx.db, f.input, ctx.actor),
    ).rejects.toThrow("Synthetic publication upload interrupted");
    expect(f.objects.size).toBe(1);
    const [key] = f.objects.keys();
    if (!key) throw new Error("Synthetic interrupted upload key missing");
    const [reserved] = await getDb(ctx.db)
      .select()
      .from(imageProcessingOrphan)
      .where(eq(imageProcessingOrphan.key, key));
    expect(reserved).toMatchObject({
      key,
      reason: MAIL_ATTACHMENT_UPLOAD_REASON,
    });
    const [rolledBack] = await getDb(ctx.db)
      .select()
      .from(orderMailAttachment)
      .where(eq(orderMailAttachment.id, f.attachment.id));
    expect(rolledBack?.pendingObjectKey).toBeNull();
    f.put.mockImplementation(f.storage.put);
    f.remove.mockImplementation(f.storage.delete);
    await correctEmailRelevance(ctx.db, f.input, ctx.actor);
    expect((await f.read()).dataBase64).toBe(
      Buffer.from("new").toString("base64"),
    );
    await getDb(ctx.db)
      .update(imageProcessingOrphan)
      .set({ createdAt: old })
      .where(eq(imageProcessingOrphan.key, key));
    expect(await cleanupAbandonedMailAttachmentUploads(ctx.db, f.storage)).toBe(
      1,
    );
    expect(f.objects.has(key)).toBe(false);
    expect((await f.read()).dataBase64).toBe(
      Buffer.from("new").toString("base64"),
    );
    expect(await getDb(ctx.db).select().from(imageProcessingOrphan)).toEqual(
      [],
    );
  });
  it("keeps the reservation durably discoverable when its enclosing rooted transaction rolls back", async () => {
    const key = `order-mail-attachment/synthetic-reserved/${crypto.randomUUID()}`;
    const attemptId = crypto.randomUUID();
    await expect(
      withTransaction(ctx.db, async (tx) => {
        await reserveMailAttachmentUpload(databaseForTransaction(tx), {
          key,
          attemptId,
        });
        throw new Error("Synthetic enclosing rollback");
      }),
    ).rejects.toThrow("Synthetic enclosing rollback");
    expect(
      await getDb(ctx.db)
        .select()
        .from(imageProcessingOrphan)
        .where(eq(imageProcessingOrphan.key, key)),
    ).toEqual([
      expect.objectContaining({
        key,
        attemptId,
        reason: MAIL_ATTACHMENT_UPLOAD_REASON,
      }),
    ]);
  });
  it("reaps an expired reservation abandoned before publication without relying on a caller catch handler", async () => {
    const key = `order-mail-attachment/synthetic-abandoned/${crypto.randomUUID()}`;
    await reserveMailAttachmentUpload(ctx.db, {
      key,
      attemptId: crypto.randomUUID(),
    });
    await getDb(ctx.db)
      .update(imageProcessingOrphan)
      .set({ createdAt: old })
      .where(eq(imageProcessingOrphan.key, key));
    const deleted: string[] = [];
    expect(
      await cleanupAbandonedMailAttachmentUploads(ctx.db, {
        delete: async (captured) => {
          deleted.push(captured);
        },
      }),
    ).toBe(1);
    expect(deleted).toEqual([key]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(imageProcessingOrphan)
        .where(eq(imageProcessingOrphan.key, key)),
    ).toEqual([]);
  });
  it("refuses an unrooted raw transaction before an original PUT", async () => {
    const f = await fixture();
    await expect(
      getDb(ctx.db).transaction(async (tx) =>
        correctEmailRelevance(databaseForTransaction(tx), f.input, ctx.actor),
      ),
    ).rejects.toThrow(
      "Mail attachment upload reservation requires a rooted durable database",
    );
    expect(f.put).not.toHaveBeenCalled();
    expect(f.objects.size).toBe(0);
  });
  it("refuses a rooted single-connection outer transaction before PUT because its reservation would roll back", async () => {
    const f = await fixture();
    await expect(
      withConnection(ctx.db, (single) =>
        withTransaction(single, async (tx) => {
          await correctEmailRelevance(
            databaseForTransaction(tx),
            f.input,
            ctx.actor,
          );
          throw new Error("Synthetic single-connection outer rollback");
        }),
      ),
    ).rejects.toThrow(
      "Mail attachment upload reservation requires an independent durable connection",
    );
    expect(f.put).not.toHaveBeenCalled();
    expect(f.objects.size).toBe(0);
    expect(await getDb(ctx.db).select().from(imageProcessingOrphan)).toEqual(
      [],
    );
    const [original] = await getDb(ctx.db)
      .select()
      .from(orderMailAttachment)
      .where(eq(orderMailAttachment.id, f.attachment.id));
    expect(original?.pendingObjectKey).toBeNull();
  });
  it("keeps reserved Mail keys out of the existing signed-image orphan claim", async () => {
    const key = `order-mail-attachment/synthetic-reserved/${crypto.randomUUID()}`;
    await reserveMailAttachmentUpload(ctx.db, {
      key,
      attemptId: crypto.randomUUID(),
    });
    const imageKey = "synthetic-expired-image-output";
    await getDb(ctx.db).insert(imageProcessingOrphan).values({
      key: imageKey,
      reason: "Synthetic abandoned image output",
      createdAt: old,
    });
    await getDb(ctx.db)
      .update(imageProcessingOrphan)
      .set({ createdAt: old })
      .where(eq(imageProcessingOrphan.key, key));
    const claimed = await claimImageProcessingOrphans(ctx.db, 100);
    expect(claimed).toContain(imageKey);
    expect(claimed).not.toContain(key);
  });
});
