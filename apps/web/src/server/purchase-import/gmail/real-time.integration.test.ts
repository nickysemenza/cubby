/** Failures: discarded content is re-persisted or admitted; identity or member/account
 * checks happen after fetch; provider failures overwrite prior evidence; foreign
 * attachment or changed response ids escape the exact-message fence. */
import { runEntityId } from "@cubby/schemas/identifiers";
import { MAIL_ATTACHMENT_MAX_BYTES } from "@cubby/schemas/mailbox-research";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import { account } from "~/server/db/auth.schema";
import {
  email as emailTable,
  orderMail,
  orderMailAttachment,
  emailClassificationObservation,
  emailCandidateObservation,
  emailRetrievalFailure,
  importSourceClaim,
  aiUsage,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import * as providers from "./provider";
import { readEmailOriginalTransient } from "./real-time";
import { GmailApiError, type GmailProvider } from "./types";

const mailboxId = "synthetic-mailbox";
const messageId = "synthetic-message";
const bytes = new TextEncoder().encode("%PDF-1.4 Synthetic original");
describe("exact owned transient Gmail original", () => {
  const ctx = withTestDb();
  afterEach(() => vi.restoreAllMocks());
  async function fixture() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    await getDb(ctx.db).insert(account).values({
      id: crypto.randomUUID(),
      accountId: mailboxId,
      providerId: "google",
      userId: ctx.actor.userId,
      updatedAt: new Date(),
    });
    const email = await insertWithShortcode(ctx.db, "email", {
      ledgerPartyId: party.id,
      provider: "gmail",
      mailboxId,
      messageId,
      checksum: "a".repeat(64),
      classification: "unrelated",
      classificationVersion: "synthetic-known",
      status: "completed",
      subject: "Known header",
      executionPolicy: "classification_only",
      contentClearedAt: new Date(),
    });
    await getDb(ctx.db).insert(emailClassificationObservation).values({
      emailId: email.id,
      checksum: email.checksum,
      classification: "unrelated",
      stage: "rule",
      reason: "Synthetic prior prediction",
      classificationVersion: email.classificationVersion,
    });
    const getMessage = vi.fn<GmailProvider["getMessage"]>(async (id) => ({
      id,
      payload: {
        mimeType: "text/plain",
        body: {
          data: Buffer.from("Current transient body").toString("base64url"),
        },
        parts: [
          {
            partId: "pdf",
            filename: "synthetic.pdf",
            mimeType: "application/pdf",
            body: { attachmentId: "synthetic-attachment", size: bytes.length },
          },
        ],
      },
    }));
    const getAttachment = vi.fn<GmailProvider["getAttachment"]>(async () => ({
      data: Buffer.from(bytes).toString("base64url"),
      size: bytes.length,
    }));
    const provider: GmailProvider = {
      getMessage,
      getAttachment,
      getProfile: async () => ({ historyId: "1" }),
      listHistory: async () => ({}),
      listMessages: async () => ({}),
    };
    const factory = vi
      .spyOn(providers, "gmailProviderForUser")
      .mockResolvedValue(provider);
    return { email, party, provider, getMessage, getAttachment, factory };
  }
  async function evidence() {
    return {
      emails: await getDb(ctx.db).select().from(emailTable),
      predictions: await getDb(ctx.db)
        .select()
        .from(emailClassificationObservation),
      candidates: await getDb(ctx.db).select().from(emailCandidateObservation),
      originals: await getDb(ctx.db).select().from(orderMail),
      attachments: await getDb(ctx.db).select().from(orderMailAttachment),
      claims: await getDb(ctx.db).select().from(importSourceClaim),
      usage: await getDb(ctx.db).select().from(aiUsage),
    };
  }
  const input = { mailboxId, messageId };
  it("returns an unrelated metadata Email's current original without durable body, attachment, model or admission writes", async () => {
    const { getMessage, factory } = await fixture();
    const before = await evidence();
    const output = await readEmailOriginalTransient(ctx.db, input, ctx.actor);
    expect(output).toMatchObject({
      ...input,
      sender: null,
      subject: null,
      receivedAt: null,
      boundToRun: false,
      content: { bodyText: "Current transient body" },
    });
    expect(output.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(output.checksum).not.toBe(before.emails[0]?.checksum);
    expect(getMessage).toHaveBeenCalledExactlyOnceWith(messageId);
    expect(factory).toHaveBeenCalledExactlyOnceWith(
      ctx.db,
      ctx.actor.userId,
      mailboxId,
    );
    expect(await evidence()).toEqual(before);
    expect(await getDb(ctx.db).select().from(emailRetrievalFailure)).toEqual(
      [],
    );
  });
  it("reads only a listed attachment as bounded transient bytes with its actual checksum", async () => {
    const { getAttachment } = await fixture();
    const before = await evidence();
    const output = await readEmailOriginalTransient(
      ctx.db,
      { ...input, attachmentId: "synthetic-attachment" },
      ctx.actor,
    );
    expect(getAttachment).toHaveBeenCalledExactlyOnceWith(
      messageId,
      "synthetic-attachment",
    );
    expect(output.originalAttachment).toMatchObject({
      checksum: await sha256Hex(bytes),
      dataBase64: Buffer.from(bytes).toString("base64"),
    });
    expect(await evidence()).toEqual(before);
  });
  it.each(["foreign-owner", "disconnected-mailbox"])(
    "refuses %s before creating or calling a provider",
    async (mode) => {
      const { email, factory, getMessage } = await fixture();
      if (mode === "foreign-owner") {
        const foreign = await insertWithShortcode(ctx.db, "ledgerParty", {
          name: "Synthetic foreign",
          kind: "member",
        });
        await getDb(ctx.db)
          .update(emailTable)
          .set({ ledgerPartyId: foreign.id })
          .where(eq(emailTable.id, email.id));
      } else
        await getDb(ctx.db)
          .update(account)
          .set({ accountId: "another-mailbox" })
          .where(eq(account.accountId, mailboxId));
      await expect(
        readEmailOriginalTransient(ctx.db, input, ctx.actor),
      ).rejects.toThrow(/member|connected|owner/);
      expect(factory).not.toHaveBeenCalled();
      expect(getMessage).not.toHaveBeenCalled();
    },
  );
  it("refuses a Run actor before refetching frozen admitted evidence", async () => {
    const { factory } = await fixture();
    await expect(
      readEmailOriginalTransient(ctx.db, input, {
        ...ctx.actor,
        runId: runEntityId.parse(crypto.randomUUID()),
      }),
    ).rejects.toThrow(/Run|member/);
    expect(factory).not.toHaveBeenCalled();
  });
  it("persists only raw 404 retrieval failure while preserving known headers, checksum and prediction history", async () => {
    const { email, getMessage } = await fixture();
    const before = await evidence();
    const raw =
      "404 Not Found\nSynthetic provider body with diagnostic details";
    getMessage.mockRejectedValue(
      new GmailApiError({ status: 404, message: raw }),
    );
    await expect(
      readEmailOriginalTransient(ctx.db, input, ctx.actor),
    ).rejects.toThrow(raw);
    expect(await evidence()).toEqual(before);
    expect(
      await getDb(ctx.db).select().from(emailRetrievalFailure),
    ).toMatchObject([
      { emailId: email.id, runId: null, httpStatus: 404, error: raw },
    ]);
  });
  it("refuses a changed message response identity", async () => {
    const { getMessage } = await fixture();
    getMessage.mockResolvedValue({ id: "foreign-message" });
    await expect(
      readEmailOriginalTransient(ctx.db, input, ctx.actor),
    ).rejects.toThrow(/identity|message/);
  });
  it("refuses an attachment absent from this exact current message before its bytes are fetched", async () => {
    const { getAttachment } = await fixture();
    await expect(
      readEmailOriginalTransient(
        ctx.db,
        { ...input, attachmentId: "foreign-attachment" },
        ctx.actor,
      ),
    ).rejects.toThrow(/attachment/);
    expect(getAttachment).not.toHaveBeenCalled();
  });
  it.each(["SPAM", "TRASH"])(
    "refuses current %s content without retaining or classifying it",
    async (label) => {
      const { getMessage } = await fixture();
      getMessage.mockResolvedValue({ id: messageId, labelIds: [label] });
      const before = await evidence();
      await expect(
        readEmailOriginalTransient(ctx.db, input, ctx.actor),
      ).rejects.toThrow(/Spam|Trash|excluded/);
      expect(await evidence()).toEqual(before);
    },
  );
  it.each(["declared", "actual"])(
    "refuses an oversized %s attachment without retaining its bytes",
    async (mode) => {
      const { getMessage, getAttachment } = await fixture();
      if (mode === "declared")
        getMessage.mockResolvedValue({
          id: messageId,
          payload: {
            parts: [
              {
                filename: "synthetic.pdf",
                mimeType: "application/pdf",
                body: {
                  attachmentId: "synthetic-attachment",
                  size: MAIL_ATTACHMENT_MAX_BYTES + 1,
                },
              },
            ],
          },
        });
      else
        getAttachment.mockResolvedValue({
          data: Buffer.alloc(MAIL_ATTACHMENT_MAX_BYTES + 1).toString(
            "base64url",
          ),
        });
      const before = await evidence();
      await expect(
        readEmailOriginalTransient(
          ctx.db,
          { ...input, attachmentId: "synthetic-attachment" },
          ctx.actor,
        ),
      ).rejects.toThrow(/limit|bound|large/);
      expect(await evidence()).toEqual(before);
      expect(getAttachment).toHaveBeenCalledTimes(mode === "declared" ? 0 : 1);
    },
  );
});
