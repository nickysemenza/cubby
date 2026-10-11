/**
 * Reclassify reruns every Relevance stage from the Gmail original. Failure
 * modes guarded here: skipping the relevance model under classification-only
 * policy; replacing Relevance in a way that drops retained content; overriding
 * a member's resolution; losing a disagreement with the member's review;
 * re-pointing the Email's processing Run (which would freeze later refreshes);
 * and admitting more than one capped batch.
 */
import { executionAuthorizationInput } from "@cubby/schemas/execution-authorization";
import { mailReclassifyRunInput } from "@cubby/schemas/run-fields";
import { desc, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import { account } from "~/server/db/auth.schema";
import {
  email as emailTable,
  emailClassificationLabel,
  emailClassificationObservation,
  orderMail,
  run,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { listEmailsRead } from "~/server/repo/email";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { issueExecutionAuthorization } from "~/server/runs/execution-authorization";

import { productionOrderMailAttachmentStorage } from "./attachment-storage";
import { originalChecksum } from "./checksum";
import { normalizeMessage } from "./normalize";
import * as providers from "./provider";
import { reclassifyEmails } from "./reclassify";
import type { MailRelevance } from "./relevance";
import type { MailTriage } from "./triage";
import type { GmailMessage, GmailProvider } from "./types";

const mailboxId = "synthetic-reclassify-mailbox";
const message = (id: string, body: string): GmailMessage => ({
  id,
  threadId: `${id}-thread`,
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "From", value: "Synthetic Shop <orders@shop.example>" },
      { name: "Subject", value: `Synthetic subject ${id}` },
    ],
    body: { data: Buffer.from(body).toString("base64url") },
  },
});

describe("member Reclassify", () => {
  const ctx = withTestDb();
  afterEach(() => vi.restoreAllMocks());

  async function fixture() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic reclassify member",
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
      const found = originals.get(id);
      if (!found) throw new Error(`No synthetic original ${id}`);
      return found;
    });
    vi.spyOn(providers, "gmailProviderForUser").mockResolvedValue({
      getMessage,
      getAttachment: async () => ({}),
      listMessages: async () => ({}),
      listHistory: async () => ({}),
      getProfile: async () => ({ historyId: "1" }),
    });
    vi.spyOn(productionOrderMailAttachmentStorage, "put").mockResolvedValue();
    vi.spyOn(
      productionOrderMailAttachmentStorage,
      "delete",
    ).mockResolvedValue();
    const triage = vi.fn<MailTriage>(async () => "uncertain");
    const relevance = vi.fn<MailRelevance>(async () => ({
      classification: "related",
      reason: "Synthetic relevance model found an order",
    }));
    async function seed(
      id: string,
      body: string,
      fields: Partial<typeof emailTable.$inferInsert>,
    ) {
      const original = message(id, body);
      originals.set(id, original);
      const checksum = await originalChecksum(
        normalizeMessage(mailboxId, original),
      );
      return insertWithShortcode(ctx.db, "email", {
        ledgerPartyId: party.id,
        provider: "gmail",
        mailboxId,
        messageId: id,
        checksum,
        classification: "uncertain",
        classificationStage: "rule",
        classificationReason: "Synthetic earlier rule",
        classificationVersion: "synthetic-history",
        status: "blocked",
        executionPolicy: "classification_only",
        ...fields,
      });
    }
    async function retain(emailId: string) {
      const [row] = await getDb(ctx.db)
        .insert(orderMail)
        .values({
          ledgerPartyId: party.id,
          rawChecksum: (
            await getDb(ctx.db)
              .select({ checksum: emailTable.checksum })
              .from(emailTable)
              .where(eq(emailTable.id, emailId))
          )[0]!.checksum,
          content: {
            snippet: "Synthetic retained snippet",
            bodyText: "Synthetic retained order body",
            bodyHtml: null,
          },
        })
        .returning();
      await getDb(ctx.db)
        .update(emailTable)
        .set({ orderMailId: row!.id })
        .where(eq(emailTable.id, emailId));
      return row!;
    }
    const history = (emailId: string) =>
      getDb(ctx.db)
        .select()
        .from(emailClassificationObservation)
        .where(eq(emailClassificationObservation.emailId, emailId))
        .orderBy(desc(emailClassificationObservation.createdAt));
    const current = async (emailId: string) =>
      (
        await getDb(ctx.db)
          .select()
          .from(emailTable)
          .where(eq(emailTable.id, emailId))
      )[0]!;
    return {
      party,
      seed,
      retain,
      history,
      current,
      getMessage,
      triage,
      relevance,
    };
  }

  it("refetches an unretained original, runs the relevance model under classification-only policy, and records one Run", async () => {
    const f = await fixture();
    const email = await f.seed(
      "synthetic-unretained",
      "Your synthetic order 1001 has been placed.",
      { contentClearedAt: new Date() },
    );
    const result = await reclassifyEmails(
      ctx.db,
      { ids: [email.shortcode] },
      ctx.actor,
      { triage: f.triage, relevance: f.relevance },
    );

    expect(f.getMessage).toHaveBeenCalledWith("synthetic-unretained");
    expect(f.relevance).toHaveBeenCalledTimes(1);
    expect(result.results).toEqual([
      expect.objectContaining({
        id: email.shortcode,
        outcome: "replaced",
        classification: "related",
        stage: "model",
        conflict: false,
      }),
    ]);
    const after = await f.current(email.id);
    expect(after).toMatchObject({
      classification: "related",
      classificationStage: "model",
      contentClearedAt: null,
      runId: null,
    });
    const [retained] = await getDb(ctx.db)
      .select()
      .from(orderMail)
      .where(eq(orderMail.id, after.orderMailId!));
    expect(retained?.content.bodyText).toContain("synthetic order 1001");

    expect(result.runIds).toHaveLength(1);
    const [recorded] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.shortcode, result.runIds[0]!));
    expect(recorded).toMatchObject({
      purpose: "background",
      status: "completed",
    });
    expect(mailReclassifyRunInput.parse(recorded!.input)).toMatchObject({
      mode: "relevance",
      mailboxId,
      emails: [{ emailId: email.id }],
    });
    const [latest] = await f.history(email.id);
    expect(latest).toMatchObject({
      runId: recorded!.id,
      classification: "related",
      stage: "model",
    });
  });

  it("records an unrelated rerun of retained content as history until the member accepts it", async () => {
    const f = await fixture();
    f.triage.mockResolvedValue("unrelated");
    const email = await f.seed(
      "synthetic-retained",
      "A synthetic newsletter with no order.",
      {
        classification: "related",
        classificationStage: "jev",
        classificationReason: "Synthetic earlier Jev",
        status: "pending",
      },
    );
    const original = await f.retain(email.id);

    const result = await reclassifyEmails(
      ctx.db,
      { ids: [email.shortcode] },
      ctx.actor,
      { triage: f.triage, relevance: f.relevance },
    );

    expect(result.results[0]).toMatchObject({
      outcome: "awaiting_acceptance",
      classification: "unrelated",
      stage: "jev",
    });
    expect(await f.current(email.id)).toMatchObject({
      classification: "related",
      classificationStage: "jev",
      contentClearedAt: null,
      orderMailId: original.id,
    });
    const [kept] = await getDb(ctx.db)
      .select()
      .from(orderMail)
      .where(eq(orderMail.id, original.id));
    expect(kept?.content.bodyText).toBe("Synthetic retained order body");
    expect((await f.history(email.id))[0]).toMatchObject({
      classification: "unrelated",
      stage: "jev",
    });
  });

  it("never overrides a member resolution and records the disagreement as a filterable conflict", async () => {
    const f = await fixture();
    f.triage.mockResolvedValue("unrelated");
    const email = await f.seed(
      "synthetic-resolved",
      "A synthetic message the member resolved as an order.",
      {
        classification: "related",
        classificationStage: "resolution",
        classificationReason: "Synthetic member resolution",
        status: "pending",
      },
    );
    await f.retain(email.id);

    const result = await reclassifyEmails(
      ctx.db,
      { ids: [email.shortcode] },
      ctx.actor,
      { triage: f.triage, relevance: f.relevance },
    );

    expect(result.results[0]).toMatchObject({
      outcome: "resolution_kept",
      classification: "unrelated",
      conflict: true,
    });
    expect(await f.current(email.id)).toMatchObject({
      classification: "related",
      classificationStage: "resolution",
    });
    expect((await f.history(email.id))[0]?.conflict).toEqual({
      kind: "member_review",
      memberClassification: "related",
    });
    const conflicts = await listEmailsRead(
      ctx.db,
      { reviewConflict: true },
      [],
      { pageIndex: 0, pageSize: 10 },
    );
    expect(conflicts.data.map((row) => row.id)).toEqual([email.shortcode]);
  });

  it("records a conflict with the member's reviewed label without changing that review", async () => {
    const f = await fixture();
    f.triage.mockResolvedValue("unrelated");
    const email = await f.seed(
      "synthetic-labelled",
      "A complete synthetic promotion body.",
      {
        classification: "unrelated",
        classificationStage: "jev",
        classificationReason: "Synthetic earlier Jev",
        status: "completed",
        contentClearedAt: new Date(),
      },
    );
    const [prediction] = await getDb(ctx.db)
      .insert(emailClassificationObservation)
      .values({
        emailId: email.id,
        checksum: email.checksum,
        classification: "unrelated",
        stage: "jev",
        reason: "Synthetic earlier Jev",
        classificationVersion: "synthetic-history",
      })
      .returning();
    await getDb(ctx.db).insert(emailClassificationLabel).values({
      predictionId: prediction!.id,
      classification: "related",
      reason: "Synthetic member review",
      actorUserId: ctx.actor.userId,
    });

    const result = await reclassifyEmails(
      ctx.db,
      { ids: [email.shortcode] },
      ctx.actor,
      { triage: f.triage, relevance: f.relevance },
    );

    expect(result.results[0]).toMatchObject({
      outcome: "confirmed",
      classification: "unrelated",
      conflict: true,
    });
    expect((await f.history(email.id))[0]?.conflict).toEqual({
      kind: "member_review",
      memberClassification: "related",
    });
    const reviewed = await listEmailsRead(
      ctx.db,
      { reviewConflict: true },
      [],
      { pageIndex: 0, pageSize: 10 },
    );
    expect(reviewed.data[0]).toMatchObject({
      id: email.shortcode,
      reviewedClassification: "related",
      reviewConflict: true,
    });
  });

  it("refuses more than 200 Emails before any Run or Gmail read", async () => {
    const f = await fixture();
    const email = await f.seed("synthetic-capped", "Synthetic body.", {});
    await expect(
      reclassifyEmails(
        ctx.db,
        { ids: Array.from({ length: 201 }, () => email.shortcode) },
        ctx.actor,
        { triage: f.triage, relevance: f.relevance },
      ),
    ).rejects.toThrow(/at most 200 Emails/u);
    expect(f.getMessage).not.toHaveBeenCalled();
    const runs = await getDb(ctx.db).select({ input: run.input }).from(run);
    expect(
      runs.filter((row) => mailReclassifyRunInput.safeParse(row.input).success),
    ).toEqual([]);
  });
});
