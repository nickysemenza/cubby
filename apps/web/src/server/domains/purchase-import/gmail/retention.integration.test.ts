/** Failures: metadata updates extend cache life; expiry erases a disposition or
 * event; a promoted Image or accepted source loses its bytes; unrelated discovery
 * is mistaken for member-search expiry; expiry destroys an admitted or ambiguously
 * assigned original before import finishes. These use persisted state, not Gmail deletion. */
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as s3 from "~/server/clients/s3";
import { getDb } from "~/server/db/helpers";
import {
  image,
  importSourceClaim,
  email as emailTable,
  orderMail,
  orderMailAttachment,
  orderMailEvent,
  run,
} from "~/server/db/schema";
import { readRetainedMail } from "~/server/domains/mail/repo/retained-mail";
import { ensureRun } from "~/server/domains/run/service/ensure-run";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { startEmailImport } from "../email-actions";
import { importedPurchaseFixture } from "../import-run.fixtures";
import { readMail } from "../mail-tool";
import { ingestGmailMessages } from "./ingest";
import { disposeExpiredSearchOriginals } from "./persistence";
import type { GmailProvider } from "./types";

const gmail: GmailProvider = {
  getProfile: async () => ({ historyId: "100" }),
  listMessages: async () => ({}),
  listHistory: async () => ({}),
  getAttachment: async () => ({
    data: Buffer.from("Synthetic attachment").toString("base64url"),
  }),
  getMessage: async (id) => ({
    id,
    internalDate: "1788220800000",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "search@example.test" },
        { name: "Subject", value: "Synthetic search candidate" },
      ],
      body: {
        data: Buffer.from("Synthetic search body").toString("base64url"),
      },
      parts: ["cache", "promoted"].map((partId) => ({
        partId,
        filename: `${partId}.pdf`,
        mimeType: "application/pdf",
        body: { attachmentId: partId },
      })),
    },
  }),
};
const storage = {
  put: async () => undefined,
  get: async () => new Uint8Array(),
  delete: async (_key: string) => undefined,
};

describe("explicit member-search cache expiry", () => {
  const ctx = withTestDb();
  const now = new Date("2026-10-10T12:00:00Z");
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { status: "running", ambiguous: false },
    { status: "paused_auth", ambiguous: false },
    { status: "running", ambiguous: true },
  ] as const)(
    "preserves $status admitted search originals at expiry (ambiguous=$ambiguous), while abandoned caches expire",
    async ({ status, ambiguous }) => {
      const party = await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Synthetic admitted search member",
        kind: "member",
        userId: ctx.actor.userId,
      });
      const expiry = new Date(now.getTime() + 2);
      const bytes = new Map<string, Uint8Array>();
      const deleted: string[] = [];
      const retainedStorage = {
        put: async (key: string, content: Uint8Array) => {
          bytes.set(key, content);
        },
        get: async (key: string) => {
          const content = bytes.get(key);
          if (!content) throw new Error("Synthetic attachment missing");
          return content;
        },
        delete: async (key: string) => {
          deleted.push(key);
          bytes.delete(key);
        },
      };
      await ingestGmailMessages(ctx.db, gmail, {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-mailbox",
        messageIds: ["admitted-search", "abandoned-search"],
        callerJudges: true,
        storage: retainedStorage,
      });
      await getDb(ctx.db)
        .update(emailTable)
        .set({ searchExpiresAt: new Date(now.getTime() + 1) })
        .where(eq(emailTable.ledgerPartyId, party.id));
      const [selected] = await getDb(ctx.db)
        .select()
        .from(emailTable)
        .where(eq(emailTable.messageId, "admitted-search"));
      if (!selected?.orderMailId) throw new Error("Synthetic search missing");
      const admission = await startEmailImport(
        ctx.db,
        {
          items: [
            {
              id: parseShortcodeFor("email", selected.shortcode),
              expectedChecksum: selected.checksum,
            },
          ],
        },
        ctx.actor,
        { send: async () => {} },
      );
      const [owner] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.shortcode, admission.runIds[0]!));
      if (!owner) throw new Error("Synthetic admitted Run missing");
      const frozen = mailResearchRunInput.parse(owner.input);
      expect(frozen.sources).toEqual([
        { orderMailId: selected.orderMailId, checksum: selected.checksum },
      ]);
      await getDb(ctx.db)
        .update(run)
        .set({
          status,
          input: ambiguous
            ? {
                ...frozen,
                sources: [
                  {
                    orderMailId: selected.orderMailId,
                    checksum: "b".repeat(64),
                  },
                ],
              }
            : frozen,
        })
        .where(eq(run.id, owner.id));
      const attachments = await getDb(ctx.db)
        .select()
        .from(orderMailAttachment)
        .where(eq(orderMailAttachment.orderMailId, selected.orderMailId));
      expect(await getDb(ctx.db).select().from(importSourceClaim)).toEqual([]);
      expect(
        await disposeExpiredSearchOriginals(ctx.db, retainedStorage, expiry),
      ).toBe(1);
      expect(deleted).toHaveLength(2);
      for (const attachment of attachments) {
        expect(deleted).not.toContain(attachment.pendingObjectKey);
        expect(bytes.has(attachment.pendingObjectKey!)).toBe(true);
      }
      expect(
        (await getDb(ctx.db).select().from(emailTable)).find(
          (row) => row.id === selected.id,
        ),
      ).toMatchObject({
        runId: owner.id,
        checksum: selected.checksum,
        contentClearedAt: null,
      });
      expect(
        (await getDb(ctx.db).select().from(emailTable)).find(
          (row) => row.messageId === "abandoned-search",
        ),
      ).toMatchObject({ contentClearedAt: expiry });
      expect(
        (
          await readRetainedMail(ctx.db, {
            ledgerPartyIds: [party.id],
            messageId: "admitted-search",
          })
        )[0]?.content.bodyText,
      ).toBe("Synthetic search body");
      if (ambiguous) return;
      // A paused Run cannot execute tools; resume before testing its frozen reads.
      if (status === "paused_auth")
        await getDb(ctx.db)
          .update(run)
          .set({ status: "running" })
          .where(eq(run.id, owner.id));
      vi.spyOn(s3, "getS3Object").mockImplementation(
        async (key) =>
          new Response(Buffer.from(await retainedStorage.get(key))),
      );
      const cacheAttachment = attachments.find(
        (row) => row.filename === "cache.pdf",
      );
      if (!cacheAttachment)
        throw new Error("Synthetic admitted attachment missing");
      const read = await readMail(
        ctx.db,
        {
          mailboxId: "synthetic-mailbox",
          messageId: "admitted-search",
          attachmentId: cacheAttachment.providerAttachmentId,
        },
        { ...ctx.actor, runId: owner.id },
      );
      expect(read.boundToRun).toBe(true);
      expect(read.content.bodyText).toBe("Synthetic search body");
      expect(read.originalAttachment?.dataBase64).toBe(
        Buffer.from("Synthetic attachment").toString("base64"),
      );
    },
  );

  it("expires unaccepted claimed search bytes while preserving headers, disposition, events and promoted Images", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic search member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    await ingestGmailMessages(ctx.db, gmail, {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-mailbox",
      messageIds: ["expired-search"],
      callerJudges: true,
      storage,
    });
    await ingestGmailMessages(ctx.db, gmail, {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-mailbox",
      messageIds: ["discovery"],
      triage: async () => "related",
      storage,
    });
    const [original] = await readRetainedMail(ctx.db, {
      ledgerPartyIds: [party.id],
      messageId: "expired-search",
    });
    if (!original) throw new Error("Synthetic search original missing");
    const attachments = await getDb(ctx.db)
      .select()
      .from(orderMailAttachment)
      .where(eq(orderMailAttachment.orderMailId, original.id));
    const promoted = attachments.find((row) => row.filename === "promoted.pdf");
    const cache = attachments.find((row) => row.filename === "cache.pdf");
    if (!promoted || !cache)
      throw new Error("Synthetic attachment fixtures missing");
    const claimRun = await ensureRun(ctx.db, ctx.actor, {
      purpose: "background",
      trigger: "manual",
      status: "completed",
    });
    await getDb(ctx.db)
      .insert(importSourceClaim)
      .values({
        ledgerPartyId: party.id,
        kind: "mail_message",
        externalKey: `gmail:${original.mailboxId}:${original.messageId}`,
        checksum: original.rawChecksum,
        firstRunId: claimRun,
        lastRunId: claimRun,
      });
    const independent = await insertWithShortcode(ctx.db, "image", {
      key: "synthetic/independent-evidence.pdf",
      filename: "promoted.pdf",
      size: 20,
      contentType: "application/pdf",
      status: "UPLOADED",
      sha256: promoted.checksum,
    });
    await getDb(ctx.db)
      .update(orderMailAttachment)
      .set({ imageId: independent.id })
      .where(eq(orderMailAttachment.id, promoted.id));
    const [event] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: original.id,
        event: "placed",
        sourceKey: "synthetic-search-event",
        payload: {},
      })
      .returning();
    await getDb(ctx.db)
      .update(emailTable)
      .set({
        searchExpiresAt: new Date("2026-10-09T12:00:00Z"),
        updatedAt: now,
        status: "blocked",
        classificationReason: "Synthetic unresolved disposition",
      })
      .where(eq(emailTable.messageId, "expired-search"));
    // An expiry timestamp alone never makes discovery a member-search cache.
    await getDb(ctx.db)
      .update(emailTable)
      .set({ searchExpiresAt: new Date("2026-10-09T12:00:00Z") })
      .where(eq(emailTable.messageId, "discovery"));
    const deleted: string[] = [];
    expect(
      await disposeExpiredSearchOriginals(
        ctx.db,
        {
          ...storage,
          delete: async (key) => {
            deleted.push(key);
          },
        },
        now,
      ),
    ).toBe(1);
    expect(deleted).toEqual([cache.pendingObjectKey]);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(orderMail)
          .where(eq(orderMail.id, original.id))
      )[0],
    ).toMatchObject({
      rawChecksum: original.rawChecksum,
      content: { bodyText: null, bodyHtml: null, snippet: null },
    });
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(emailTable)
          .where(eq(emailTable.messageId, "expired-search"))
      )[0],
    ).toMatchObject({
      subject: "Synthetic search candidate",
      status: "blocked",
      classificationReason: "Synthetic unresolved disposition",
      searchOrigin: "member_search",
      contentClearedAt: now,
      orderMailId: original.id,
    });
    expect(await getDb(ctx.db).select().from(orderMailEvent)).toEqual([event]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(image)
        .where(eq(image.id, independent.id)),
    ).toEqual([independent]);
    expect(
      (
        await readRetainedMail(ctx.db, {
          ledgerPartyIds: [party.id],
          messageId: "discovery",
        })
      )[0]?.content.bodyText,
    ).toBe("Synthetic search body");
  });

  it("preserves accepted source content even after its explicit member-search expiry", async () => {
    const fixture = await importedPurchaseFixture(ctx.db, ctx.actor);
    if (!fixture.association)
      throw new Error("Synthetic accepted source missing");
    await ingestGmailMessages(ctx.db, gmail, {
      ledgerPartyId: fixture.party.id,
      mailboxId: "synthetic-mailbox",
      messageIds: ["accepted-search"],
      callerJudges: true,
      storage,
    });
    const [original] = await readRetainedMail(ctx.db, {
      ledgerPartyIds: [fixture.party.id],
    });
    if (!original) throw new Error("Synthetic accepted original missing");
    await getDb(ctx.db)
      .update(importSourceClaim)
      .set({
        externalKey: `gmail:${original.mailboxId}:${original.messageId}`,
        checksum: original.rawChecksum,
      })
      .where(eq(importSourceClaim.id, fixture.association.sourceClaimId));
    await getDb(ctx.db)
      .update(emailTable)
      .set({ searchExpiresAt: new Date("2026-10-09T12:00:00Z") })
      .where(eq(emailTable.messageId, "accepted-search"));
    const deleted: string[] = [];
    expect(
      await disposeExpiredSearchOriginals(
        ctx.db,
        {
          ...storage,
          delete: async (key) => {
            deleted.push(key);
          },
        },
        now,
      ),
    ).toBe(0);
    expect(deleted).toEqual([]);
    expect(
      await readRetainedMail(ctx.db, { ledgerPartyIds: [fixture.party.id] }),
    ).toEqual([original]);
    expect(
      (await getDb(ctx.db).select().from(emailTable))[0]?.contentClearedAt,
    ).toBeNull();
  });
});
