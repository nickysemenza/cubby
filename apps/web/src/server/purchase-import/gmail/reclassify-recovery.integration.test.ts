import { mailReclassificationCheckpoint } from "@cubby/schemas/email-actions";
import { executionAuthorizationInput } from "@cubby/schemas/execution-authorization";
import { mailReclassifyRunInput } from "@cubby/schemas/run-fields";
import { and, eq, sql } from "drizzle-orm";
import { reclassifyForTest as reclassifyEmails } from "tooling/ai-work";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import { account } from "~/server/db/auth.schema";
import { aiEvaluationRequest, email, run } from "~/server/db/schema";
import { callMcpTool } from "~/server/mcp/mcp-test-utils";
import { McpOperationContext } from "~/server/mcp/operation-context";
import { createMcpServer } from "~/server/mcp/server";
import { getDb } from "~/server/repo/database-helpers";
import { loadMailReclassificationRead } from "~/server/repo/run-reclassification-read";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { requireActor } from "~/server/request-context";
import { issueExecutionAuthorization } from "~/server/runs/execution-authorization";
import { createTestRequestContext } from "~/server/testing/request-context";

import { originalChecksum } from "./checksum";
import { normalizeMessage } from "./normalize";
import * as providers from "./provider";
import type { MailRelevance } from "./relevance";
import type { MailTriage } from "./triage";
import type { GmailMessage, GmailProvider } from "./types";

// Failure modes: a lost response hides publication outcomes; partial receipts
// disappear until completion; deferred work is mistaken for classified work;
// legacy model observations invent receipts; foreign members read evidence;
// deleting an Email prevents recovery or exposes internal identity values.
describe("durable member reclassification recovery", () => {
  const ctx = withTestDb("mcp");
  afterEach(() => vi.restoreAllMocks());

  async function fixture() {
    const mailboxId = "synthetic-recovery-mailbox";
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic recovery member",
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
    await issueExecutionAuthorization(
      ctx.db,
      ctx.actor,
      executionAuthorizationInput.parse({
        kind: "execution_authorization",
        version: 1,
        owner: { userId: ctx.actor.userId, ledgerPartyId: party.id },
        scope: { kind: "backfill", mailboxId, discovery: "all_history" },
        meteredBudget: { period: "lifetime", limitMicroUSD: 1_000_000 },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    const originals = new Map<string, GmailMessage>();
    const getMessage = vi.fn<GmailProvider["getMessage"]>(async (id) => {
      const original = originals.get(id);
      if (!original) throw new Error("Missing synthetic original");
      return original;
    });
    vi.spyOn(providers, "gmailProviderForUser").mockResolvedValue({
      getMessage,
      getAttachment: async () => ({}),
      listMessages: async () => ({}),
      listHistory: async () => ({}),
      getProfile: async () => ({ historyId: "1" }),
    });
    // Unrelated originals need no retained body or attachment-storage stub.
    const triage = vi.fn<MailTriage>(async () => "unrelated");
    const relevance = vi.fn<MailRelevance>(async () => ({
      classification: "unrelated",
      reason: "Synthetic newsletter",
    }));
    async function seed(messageId: string) {
      const original: GmailMessage = {
        id: messageId,
        threadId: `${messageId}-thread`,
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "Synthetic News <news@example.test>" },
            { name: "Subject", value: "Synthetic newsletter" },
          ],
          body: {
            data: Buffer.from("Synthetic newsletter body").toString(
              "base64url",
            ),
          },
        },
      };
      originals.set(messageId, original);
      return insertWithShortcode(ctx.db, "email", {
        ledgerPartyId: party.id,
        provider: "gmail",
        mailboxId,
        messageId,
        checksum: await originalChecksum(normalizeMessage(mailboxId, original)),
        classification: "uncertain",
        classificationStage: "rule",
        classificationReason: "Synthetic previous rule",
        classificationVersion: "synthetic-history",
        status: "blocked",
        executionPolicy: "classification_only",
      });
    }
    const owner = { userId: ctx.actor.userId, ledgerPartyId: party.id };
    async function readStatus(runId: string) {
      const operationContext = new McpOperationContext(
        requireActor(
          createTestRequestContext(ctx.db, {
            auth: { userId: ctx.actor.userId },
          }),
        ),
      );
      return callMcpTool(
        createMcpServer(),
        "imports_read",
        { action: "run_status", runId },
        {},
        { operationContext },
      );
    }
    return { party, owner, seed, getMessage, triage, relevance, readStatus };
  }

  it("recovers initial partial and final receipts through owned MCP without repeating work", async () => {
    const f = await fixture();
    const first = await f.seed("synthetic-recovery-first");
    const second = await f.seed("synthetic-recovery-second");
    const original = f.getMessage.getMockImplementation()!;
    f.getMessage.mockImplementation(async (id) => {
      const [recorded] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(
          and(
            eq(run.purpose, "mail_reclassify"),
            eq(run.ledgerPartyId, f.owner.ledgerPartyId),
          ),
        );
      const recovered = await loadMailReclassificationRead(
        ctx.db,
        recorded!.shortcode,
        f.owner,
      );
      expect(recovered?.receipts?.complete).toBe(false);
      expect(recovered?.receipts?.results).toHaveLength(
        id === first.messageId ? 0 : 1,
      );
      const status = await f.readStatus(recorded!.shortcode);
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent).toMatchObject({
        status: "running",
        mailReclassification: {
          receipts: {
            complete: false,
            results:
              id === first.messageId
                ? []
                : [{ id: first.shortcode, outcome: "replaced" }],
          },
        },
      });
      return original(id);
    });
    const returned = await reclassifyEmails(
      ctx.db,
      { ids: [first.shortcode, second.shortcode] },
      ctx.actor,
      { triage: f.triage, relevance: f.relevance },
    );
    const recovered = await loadMailReclassificationRead(
      ctx.db,
      returned.runIds[0]!,
      f.owner,
    );
    expect(recovered?.receipts).toMatchObject({
      complete: true,
      results: returned.results,
    });
    expect(recovered?.selectedEmails).toEqual([
      { id: first.shortcode, checksum: first.checksum },
      { id: second.shortcode, checksum: second.checksum },
    ]);
    const status = await f.readStatus(returned.runIds[0]!);
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent).toMatchObject({
      status: "completed",
      mailReclassification: {
        receipts: { complete: true, results: returned.results },
      },
    });
    expect(f.getMessage).toHaveBeenCalledTimes(2);
  });

  it("retains exact publication receipts when the Run progress checkpoint fails", async () => {
    const f = await fixture();
    const first = await f.seed("synthetic-checkpoint-first");
    const second = await f.seed("synthetic-checkpoint-second");
    const db = getDb(ctx.db);
    await db.execute(
      sql.raw(`CREATE FUNCTION synthetic_receipt_failure() RETURNS trigger AS $$
      BEGIN
        IF NEW.progress->>'kind' = 'mail_reclassification'
           AND jsonb_array_length(NEW.progress->'results') > 1 THEN
          RAISE EXCEPTION 'Synthetic checkpoint failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`),
    );
    await db.execute(
      sql.raw(`CREATE TRIGGER synthetic_receipt_failure BEFORE UPDATE OF progress ON "Run"
      FOR EACH ROW EXECUTE FUNCTION synthetic_receipt_failure()`),
    );
    try {
      await expect(
        reclassifyEmails(
          ctx.db,
          { ids: [first.shortcode, second.shortcode] },
          ctx.actor,
          { triage: f.triage, relevance: f.relevance },
        ),
      ).rejects.toThrow(/Failed query/iu);
    } finally {
      await db.execute(
        sql.raw('DROP TRIGGER synthetic_receipt_failure ON "Run"'),
      );
      await db.execute(sql.raw("DROP FUNCTION synthetic_receipt_failure()"));
    }
    const [recorded] = await db
      .select()
      .from(run)
      .where(
        and(
          eq(run.purpose, "mail_reclassify"),
          eq(run.ledgerPartyId, f.owner.ledgerPartyId),
        ),
      );
    const recovered = await loadMailReclassificationRead(
      ctx.db,
      recorded!.shortcode,
      f.owner,
    );
    expect(recorded?.status).toBe("failed");
    expect(recorded?.dispatchError).toContain("Synthetic checkpoint failure");
    expect(recovered?.receipts).toMatchObject({
      complete: true,
      results: [{ id: first.shortcode }, { id: second.shortcode }],
    });
    expect(recovered?.receipts?.results).toHaveLength(2);
    expect(
      recovered?.classificationObservations.some(
        (item) => item.id === second.shortcode,
      ),
    ).toBe(true);
    const [published] = await db
      .select()
      .from(email)
      .where(eq(email.id, second.id));
    expect(published?.classification).toBe("unrelated");
    expect(f.getMessage).toHaveBeenCalledTimes(2);
  });

  it("recovers completed durable receipts after discarding the response and refuses foreign ownership", async () => {
    const f = await fixture();
    const first = await f.seed("synthetic-budget-first");
    const second = await f.seed("synthetic-budget-second");
    await reclassifyEmails(
      ctx.db,
      { ids: [first.shortcode, second.shortcode] },
      ctx.actor,
      { triage: f.triage, relevance: f.relevance },
    );
    const [recorded] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(
        and(
          eq(run.purpose, "mail_reclassify"),
          eq(run.ledgerPartyId, f.owner.ledgerPartyId),
        ),
      );
    const recovered = await loadMailReclassificationRead(
      ctx.db,
      recorded!.shortcode,
      f.owner,
    );
    expect(recovered?.receipts?.complete).toBe(true);
    expect(recovered?.receipts?.results.map((item) => item.outcome)).toEqual([
      "replaced",
      "replaced",
    ]);
    expect(recorded?.status).toBe("completed");
    const foreignParty = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic foreign owner",
      kind: "guest",
    });
    await expect(
      loadMailReclassificationRead(ctx.db, recorded!.shortcode, {
        userId: ctx.actor.userId,
        ledgerPartyId: foreignParty.id,
      }),
    ).rejects.toThrow(/belong/iu);
    await expect(
      loadMailReclassificationRead(ctx.db, recorded!.shortcode, null),
    ).rejects.toThrow(/belong/iu);
    expect(f.getMessage).toHaveBeenCalledTimes(2);
  });

  it("keeps legacy receipts unknown and reads deleted identities without writing or leaking UUIDs", async () => {
    const f = await fixture();
    const selected = await f.seed("synthetic-legacy-recovery");
    await reclassifyEmails(ctx.db, { ids: [selected.shortcode] }, ctx.actor, {
      triage: f.triage,
      relevance: f.relevance,
    });
    const [recorded] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(
        and(
          eq(run.purpose, "mail_reclassify"),
          eq(run.ledgerPartyId, f.owner.ledgerPartyId),
        ),
      );
    expect(
      mailReclassificationCheckpoint.parse(recorded!.progress).results,
    ).toHaveLength(1);
    await getDb(ctx.db)
      .delete(aiEvaluationRequest)
      .where(eq(aiEvaluationRequest.runId, recorded!.id));
    await getDb(ctx.db)
      .update(run)
      .set({ progress: null, notes: "Synthetic legacy note" })
      .where(eq(run.id, recorded!.id));
    await getDb(ctx.db)
      .update(email)
      .set({ deletedAt: new Date() })
      .where(eq(email.id, selected.id));
    const before = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, recorded!.id));
    const recovered = await loadMailReclassificationRead(
      ctx.db,
      recorded!.shortcode,
      f.owner,
    );
    expect(recovered?.receipts).toBeNull();
    expect(recovered?.notes).toBe("Synthetic legacy note");
    expect(recovered?.selectedEmails).toEqual([
      { id: selected.shortcode, checksum: selected.checksum },
    ]);
    expect(recovered?.classificationObservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: selected.shortcode,
          classification: "unrelated",
        }),
      ]),
    );
    const status = await f.readStatus(recorded!.shortcode);
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent).toMatchObject({
      mailReclassification: { receipts: null },
    });
    expect(JSON.stringify(status.structuredContent)).not.toContain(selected.id);
    expect(JSON.stringify(status.structuredContent)).not.toContain(
      recorded!.id,
    );
    expect(
      await getDb(ctx.db).select().from(run).where(eq(run.id, recorded!.id)),
    ).toEqual(before);
    // Legacy JSON may name an identity no longer present in the entity table.
    await getDb(ctx.db)
      .update(run)
      .set({
        input: mailReclassifyRunInput.parse({
          kind: "mail_reclassify",
          mode: "relevance",
          mailboxId: "synthetic-recovery-mailbox",
          emails: [
            { emailId: crypto.randomUUID(), checksum: selected.checksum },
          ],
        }),
      })
      .where(eq(run.id, recorded!.id));
    expect(
      (await loadMailReclassificationRead(ctx.db, recorded!.shortcode, f.owner))
        ?.selectedEmails,
    ).toEqual([{ id: null, checksum: selected.checksum }]);
    // Retirement can erase inputs; that is absent evidence, not a parse failure.
    await getDb(ctx.db)
      .update(run)
      .set({ input: null })
      .where(eq(run.id, recorded!.id));
    expect(
      await loadMailReclassificationRead(ctx.db, recorded!.shortcode, f.owner),
    ).toBeNull();
    await getDb(ctx.db)
      .update(run)
      .set({
        input: mailReclassifyRunInput.parse({
          kind: "mail_reclassify",
          mode: "preview",
          mailboxId: "synthetic-recovery-mailbox",
          emails: [{ emailId: selected.id, checksum: selected.checksum }],
        }),
      })
      .where(eq(run.id, recorded!.id));
    expect(
      await loadMailReclassificationRead(ctx.db, recorded!.shortcode, f.owner),
    ).toBeNull();
    expect(f.getMessage).toHaveBeenCalledTimes(1);
  });
});
