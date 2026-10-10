import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { mailboxMessage } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { ingestGmailMessages } from "./ingest";
import type { GmailProvider } from "./types";

const message =
  (body: string, attachments = false): GmailProvider["getMessage"] =>
  async (id) => ({
    id,
    internalDate: "1788220800000",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "orders@shop.example" },
        { name: "Subject", value: "Synthetic message" },
      ],
      body: { data: Buffer.from(body).toString("base64url") },
      parts: attachments
        ? [
            {
              partId: "pdf",
              filename: "receipt.pdf",
              mimeType: "application/pdf",
              body: { attachmentId: "attachment", size: 3 },
            },
          ]
        : [],
    },
  });

const provider = (getMessage: GmailProvider["getMessage"]): GmailProvider => ({
  getProfile: async () => ({ historyId: "100" }),
  listMessages: async () => ({}),
  listHistory: async () => ({}),
  getAttachment: async () => ({ data: "cGRm" }),
  getMessage,
});

const storage = {
  put: vi.fn(async () => undefined),
  get: async () => new Uint8Array(),
  delete: async () => undefined,
};

// "Why wasn't this imported?" must be answerable: every classification
// records which stage decided it and a short reason.
describe("Gmail classification stage and reason", () => {
  const ctx = withTestDb();

  async function classify(
    messageId: string,
    getMessage: GmailProvider["getMessage"],
    triage: (content: string) => Promise<"related" | "unrelated" | "uncertain">,
    relevance?: Parameters<typeof ingestGmailMessages>[2]["relevance"],
  ) {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: `Classification member ${messageId}`,
      kind: "member",
      userId: ctx.actor.userId,
    });
    await ingestGmailMessages(ctx.db, provider(getMessage), {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-mailbox",
      messageIds: [messageId],
      triage,
      relevance,
      storage,
    });
    const [row] = await getDb(ctx.db)
      .select({
        classification: mailboxMessage.classification,
        stage: mailboxMessage.classificationStage,
        reason: mailboxMessage.classificationReason,
      })
      .from(mailboxMessage)
      .where(eq(mailboxMessage.messageId, messageId));
    return row;
  }

  it("records Jev's verdict", async () => {
    expect(
      await classify(
        "jev-unrelated",
        message("Weekly newsletter"),
        async () => "unrelated",
      ),
    ).toEqual({
      classification: "unrelated",
      stage: "jev",
      reason: "Jev classified the message unrelated",
    });
  });

  it("lets the relevance model decide an attachment-bearing message Jev called unrelated", async () => {
    expect(
      await classify(
        "rule-attachment",
        message("See attached", true),
        async () => "unrelated",
        async () => ({ classification: "related", reason: "Itemized receipt" }),
      ),
    ).toEqual({
      classification: "related",
      stage: "model",
      reason: "Itemized receipt",
    });
  });

  it("sends an oversized message straight to the relevance model without asking Jev", async () => {
    const triage = vi.fn(async () => "related" as const);
    const row = await classify(
      "rule-oversized",
      message("x".repeat(13_000)),
      triage,
      async () => ({ classification: "unrelated" }),
    );
    expect(triage).not.toHaveBeenCalled();
    expect(row).toEqual({
      classification: "unrelated",
      stage: "model",
      reason: "The relevance model classified the message unrelated",
    });
  });
});
