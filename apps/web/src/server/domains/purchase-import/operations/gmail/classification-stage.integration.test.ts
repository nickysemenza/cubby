import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { decisionChoiceFitsContext } from "~/server/ai/decision-model";
import { mailTriagePrompt } from "~/server/ai/policy/prompts/mail";
import { getDb } from "~/server/db/helpers";
import { email as emailTable, orderMail, run } from "~/server/db/schema";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import type { GmailProvider } from "../../repo/gmail/types";
import { syntheticMailImportRun } from "../../service/gmail/execution.fixtures";
import { ingestGmailMessages } from "../../service/gmail/ingest";

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

  it("records the decision model's verdict", async () => {
    expect(
      await classify(
        "jev-unrelated",
        message("Weekly newsletter"),
        async () => "unrelated",
      ),
    ).toEqual({
      classification: "unrelated",
      stage: "decision",
      reason: "The decision model classified the message unrelated",
    });
  });

  it("lets the relevance model decide an attachment-bearing message the decision model called uncertain", async () => {
    expect(
      await classify(
        "rule-attachment",
        message("See attached", true),
        async () => "uncertain",
        async () => ({ classification: "related", reason: "Itemized receipt" }),
      ),
    ).toEqual({
      classification: "related",
      stage: "model",
      reason: "Itemized receipt",
    });
  });

  it("settles a definite unrelated attachment message without calling the relevance fallback", async () => {
    const relevance = vi.fn(async () => ({
      classification: "related" as const,
    }));
    expect(
      await classify(
        "definite-attachment",
        message("Weekly catalog attached", true),
        async () => "unrelated",
        relevance,
      ),
    ).toMatchObject({
      classification: "unrelated",
      stage: "decision",
    });
    expect(relevance).not.toHaveBeenCalled();
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

  it.each(["related", "unrelated", "uncertain"] as const)(
    "applies retention to a partial %s verdict without admitting import",
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
        classification: verdict,
        stage: "decision",
      });
      expect(triage).toHaveBeenCalledOnce();
      expect(
        decisionChoiceFitsContext(
          mailTriagePrompt(triage.mock.calls[0]?.[0] ?? ""),
        ),
      ).toBe(true);
      const [retained] = await getDb(ctx.db)
        .select({ content: orderMail.content, runId: emailTable.runId })
        .from(emailTable)
        .innerJoin(orderMail, eq(orderMail.id, emailTable.orderMailId))
        .where(eq(emailTable.messageId, `partial-${verdict}`));
      expect(retained?.content?.bodyText).toEqual(
        verdict === "unrelated" ? undefined : body,
      );
      expect(retained?.runId).toBe(verdict === "unrelated" ? undefined : null);
      expect(
        await getDb(ctx.db)
          .select({ id: run.id })
          .from(run)
          .where(eq(run.purpose, "mail_import")),
      ).toEqual([]);
    },
  );
});
