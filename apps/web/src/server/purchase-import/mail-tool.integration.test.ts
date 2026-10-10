/**
 * Failures: search reaches a mailbox the member never connected, follows a
 * page into another mailbox, pages without Spam/Trash exclusion, or advances
 * mailbox coverage (also after an upstream 429); revoked Gmail authorization
 * surfaces as a crash instead of a reconnect result; `mail.read` returns
 * another message's attachment, loses the original once storage moves to its
 * Image, serves changed bytes, or truncates an oversized original; an
 * unrelated disposition deletes an original a Purchase still depends on.
 */
import { MAIL_ATTACHMENT_MAX_BYTES } from "@cubby/schemas/mailbox-research";
import { sha256Hex } from "@cubby/shared/sha256";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import { wrapAiGatewayError } from "~/server/ai/gateway-error";
import { account } from "~/server/db/auth.schema";
import {
  importSourceClaim,
  importSourceOrder,
  mailboxCursor,
  mailboxMessage,
  orderMail,
  orderMailAttachment,
  orderMailCandidateDecision,
  orderMailEvent,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import * as s3 from "~/server/utils/s3";

import { loadMailAttachmentOriginal } from "./gmail/attachment-original";
import type { OrderMailAttachmentStorage } from "./gmail/attachment-storage";
import * as gmail from "./gmail/provider";
import { GmailAuthorizationError } from "./gmail/tokens";
import * as routing from "./gmail/triage-model";
import { GmailApiError, type GmailProvider } from "./gmail/types";
import { readMail, resolveMail, searchMail } from "./mail-tool";

const mailboxId = "synthetic-mailbox";
const receiptBytes = new TextEncoder().encode(
  "%PDF-1.4\nSynthetic kettle: XL copper variant\n%%EOF\n",
);

describe("public mail tool", () => {
  const ctx = withTestDb();
  afterEach(() => vi.restoreAllMocks());

  const member = () =>
    insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic mail member",
      kind: "member",
      userId: ctx.actor.userId,
    });

  const connect = (accountId: string) =>
    getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId,
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });

  describe("search", () => {
    async function fixture() {
      const party = await member();
      await connect(mailboxId);
      // Pi searches under its Mail import Run; classification spends against it.
      const importRun = await insertWithShortcode(ctx.db, "run", {
        purpose: "mail_import",
        status: "running",
        trigger: "manual",
        ledgerPartyId: party.id,
        actorUserId: ctx.actor.userId,
        actorName: party.name,
        actorEmail: "mail@example.test",
        actorLedgerPartyShortcode: party.shortcode,
        actorLedgerPartyName: party.name,
        actorLedgerPartyKind: "member",
      });
      const actor = { ...ctx.actor, runId: importRun.id };
      vi.spyOn(routing, "productionMailTriage").mockReturnValue(
        async (content) =>
          content.includes("Synthetic promotion") ? "unrelated" : "related",
      );
      const list = vi.fn<GmailProvider["listMessages"]>(
        async ({ pageToken }) =>
          pageToken
            ? { messages: [{ id: "synthetic-second" }] }
            : {
                messages: [
                  { id: "synthetic-first" },
                  { id: "synthetic-negative" },
                  { id: "synthetic-trash" },
                ],
                nextPageToken: "synthetic-google-page",
              },
      );
      const provider = fromPartial<GmailProvider>({
        listMessages: list,
        getMessage: async (id: string) => ({
          id,
          labelIds: id === "synthetic-trash" ? ["TRASH"] : ["INBOX"],
          internalDate: "1790856000000",
          snippet: "Synthetic receipt",
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "From", value: "orders@shop.example.test" },
              {
                name: "Subject",
                value:
                  id === "synthetic-negative"
                    ? "Synthetic promotion"
                    : "Synthetic order receipt",
              },
            ],
            body: {
              data: Buffer.from(
                "One synthetic copper kettle. Total USD 24.",
              ).toString("base64url"),
            },
          },
        }),
      });
      const providers = vi
        .spyOn(gmail, "gmailProviderForUser")
        .mockResolvedValue(provider);
      const input = { query: "synthetic copper kettle" };
      return { party, actor, list, providers, input };
    }

    const cursors = () => getDb(ctx.db).select().from(mailboxCursor);

    it("refuses a mailbox not connected to this member, also with a borrowed page token, before fetching", async () => {
      const f = await fixture();
      await expect(
        searchMail(
          ctx.db,
          { ...f.input, mailboxId: "synthetic-foreign-mailbox" },
          f.actor,
        ),
      ).rejects.toThrow(/not connected/u);
      await expect(
        searchMail(
          ctx.db,
          {
            ...f.input,
            mailboxId: "synthetic-foreign-mailbox",
            pageToken: "synthetic-google-page",
          },
          f.actor,
        ),
      ).rejects.toThrow(/not connected/u);
      expect(f.providers).not.toHaveBeenCalled();
      // Two connected mailboxes and none named: the caller must choose.
      await connect("synthetic-second-mailbox");
      expect(await searchMail(ctx.db, f.input, f.actor)).toMatchObject({
        status: "mailbox_required",
        mailboxes: expect.arrayContaining([
          mailboxId,
          "synthetic-second-mailbox",
        ]),
        messages: [],
      });
      expect(f.providers).not.toHaveBeenCalled();
      // A page token only ever continues against the mailbox the caller names.
      await searchMail(
        ctx.db,
        {
          ...f.input,
          mailboxId: "synthetic-second-mailbox",
          pageToken: "synthetic-google-page",
        },
        f.actor,
      );
      expect(f.providers).toHaveBeenCalledWith(
        ctx.db,
        ctx.actor.userId,
        "synthetic-second-mailbox",
      );
      expect(await cursors()).toEqual([]);
    });

    it("returns reconnect-required for revoked Gmail authorization without retaining mail", async () => {
      const f = await fixture();
      f.providers.mockRejectedValueOnce(
        new GmailAuthorizationError("Synthetic revoked Gmail authorization"),
      );
      expect(await searchMail(ctx.db, f.input, f.actor)).toEqual({
        status: "gmail_reconnect_required",
        mailboxes: [mailboxId],
        messages: [],
        nextPageToken: null,
      });
      f.list.mockRejectedValueOnce(
        new GmailApiError({ status: 401, message: "Synthetic expired token" }),
      );
      expect(await searchMail(ctx.db, f.input, f.actor)).toMatchObject({
        status: "gmail_reconnect_required",
      });
      expect(await getDb(ctx.db).select().from(mailboxMessage)).toEqual([]);
      expect(await getDb(ctx.db).select().from(orderMail)).toEqual([]);
    });

    it("pages scoped history excluding Spam and Trash without advancing mailbox coverage", async () => {
      const f = await fixture();
      const first = await searchMail(ctx.db, f.input, f.actor);
      expect(f.list).toHaveBeenCalledWith({
        query: "(synthetic copper kettle) -in:spam -in:trash",
        maxResults: 25,
      });
      expect(first).toMatchObject({
        status: "ok",
        nextPageToken: "synthetic-google-page",
      });
      // Only retained originals come back; Trash and negatives are not readable.
      expect(first.messages.map((row) => row.messageId)).toEqual([
        "synthetic-first",
      ]);
      const second = await searchMail(
        ctx.db,
        { ...f.input, pageToken: "synthetic-google-page" },
        f.actor,
      );
      expect(f.list).toHaveBeenLastCalledWith({
        query: "(synthetic copper kettle) -in:spam -in:trash",
        maxResults: 25,
        pageToken: "synthetic-google-page",
      });
      expect(second).toMatchObject({
        status: "ok",
        nextPageToken: null,
        messages: [{ messageId: "synthetic-second", status: "pending" }],
      });
      expect(await cursors()).toEqual([]);
      const originals = await getDb(ctx.db)
        .select({ messageId: orderMail.messageId })
        .from(orderMail)
        .where(eq(orderMail.ledgerPartyId, f.party.id));
      expect(originals.map((row) => row.messageId).sort()).toEqual([
        "synthetic-first",
        "synthetic-second",
      ]);
      const ledger = await getDb(ctx.db)
        .select({
          messageId: mailboxMessage.messageId,
          classification: mailboxMessage.classification,
          status: mailboxMessage.status,
          orderMailId: mailboxMessage.orderMailId,
        })
        .from(mailboxMessage)
        .where(eq(mailboxMessage.ledgerPartyId, f.party.id));
      expect(ledger).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            messageId: "synthetic-negative",
            classification: "unrelated",
            status: "completed",
            orderMailId: null,
          }),
          expect.objectContaining({
            messageId: "synthetic-trash",
            status: "excluded",
            orderMailId: null,
          }),
        ]),
      );
    });

    it("never moves coverage or retains mail when Gmail or classification fails upstream with 429", async () => {
      const f = await fixture();
      f.list.mockRejectedValueOnce(
        new GmailApiError({ status: 429, message: "Synthetic Gmail quota" }),
      );
      await expect(searchMail(ctx.db, f.input, f.actor)).rejects.toThrow(
        "Synthetic Gmail quota",
      );
      vi.mocked(routing.productionMailTriage).mockReturnValue(async () => {
        throw wrapAiGatewayError(
          new Error("Synthetic quota"),
          {
            model: "synthetic-model",
            provider: "openai",
            route: "openai-responses",
            feature: "mail-classification",
            operation: "classify",
          },
          {
            status: 429,
            statusText: "Too Many Requests",
            body: "Synthetic upstream refusal",
            retryAfter: "45",
          },
        );
      });
      await expect(searchMail(ctx.db, f.input, f.actor)).rejects.toThrow(
        "Synthetic upstream refusal",
      );
      expect(await cursors()).toEqual([]);
      expect(await getDb(ctx.db).select().from(orderMail)).toEqual([]);
    });

    it("lets a member without a Run search with rules only, retaining candidates for the caller to settle", async () => {
      const f = await fixture();
      const relevance = vi.spyOn(routing, "productionMailRelevance");
      const found = await searchMail(ctx.db, f.input, ctx.actor);
      // No paid classification: the caller owns judgment.
      expect(routing.productionMailTriage).not.toHaveBeenCalled();
      expect(relevance).not.toHaveBeenCalled();
      expect(found.messages.map((row) => row.messageId).sort()).toEqual([
        "synthetic-first",
        "synthetic-negative",
      ]);
      const ledger = await getDb(ctx.db)
        .select({
          messageId: mailboxMessage.messageId,
          classification: mailboxMessage.classification,
          classificationStage: mailboxMessage.classificationStage,
          status: mailboxMessage.status,
          orderMailId: mailboxMessage.orderMailId,
        })
        .from(mailboxMessage)
        .where(eq(mailboxMessage.ledgerPartyId, f.party.id));
      expect(ledger).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            messageId: "synthetic-first",
            classification: "uncertain",
            classificationStage: "rule",
            status: "pending",
            orderMailId: expect.any(String),
          }),
          // Spam and Trash are the free rule's negatives: never retained.
          expect.objectContaining({
            messageId: "synthetic-trash",
            status: "excluded",
            orderMailId: null,
          }),
        ]),
      );
      const [first] = await getDb(ctx.db)
        .select()
        .from(orderMail)
        .where(eq(orderMail.messageId, "synthetic-first"));
      if (!first) throw new Error("Synthetic candidate was not retained");
      await resolveMail(
        ctx.db,
        {
          mailboxId,
          messageId: first.messageId,
          checksum: first.rawChecksum,
          disposition: { kind: "unrelated", reason: "Not a purchase" },
        },
        ctx.actor,
      );
      expect(
        await getDb(ctx.db)
          .select({ id: orderMail.id })
          .from(orderMail)
          .where(eq(orderMail.id, first.id)),
      ).toEqual([]);
      expect(
        await getDb(ctx.db)
          .select({
            classification: mailboxMessage.classification,
            orderMailId: mailboxMessage.orderMailId,
          })
          .from(mailboxMessage)
          .where(eq(mailboxMessage.messageId, "synthetic-first")),
      ).toEqual([{ classification: "unrelated", orderMailId: null }]);
      expect(await cursors()).toEqual([]);
    });
  });

  describe("read attachment originals", () => {
    async function fixture(bytes: Uint8Array = receiptBytes) {
      const party = await member();
      const [mail] = await getDb(ctx.db)
        .insert(orderMail)
        .values({
          ledgerPartyId: party.id,
          mailboxId,
          messageId: "synthetic-attachment-message",
          sender: "receipts@example.test",
          subject: "Your original receipt",
          receivedAt: new Date("2026-10-01T12:00:00Z"),
          rawChecksum: "a".repeat(64),
          content: {
            snippet: null,
            bodyText: "The variant is only in the attached receipt.",
            bodyHtml: null,
          },
        })
        .returning();
      if (!mail) throw new Error("Synthetic mail missing");
      const [attachment] = await getDb(ctx.db)
        .insert(orderMailAttachment)
        .values({
          orderMailId: mail.id,
          providerAttachmentId: "synthetic-receipt-part",
          filename: "receipt.pdf",
          mimeType: "application/pdf",
          checksum: await sha256Hex(bytes),
          pendingObjectKey: "synthetic/private/original-receipt",
        })
        .returning();
      if (!attachment) throw new Error("Synthetic attachment missing");
      await getDb(ctx.db).insert(mailboxMessage).values({
        ledgerPartyId: party.id,
        mailboxId,
        messageId: mail.messageId,
        checksum: mail.rawChecksum,
        classification: "related",
        classificationVersion: "synthetic-v1",
        status: "pending",
        orderMailId: mail.id,
      });
      const originals = new Map([[attachment.pendingObjectKey!, bytes]]);
      const reads = vi
        .spyOn(s3, "getS3Object")
        .mockImplementation(async (key) => {
          const value = originals.get(key);
          return value
            ? new Response(Buffer.from(value))
            : new Response("missing", { status: 404, statusText: "Not Found" });
        });
      const input = {
        mailboxId,
        messageId: mail.messageId,
        attachmentId: attachment.providerAttachmentId,
      };
      return { party, mail, attachment, originals, reads, input, bytes };
    }

    it("returns an attachment original's bytes", async () => {
      const f = await fixture();
      const read = await readMail(ctx.db, f.input, ctx.actor);
      expect(read.originalAttachment).toEqual({
        attachmentId: "synthetic-receipt-part",
        filename: "receipt.pdf",
        mimeType: "application/pdf",
        checksum: f.attachment.checksum,
        dataBase64: Buffer.from(f.bytes).toString("base64"),
      });
      expect(JSON.stringify(read)).not.toContain(f.attachment.pendingObjectKey);
    });

    it("rejects another retained message's attachment reference before reading bytes", async () => {
      const f = await fixture();
      const [other] = await getDb(ctx.db)
        .insert(orderMail)
        .values({
          ledgerPartyId: f.party.id,
          mailboxId,
          messageId: "synthetic-other-source",
          sender: "other@example.test",
          subject: "Other source",
          receivedAt: new Date(),
          rawChecksum: "b".repeat(64),
          content: { snippet: null, bodyText: "Other source", bodyHtml: null },
        })
        .returning();
      if (!other) throw new Error("Synthetic other mail missing");
      const [foreign] = await getDb(ctx.db)
        .insert(orderMailAttachment)
        .values({
          orderMailId: other.id,
          providerAttachmentId: "synthetic-other-part",
          filename: "other.pdf",
          mimeType: "application/pdf",
          checksum: f.attachment.checksum,
          pendingObjectKey: "synthetic/private/other-original",
        })
        .returning();
      if (!foreign) throw new Error("Synthetic foreign attachment missing");
      await expect(
        readMail(
          ctx.db,
          { ...f.input, attachmentId: foreign.providerAttachmentId },
          ctx.actor,
        ),
      ).rejects.toThrow(/does not belong/u);
      await expect(
        loadMailAttachmentOriginal(ctx.db, {
          orderMailId: f.mail.id,
          attachmentRef: foreign.id,
        }),
      ).rejects.toThrow(/does not belong/u);
      expect(f.reads).not.toHaveBeenCalled();
    });

    it("reads the same original after attachment storage moved to its linked Image", async () => {
      const f = await fixture();
      const linked = await insertWithShortcode(ctx.db, "image", {
        key: "synthetic/private/linked-receipt-original",
        filename: "receipt.pdf",
        size: f.bytes.byteLength,
        contentType: "application/pdf",
        status: "UPLOADED",
        sha256: f.attachment.checksum,
      });
      await getDb(ctx.db)
        .update(orderMailAttachment)
        .set({ pendingObjectKey: null, imageId: linked.id })
        .where(eq(orderMailAttachment.id, f.attachment.id));
      f.originals.clear();
      f.originals.set(linked.key, f.bytes);
      const read = await readMail(ctx.db, f.input, ctx.actor);
      expect(read.originalAttachment?.dataBase64).toBe(
        Buffer.from(f.bytes).toString("base64"),
      );
      expect(f.reads.mock.calls.map(([key]) => key)).toEqual([linked.key]);
    });

    it("rejects bytes that no longer match the retained checksum", async () => {
      const f = await fixture();
      f.originals.set(
        f.attachment.pendingObjectKey!,
        new TextEncoder().encode("Changed synthetic original"),
      );
      await expect(readMail(ctx.db, f.input, ctx.actor)).rejects.toThrow(
        /checksum changed/u,
      );
    });

    it("refuses an oversized original instead of truncating it", async () => {
      const f = await fixture(new Uint8Array(MAIL_ATTACHMENT_MAX_BYTES + 1));
      await expect(readMail(ctx.db, f.input, ctx.actor)).rejects.toThrow(
        /byte|size|limit|exceed/iu,
      );
    });
  });

  describe("resolve unrelated", () => {
    async function fixture() {
      const party = await member();
      const content = "Synthetic message later judged unrelated";
      const [source] = await getDb(ctx.db)
        .insert(orderMail)
        .values({
          ledgerPartyId: party.id,
          mailboxId,
          messageId: "synthetic-message",
          sender: "orders@shop.example.test",
          subject: content,
          receivedAt: new Date("2026-10-07T12:00:00Z"),
          rawChecksum: await sha256Hex(content),
          content: { snippet: content, bodyText: content, bodyHtml: null },
        })
        .returning();
      if (!source) throw new Error("Synthetic source unavailable");
      await getDb(ctx.db).insert(mailboxMessage).values({
        ledgerPartyId: party.id,
        mailboxId,
        messageId: source.messageId,
        checksum: source.rawChecksum,
        classification: "related",
        classificationVersion: "synthetic-v1",
        status: "pending",
        orderMailId: source.id,
      });
      await getDb(ctx.db)
        .insert(orderMailAttachment)
        .values({
          orderMailId: source.id,
          providerAttachmentId: "synthetic-protected-part",
          filename: "receipt.pdf",
          mimeType: "application/pdf",
          checksum: "c".repeat(64),
          pendingObjectKey: "synthetic/private/protected-original",
        });
      const seller = await insertWithShortcode(ctx.db, "vendor", {
        name: "Synthetic protected seller",
      });
      const positive = await insertWithShortcode(ctx.db, "purchase", {
        vendorId: seller.id,
        orderId: "PROTECTED-ORDER",
      });
      const importRun = await insertWithShortcode(ctx.db, "run", {
        purpose: "mail_import",
        status: "completed",
        trigger: "manual",
        ledgerPartyId: party.id,
        actorUserId: ctx.actor.userId,
        actorName: party.name,
        actorEmail: "mail@example.test",
        actorLedgerPartyShortcode: party.shortcode,
        actorLedgerPartyName: party.name,
        actorLedgerPartyKind: "member",
      });
      const deleted: string[] = [];
      const storage = fromPartial<OrderMailAttachmentStorage>({
        delete: async (key: string) => {
          deleted.push(key);
        },
      });
      const resolve = () =>
        resolveMail(
          ctx.db,
          {
            mailboxId,
            messageId: source.messageId,
            checksum: source.rawChecksum,
            disposition: { kind: "unrelated", reason: "Marketing only" },
          },
          ctx.actor,
          storage,
        );
      return { party, source, seller, positive, importRun, deleted, resolve };
    }

    async function expectOriginalKept(f: Awaited<ReturnType<typeof fixture>>) {
      expect(
        await getDb(ctx.db)
          .select({ id: orderMail.id })
          .from(orderMail)
          .where(eq(orderMail.id, f.source.id)),
      ).toEqual([{ id: f.source.id }]);
      expect(
        await getDb(ctx.db)
          .select({ id: orderMailAttachment.id })
          .from(orderMailAttachment)
          .where(eq(orderMailAttachment.orderMailId, f.source.id)),
      ).toHaveLength(1);
      expect(f.deleted).toEqual([]);
      const [message] = await getDb(ctx.db)
        .select({ orderMailId: mailboxMessage.orderMailId })
        .from(mailboxMessage)
        .where(
          and(
            eq(mailboxMessage.mailboxId, mailboxId),
            eq(mailboxMessage.messageId, f.source.messageId),
          ),
        );
      expect(message).toEqual({ orderMailId: f.source.id });
    }

    it.each(["current", "historical", "alias"] as const)(
      "keeps an original an independently associated positive Purchase uses (source identity: %s)",
      async (identity) => {
        const f = await fixture();
        const canonicalKey = `gmail:${mailboxId}:${f.source.messageId}`;
        const claimValues = (externalKey: string) => ({
          ledgerPartyId: f.party.id,
          kind: "mail_message",
          externalKey,
          checksum: f.source.rawChecksum,
          firstRunId: f.importRun.id,
          lastRunId: f.importRun.id,
        });
        const [root] = await getDb(ctx.db)
          .insert(importSourceClaim)
          .values(claimValues(canonicalKey))
          .returning();
        if (!root) throw new Error("Synthetic canonical source unavailable");
        let claim = root;
        if (identity !== "current") {
          const [mapped] = await getDb(ctx.db)
            .insert(importSourceClaim)
            .values({
              ...claimValues(
                identity === "historical"
                  ? `gmail:${f.source.messageId}:order:PROTECTED-ORDER`
                  : "synthetic:historical-message-original",
              ),
              canonicalClaimId: root.id,
            })
            .returning();
          if (!mapped) throw new Error("Synthetic mapped source unavailable");
          claim = mapped;
        }
        await getDb(ctx.db)
          .insert(importSourceOrder)
          .values({
            sourceClaimId: claim.id,
            orderKey: `${f.seller.id}/order/PROTECTED-ORDER`,
            purchaseId: f.positive.id,
            checksum: f.source.rawChecksum,
            outputFingerprint: "synthetic-positive",
          });
        await f.resolve();
        await expectOriginalKept(f);
        expect(
          await getDb(ctx.db).select().from(importSourceOrder),
        ).toHaveLength(1);
        expect(
          await getDb(ctx.db)
            .select({ id: importSourceClaim.id })
            .from(importSourceClaim),
        ).toHaveLength(identity === "current" ? 1 : 2);
      },
    );

    it("keeps an original a reviewed Purchase link still uses", async () => {
      const f = await fixture();
      const [event] = await getDb(ctx.db)
        .insert(orderMailEvent)
        .values({
          orderMailId: f.source.id,
          event: "shipped",
          orderId: "PROTECTED-ORDER",
          sourceKey: "synthetic:reviewed-shipment",
        })
        .returning();
      if (!event) throw new Error("Synthetic event unavailable");
      await getDb(ctx.db).insert(orderMailCandidateDecision).values({
        eventId: event.id,
        purchaseId: f.positive.id,
        decision: "linked",
        evidenceChecksum: f.source.rawChecksum,
        decidedByUserId: ctx.actor.userId,
      });
      await f.resolve();
      await expectOriginalKept(f);
      expect(
        await getDb(ctx.db).select().from(orderMailCandidateDecision),
      ).toHaveLength(1);
    });
  });
});
