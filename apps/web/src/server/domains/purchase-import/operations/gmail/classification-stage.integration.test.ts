import { MAILBOX_RESEARCH_VERSION } from "@cubby/schemas/mailbox-research";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { decisionChoiceFitsContext } from "~/server/ai/decision-model";
import { insertFieldsFixture as insertWithShortcode } from "~/server/ai/fields/fields.fixtures";
import { mailTriagePrompt } from "~/server/ai/policy/prompts/mail";
import { getDb } from "~/server/db/helpers";
import { withKernelApply } from "~/server/db/kernel-apply-context";
import { email as emailTable, orderMail, run } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";

import type { GmailProvider } from "../../repo/gmail/types";
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
        ? await ensureRun(ctx.db, ctx.actor, {
            purpose: "mail_discovery",
            status: "running",
            trigger: "manual",
            input: {
              mailboxId: "synthetic-mailbox",
              scopedQueries: [],
              executionPolicy: "classification_only",
            },
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
      reason:
        "The decision model chose unrelated for the message from shop.example: no purchase cues",
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
        await classify(
          `partial-${verdict}`,
          message(body),
          triage,
          verdict === "uncertain"
            ? async () => ({ classification: "uncertain" })
            : undefined,
        ),
      ).toMatchObject({
        classification: verdict,
        stage: verdict === "uncertain" ? "model" : "decision",
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

  // An Email whose emailState scope is stale when a publication starts: its
  // first write's reconcile must reach the publication's later reads.
  describe("with a stale emailState scope", () => {
    const observed =
      (historyId: string): GmailProvider["getMessage"] =>
      async (id) => ({
        ...(await message("Order #SYN-7 total $18.00 receipt")(id)),
        historyId,
      });
    const party = (name: string) =>
      insertWithShortcode(ctx.db, "ledgerParty", {
        name,
        kind: "member",
        userId: ctx.actor.userId,
      });
    const read = async (messageId: string) => {
      const [row] = await getDb(ctx.db)
        .select({
          id: emailTable.id,
          status: emailTable.status,
          classification: emailTable.classification,
          classificationVersion: emailTable.classificationVersion,
          contentClearedAt: emailTable.contentClearedAt,
          content: orderMail.content,
        })
        .from(emailTable)
        .leftJoin(orderMail, eq(orderMail.id, emailTable.orderMailId))
        .where(eq(emailTable.messageId, messageId));
      if (!row) throw new Error("Synthetic Email missing");
      return row;
    };

    it("keeps settled mail settled when only its stored verdict version is stale", async () => {
      const owner = await party("Stale verdict member");
      const ingest = (historyId: string) =>
        ingestGmailMessages(ctx.db, provider(observed(historyId)), {
          ledgerPartyId: owner.id,
          mailboxId: "synthetic-mailbox",
          messageIds: ["stale-verdict"],
          triage: async () => "related",
          storage,
        });
      await ingest("1");
      const first = await read("stale-verdict");
      expect(first).toMatchObject({
        status: "pending",
        classification: "related",
      });
      // Settled, with a verdict stored by an older classifier; the applied
      // prediction for the same bytes is current and not yet projected.
      await withKernelApply(null, () =>
        getDb(ctx.db)
          .update(emailTable)
          .set({
            status: "completed",
            classificationVersion: "synthetic-older",
          })
          .where(eq(emailTable.id, first.id)),
      );
      const { emitWrites } = await import("~/server/kernel/api");
      await emitWrites(ctx.db, {
        table: emailTable,
        ids: [first.id],
        columns: ["classificationVersion"],
        discovers: [{ kind: "emailState", key: first.id }],
      });
      // A new history id makes the publication write metadata first.
      await ingest("2");
      expect(await read("stale-verdict")).toMatchObject({
        status: "completed",
        classification: "related",
        classificationVersion: MAILBOX_RESEARCH_VERSION,
      });
    });

    it("keeps a retained original an unprojected member resolution protects from reclassify", async () => {
      const owner = await party("Pending resolution member");
      const runId = await ensureRun(ctx.db, ctx.actor, {
        purpose: "mail_discovery",
        status: "running",
        trigger: "manual",
        input: {
          mailboxId: "synthetic-mailbox",
          scopedQueries: [],
          executionPolicy: "classification_only",
        },
      });
      await ingestGmailMessages(ctx.db, provider(observed("1")), {
        ledgerPartyId: owner.id,
        mailboxId: "synthetic-mailbox",
        messageIds: ["pending-resolution"],
        triage: async () => "uncertain",
        relevance: async () => ({ classification: "uncertain" }),
        runId,
        storage,
      });
      const stored = await read("pending-resolution");
      expect(stored.classification).toBe("uncertain");
      await getDb(ctx.db)
        .update(emailTable)
        .set({ status: "unsettled" })
        .where(eq(emailTable.id, stored.id));
      // The member's related assignment, recorded but not yet projected.
      const { decide } = await import("~/server/kernel/api");
      await decide(ctx.db, ctx.actor, [
        {
          channel: "assignment",
          kind: "set",
          subject: `email:${stored.id}`,
          field: "classification",
          value: "related",
          scopes: [{ kind: "emailState", key: stored.id }],
        },
      ]);
      const outcome = await ingestGmailMessages(
        ctx.db,
        provider(observed("2")),
        {
          ledgerPartyId: owner.id,
          mailboxId: "synthetic-mailbox",
          messageIds: ["pending-resolution"],
          triage: async () => "unrelated",
          reclassify: true,
          storage,
        },
      );
      expect(outcome.kept).toEqual([
        { messageId: "pending-resolution", reason: "resolution_kept" },
      ]);
      expect(outcome.unrelated).toEqual([]);
      const kept = await read("pending-resolution");
      expect(kept).toMatchObject({
        classification: "related",
        contentClearedAt: null,
      });
      expect(kept.content?.bodyText).toBe("Order #SYN-7 total $18.00 receipt");
    });
  });
});
