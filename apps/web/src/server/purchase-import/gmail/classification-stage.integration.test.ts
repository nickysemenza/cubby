import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { jevChoiceFitsContext } from "~/server/ai/jev";
import { email as emailTable, orderMail, run } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { syntheticMailImportRun } from "./execution.fixtures";
import { ingestGmailMessages } from "./ingest";
import { mailTriagePrompt } from "./triage";
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
      runId: relevance
        ? await syntheticMailImportRun(ctx.db, ctx.actor, {
            ledgerPartyId: party.id,
            mailboxId: "synthetic-mailbox",
          })
        : undefined,
      storage,
    });
    const [row] = await getDb(ctx.db)
      .select({
        classification: emailTable.classification,
        stage: emailTable.classificationStage,
        reason: emailTable.classificationReason,
      })
      .from(emailTable)
      .where(eq(emailTable.messageId, messageId));
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

  it("preserves authorized relevance fallback after uncertain bounded triage", async () => {
    const triage = vi.fn(async () => "uncertain" as const);
    const row = await classify(
      "rule-oversized",
      message("x".repeat(13_000)),
      triage,
      async () => ({ classification: "unrelated" }),
    );
    expect(triage).toHaveBeenCalledOnce();
    expect(row).toEqual({
      classification: "unrelated",
      stage: "model",
      reason: "The relevance model classified the message unrelated",
    });
  });

  it.each(["related", "unrelated"] as const)(
    "retains the full oversized original after a partial %s verdict without admitting import",
    async (verdict) => {
      const body =
        "Your order shipped. " +
        "x ".repeat(14_000) +
        "Order total $18.00 " +
        "x ".repeat(14_000) +
        " Receipt details at the end.";
      const triage = vi.fn(async (_content: string) => verdict);
      expect(
        await classify(`partial-${verdict}`, message(body), triage),
      ).toMatchObject({
        classification: verdict === "related" ? "related" : "uncertain",
        stage: verdict === "related" ? "jev" : "rule",
      });
      expect(triage).toHaveBeenCalledOnce();
      expect(
        jevChoiceFitsContext(mailTriagePrompt(triage.mock.calls[0]?.[0] ?? "")),
      ).toBe(true);
      const [retained] = await getDb(ctx.db)
        .select({ content: orderMail.content, runId: emailTable.runId })
        .from(emailTable)
        .innerJoin(orderMail, eq(orderMail.id, emailTable.orderMailId))
        .where(eq(emailTable.messageId, `partial-${verdict}`));
      expect(retained).toMatchObject({
        content: { bodyText: body },
        runId: null,
      });
      expect(
        await getDb(ctx.db)
          .select({ id: run.id })
          .from(run)
          .where(eq(run.purpose, "mail_import")),
      ).toEqual([]);
    },
  );
});
