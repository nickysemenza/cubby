/**
 * Reclassify reruns every Relevance stage from the Gmail original. Failure
 * modes guarded here: skipping the relevance model under classification-only
 * policy; failing to settle unaccepted negatives; overriding
 * a member's resolution; losing a disagreement with the member's review;
 * re-pointing the Email's processing Run (which would freeze later refreshes);
 * admitting more than one capped batch; and a triage preview that writes
 * Relevance, history or retained content.
 */
import { executionAuthorizationInput } from "@cubby/schemas/execution-authorization";
import { mailReclassifyRunInput } from "@cubby/schemas/run-fields";
import * as models from "@cubby/shared/ai/models";
import { desc, eq } from "drizzle-orm";
import {
  driveAiWork,
  TEST_AI_WORK_LAUNCHER,
  reclassifyForTest as reclassifyEmails,
} from "tooling/ai-work";
import { seedEmailClassificationFeedback } from "tooling/shared-assessment-fixtures";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import { wrapAiGatewayError } from "~/server/ai/gateway-error";
import { account } from "~/server/db/auth.schema";
import {
  aiEvaluation,
  aiEvaluationRequest,
  email as emailTable,
  emailClassificationObservation,
  orderMail,
  run,
} from "~/server/db/schema";
import { requestedAiEvaluations } from "~/server/repo/ai-evaluation-requests";
import { getDb } from "~/server/repo/database-helpers";
import { listEmailsRead } from "~/server/repo/email";
import { loadMailReclassificationRead } from "~/server/repo/run-reclassification-read";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { recoverManualAiWork } from "~/server/runs/ai-work";
import {
  issueExecutionAuthorization,
  revokeExecutionAuthorization,
  reserveExecutionAuthorization,
  ExecutionBudgetError,
} from "~/server/runs/execution-authorization";
import { pauseExecutionRun } from "~/server/runs/execution-context";
import { recoverHistoricalReclassification } from "~/server/runs/reclassification-recovery";
import { controlWorkflowRun } from "~/server/workflow-runs/control";
import { productionWorkflowLauncher } from "~/server/workflow-runs/launcher";

import { HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION } from "../mail-source-identity";
import { productionOrderMailAttachmentStorage } from "./attachment-storage";
import { originalChecksum } from "./checksum";
import { normalizeMessage } from "./normalize";
import * as providers from "./provider";
import {
  previewMailTriage,
  reclassifyEmails as startReclassification,
} from "./reclassify";
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

  async function fixture(
    approvals: readonly ("backfill" | "continuous")[] = ["backfill"],
  ) {
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
    const refs = new Map<
      "backfill" | "continuous",
      Awaited<ReturnType<typeof issueExecutionAuthorization>>
    >();
    for (const kind of approvals)
      refs.set(
        kind,
        await issueExecutionAuthorization(
          ctx.db,
          ctx.actor,
          executionAuthorizationInput.parse({
            kind: "execution_authorization",
            version: 1,
            owner: { userId: ctx.actor.userId, ledgerPartyId: party.id },
            scope:
              kind === "backfill"
                ? { kind, mailboxId, discovery: "all_history" }
                : { kind, mailboxId, discovery: "new_mail" },
            meteredBudget: {
              period: kind === "backfill" ? "lifetime" : "utc_calendar_month",
              limitMicroUSD: 1_000_000,
            },
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        ),
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
      refs,
      seed,
      retain,
      history,
      current,
      getMessage,
      triage,
      relevance,
    };
  }

  it("queues the complete roster without starting Gmail or model work in the request", async () => {
    const f = await fixture();
    const first = await f.seed("synthetic-queued-first", "Synthetic body.", {});
    const second = await f.seed(
      "synthetic-queued-second",
      "Synthetic body.",
      {},
    );
    const launch = vi
      .spyOn(productionWorkflowLauncher, "create")
      .mockResolvedValue();
    const result = await startReclassification(
      ctx.db,
      { ids: [first.shortcode, second.shortcode] },
      ctx.actor,
      { triage: f.triage, relevance: f.relevance },
    );
    expect(result.runIds).toHaveLength(1);
    expect(f.getMessage).not.toHaveBeenCalled();
    expect(f.triage).not.toHaveBeenCalled();
    expect(f.relevance).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledTimes(1);
    const [recorded] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.shortcode, result.runIds[0]!));
    expect(recorded?.status).toBe("running");
    expect(mailReclassifyRunInput.parse(recorded?.input).emails).toHaveLength(
      2,
    );
  });

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
      purpose: "mail_reclassify",
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

  it("previews triage from the refetched original without writing the Email, its history or retained content", async () => {
    const f = await fixture();
    f.triage.mockResolvedValue("unrelated");
    const email = await f.seed(
      "synthetic-preview",
      "Club news: the spring meetup moves to the community hall.",
      { classification: "uncertain", status: "pending" },
    );
    const before = await f.current(email.id);
    const preview = await previewMailTriage(
      ctx.db,
      { mailboxId, messageId: "synthetic-preview" },
      ctx.actor,
      { triage: f.triage },
    );

    expect(f.getMessage).toHaveBeenCalledWith("synthetic-preview");
    expect(f.triage.mock.calls[0]?.[0]).toContain("spring meetup");
    expect(preview).toMatchObject({
      classification: "unrelated",
      stage: "decision",
      model: null,
      view: { complete: true, incompleteReasons: [] },
    });
    expect(preview.view?.bytes).toBeGreaterThan(0);
    expect(f.relevance).not.toHaveBeenCalled();
    expect(await f.current(email.id)).toEqual(before);
    expect(await f.history(email.id)).toEqual([]);
    expect(await getDb(ctx.db).select().from(orderMail)).toEqual([]);
    const runs = (
      await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.purpose, "background"))
    ).filter((row) => mailReclassifyRunInput.safeParse(row.input).success);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "completed" });
    expect(mailReclassifyRunInput.parse(runs[0]!.input)).toMatchObject({
      mode: "triage_preview",
      emails: [{ emailId: email.id }],
    });
  });

  it("settles an unaccepted retained newsletter without Luna or another member acceptance", async () => {
    const f = await fixture();
    f.triage.mockResolvedValue("unrelated");
    const email = await f.seed(
      "synthetic-retained",
      "A synthetic newsletter with no order.",
      {
        classification: "related",
        classificationStage: "decision",
        classificationReason: "Synthetic earlier the decision model",
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
      outcome: "replaced",
      classification: "unrelated",
      stage: "decision",
    });
    expect(await f.current(email.id)).toMatchObject({
      classification: "unrelated",
      classificationStage: "decision",
      status: "completed",
      orderMailId: original.id,
    });
    const [kept] = await getDb(ctx.db)
      .select()
      .from(orderMail)
      .where(eq(orderMail.id, original.id));
    expect(kept?.content.bodyText).toBeNull();
    expect((await f.current(email.id)).contentClearedAt).not.toBeNull();
    expect(f.relevance).not.toHaveBeenCalled();
    expect((await f.history(email.id))[0]).toMatchObject({
      classification: "unrelated",
      stage: "decision",
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

  it.each([false, true])(
    "protects a reviewed related label only for the same original (changed: %s)",
    async (changed) => {
      const f = await fixture();
      f.triage.mockResolvedValue("unrelated");
      const email = await f.seed(
        "synthetic-member-labelled-order",
        "Synthetic complete message",
        {
          classification: "related",
          classificationStage: "decision",
          status: "pending",
        },
      );
      const original = await f.retain(email.id);
      const [prediction] = await getDb(ctx.db)
        .insert(emailClassificationObservation)
        .values({
          emailId: email.id,
          checksum: email.checksum,
          classification: "related",
          stage: "decision",
          reason: "Synthetic prediction",
          classificationVersion: "synthetic-history",
        })
        .returning();
      await seedEmailClassificationFeedback(ctx.db, {
        predictionId: prediction!.id,
        classification: "related",
        reason: "Synthetic independent member review",
        actorUserId: ctx.actor.userId,
      });
      if (changed)
        f.getMessage.mockResolvedValue(
          message(
            "synthetic-member-labelled-order",
            "Changed synthetic newsletter without an order.",
          ),
        );
      const result = await reclassifyEmails(
        ctx.db,
        { ids: [email.shortcode] },
        ctx.actor,
        { triage: f.triage, relevance: f.relevance },
      );
      expect(result.results[0]).toMatchObject({
        outcome: changed ? "replaced" : "resolution_kept",
        conflict: !changed,
      });
      const after = await f.current(email.id);
      expect(after).toMatchObject({
        classification: changed ? "unrelated" : "related",
        orderMailId: original.id,
      });
      expect(after.checksum === email.checksum).toBe(!changed);
      expect(after.contentClearedAt !== null).toBe(changed);
    },
  );

  it("records a conflict with the member's reviewed label without changing that review", async () => {
    const f = await fixture();
    f.triage.mockResolvedValue("unrelated");
    const email = await f.seed(
      "synthetic-labelled",
      "A complete synthetic promotion body.",
      {
        classification: "unrelated",
        classificationStage: "decision",
        classificationReason: "Synthetic earlier the decision model",
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
        stage: "decision",
        reason: "Synthetic earlier the decision model",
        classificationVersion: "synthetic-history",
      })
      .returning();
    await seedEmailClassificationFeedback(ctx.db, {
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

  it("keeps retained evidence when the refetched original is unreadable rather than unrelated", async () => {
    const f = await fixture();
    const email = await f.seed(
      "synthetic-unreadable-rerun",
      "Synthetic retained receipt",
      {
        classification: "related",
        classificationStage: "decision",
        status: "pending",
      },
    );
    const original = await f.retain(email.id);
    f.getMessage.mockResolvedValue(message("synthetic-unreadable-rerun", ""));
    f.relevance.mockResolvedValue({ classification: "uncertain" });
    const result = await reclassifyEmails(
      ctx.db,
      { ids: [email.shortcode] },
      ctx.actor,
      { triage: f.triage, relevance: f.relevance },
    );
    expect(result.results[0]).toMatchObject({
      outcome: "awaiting_acceptance",
      classification: "uncertain",
    });
    expect(await f.current(email.id)).toMatchObject({
      classification: "related",
      orderMailId: original.id,
      contentClearedAt: null,
    });
    const [retained] = await getDb(ctx.db)
      .select()
      .from(orderMail)
      .where(eq(orderMail.id, original.id));
    expect(retained?.content.bodyText).toBe("Synthetic retained order body");
  });

  it("reports an unresolved historical source identity as frozen without reading Gmail", async () => {
    const f = await fixture();
    const email = await f.seed("synthetic-historical", "Synthetic body.", {
      classificationVersion: HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION,
    });
    const result = await reclassifyEmails(
      ctx.db,
      { ids: [email.shortcode] },
      ctx.actor,
      { triage: f.triage, relevance: f.relevance },
    );
    expect(result.results[0]).toMatchObject({
      outcome: "frozen",
      classification: null,
    });
    expect(f.getMessage).not.toHaveBeenCalled();
    expect(await f.current(email.id)).toMatchObject({
      classification: "uncertain",
      classificationStage: "rule",
    });
  });

  it("re-retains a cleared original when the rerun confirms its Relevance", async () => {
    const f = await fixture();
    const email = await f.seed(
      "synthetic-cleared",
      "Your synthetic order 2002 shipped.",
      {
        classification: "related",
        classificationStage: "model",
        status: "pending",
        contentClearedAt: new Date(),
      },
    );
    const result = await reclassifyEmails(
      ctx.db,
      { ids: [email.shortcode] },
      ctx.actor,
      { triage: f.triage, relevance: f.relevance },
    );
    expect(result.results[0]).toMatchObject({
      outcome: "confirmed",
      classification: "related",
    });
    const after = await f.current(email.id);
    expect(after.contentClearedAt).toBeNull();
    const [retained] = await getDb(ctx.db)
      .select()
      .from(orderMail)
      .where(eq(orderMail.id, after.orderMailId!));
    expect(retained?.content.bodyText).toContain("synthetic order 2002");
  });

  it("binds the continuous approval when the backfill approval is revoked", async () => {
    const f = await fixture(["backfill", "continuous"]);
    await revokeExecutionAuthorization(
      ctx.db,
      ctx.actor,
      f.refs.get("backfill")!,
    );
    const email = await f.seed("synthetic-continuous", "Synthetic body.", {});
    const result = await reclassifyEmails(
      ctx.db,
      { ids: [email.shortcode] },
      ctx.actor,
      { triage: f.triage, relevance: f.relevance },
    );
    expect(result.results[0]?.outcome).toBe("replaced");
    const [recorded] = await getDb(ctx.db)
      .select({ input: run.input })
      .from(run)
      .where(eq(run.shortcode, result.runIds[0]!));
    expect(
      mailReclassifyRunInput.parse(recorded!.input).executionAuthorization,
    ).toEqual(f.refs.get("continuous"));
  });

  it("refuses before any Run or Gmail read when the mailbox has no usable approval", async () => {
    const f = await fixture([]);
    const email = await f.seed("synthetic-unapproved", "Synthetic body.", {});
    await expect(
      reclassifyEmails(ctx.db, { ids: [email.shortcode] }, ctx.actor, {
        triage: f.triage,
        relevance: f.relevance,
      }),
    ).rejects.toThrow(/execution approval/iu);
    expect(f.getMessage).not.toHaveBeenCalled();
  });

  it("durably finishes every requested Email without a request time-budget deferral", async () => {
    const f = await fixture();
    const first = await f.seed("synthetic-first", "Synthetic order 3003.", {});
    const second = await f.seed(
      "synthetic-second",
      "Synthetic order 3004.",
      {},
    );
    const result = await reclassifyEmails(
      ctx.db,
      { ids: [first.shortcode, second.shortcode] },
      ctx.actor,
      { triage: f.triage, relevance: f.relevance },
    );
    expect(result.results.map((item) => item.outcome)).toEqual([
      "replaced",
      "replaced",
    ]);
    expect(f.getMessage).toHaveBeenCalledTimes(2);
    const [recorded] = await getDb(ctx.db)
      .select({ status: run.status })
      .from(run)
      .where(eq(run.shortcode, result.runIds[0]!));
    expect(recorded?.status).toBe("completed");
  });

  // Shared demand must survive one cancellation, without giving the cancelled request another Run's receipt.
  it("shares pending inference and preserves independent cancellation and receipts", async () => {
    vi.spyOn(models, "selectDecisionModel").mockReturnValue(
      models.DECISION_MODEL,
    );
    const f = await fixture();
    const selected = await f.seed("synthetic-shared", "Synthetic order", {});
    const submit = () =>
      startReclassification(ctx.db, { ids: [selected.shortcode] }, ctx.actor, {
        launcher: TEST_AI_WORK_LAUNCHER,
      });
    const first = await submit();
    const second = await submit();
    const owners = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.purpose, "mail_reclassify"));
    expect(await getDb(ctx.db).select().from(aiEvaluation)).toHaveLength(1);
    await controlWorkflowRun(
      ctx.db,
      ctx.actor,
      { runPublicId: first.runIds[0]!, action: "cancel" },
      "mail_reclassify",
      TEST_AI_WORK_LAUNCHER,
    );
    const survivor = owners.find(
      (item) => item.shortcode === second.runIds[0],
    )!;
    await driveAiWork(ctx.db, survivor.id, {
      reclassification: { triage: f.triage, relevance: f.relevance },
    });
    expect(f.getMessage).toHaveBeenCalledTimes(1);
    expect(f.relevance).toHaveBeenCalledTimes(1);
    const cancelled = await loadMailReclassificationRead(
      ctx.db,
      first.runIds[0]!,
      { userId: ctx.actor.userId, ledgerPartyId: f.party.id },
    );
    expect(cancelled?.receipts?.results).toMatchObject([
      { outcome: "cancelled" },
    ]);
    expect(
      (await requestedAiEvaluations(ctx.db, survivor.id))[0]?.receipt,
    ).toMatchObject({ result: { outcome: "replaced" } });
    const later = await submit();
    expect(later.runIds[0]).not.toBe(second.runIds[0]);
    expect(await getDb(ctx.db).select().from(aiEvaluation)).toHaveLength(2);
  });

  // Cancellation during a paid call cannot revoke another request's publication fence.
  it("finishes shared execution when its driver is cancelled during inference", async () => {
    vi.spyOn(models, "selectDecisionModel").mockReturnValue(
      models.DECISION_MODEL,
    );
    const f = await fixture();
    const selected = await f.seed(
      "synthetic-inflight-shared",
      "Synthetic order",
      {},
    );
    const first = await startReclassification(
      ctx.db,
      { ids: [selected.shortcode] },
      ctx.actor,
      { launcher: TEST_AI_WORK_LAUNCHER },
    );
    const second = await startReclassification(
      ctx.db,
      { ids: [selected.shortcode] },
      ctx.actor,
      { launcher: TEST_AI_WORK_LAUNCHER },
    );
    const [driver] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.shortcode, first.runIds[0]!));
    const relevance: MailRelevance = async () => {
      await controlWorkflowRun(
        ctx.db,
        ctx.actor,
        { runPublicId: first.runIds[0]!, action: "cancel" },
        "mail_reclassify",
        TEST_AI_WORK_LAUNCHER,
      );
      return { classification: "related", reason: "Synthetic shared order" };
    };
    await driveAiWork(ctx.db, driver!.id, {
      reclassification: { triage: f.triage, relevance },
    });
    const [survivor] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.shortcode, second.runIds[0]!));
    await driveAiWork(ctx.db, survivor!.id);
    expect(
      (await requestedAiEvaluations(ctx.db, survivor!.id))[0]?.receipt,
    ).toMatchObject({ result: { outcome: "replaced" } });
    expect((await f.current(selected.id)).classification).toBe("related");
    expect(f.getMessage).toHaveBeenCalledTimes(1);
  });

  // A new Workflow attempt must retry an old in-flight token, never mark its target terminal.
  it("finishes an Email whose inference crossed a pause and resume fence", async () => {
    const f = await fixture();
    const selected = await f.seed(
      "synthetic-resume-fence",
      "Synthetic order",
      {},
    );
    const submitted = await startReclassification(
      ctx.db,
      { ids: [selected.shortcode] },
      ctx.actor,
      { launcher: TEST_AI_WORK_LAUNCHER },
    );
    const [owner] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.shortcode, submitted.runIds[0]!));
    const relevance: MailRelevance = async () => {
      await controlWorkflowRun(
        ctx.db,
        ctx.actor,
        { runPublicId: owner!.shortcode, action: "pause" },
        "mail_reclassify",
        TEST_AI_WORK_LAUNCHER,
      );
      await controlWorkflowRun(
        ctx.db,
        ctx.actor,
        { runPublicId: owner!.shortcode, action: "resume" },
        "mail_reclassify",
        TEST_AI_WORK_LAUNCHER,
      );
      return { classification: "related", reason: "Synthetic order" };
    };
    await driveAiWork(ctx.db, owner!.id, {
      reclassification: { triage: f.triage, relevance },
    });
    expect((await requestedAiEvaluations(ctx.db, owner!.id))[0]?.state).toBe(
      "retry_wait",
    );
    await driveAiWork(ctx.db, owner!.id, {
      reclassification: { triage: f.triage, relevance: f.relevance },
    });
    expect(
      (await requestedAiEvaluations(ctx.db, owner!.id))[0]?.receipt,
    ).toMatchObject({ result: { outcome: "replaced" } });
    expect((await f.current(selected.id)).classification).toBe("related");
  });

  // Infrastructure errors outside a target cannot create an unlimited paid-independent restart loop.
  it("bounds automatic Workflow recovery and permits an explicit member retry", async () => {
    const f = await fixture();
    const selected = await f.seed(
      "synthetic-recovery-limit",
      "Synthetic order",
      {},
    );
    const submitted = await startReclassification(
      ctx.db,
      { ids: [selected.shortcode] },
      ctx.actor,
      { launcher: TEST_AI_WORK_LAUNCHER },
    );
    const [owner] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.shortcode, submitted.runIds[0]!));
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", failureCode: "ai_work_workflow_failed" })
      .where(eq(run.id, owner!.id));
    const create = vi.fn(async () => {
      throw new Error("Synthetic deterministic infrastructure failure");
    });
    const launcher = { ...TEST_AI_WORK_LAUNCHER, create };
    for (let retry = 0; retry < 3; retry++)
      await expect(
        recoverManualAiWork(ctx.db, launcher, [owner!.id]),
      ).rejects.toThrow("Synthetic deterministic infrastructure failure");
    await recoverManualAiWork(ctx.db, launcher, [owner!.id]);
    expect(create).toHaveBeenCalledTimes(3);
    expect(
      (await getDb(ctx.db).select().from(run).where(eq(run.id, owner!.id)))[0]
        ?.status,
    ).toBe("failed");
    expect(f.getMessage).not.toHaveBeenCalled();
    await controlWorkflowRun(
      ctx.db,
      ctx.actor,
      { runPublicId: owner!.shortcode, action: "retry" },
      "mail_reclassify",
      TEST_AI_WORK_LAUNCHER,
    );
    await driveAiWork(ctx.db, owner!.id, {
      reclassification: { triage: f.triage, relevance: f.relevance },
    });
    expect(
      (await getDb(ctx.db).select().from(run).where(eq(run.id, owner!.id)))[0]
        ?.progress,
    ).toMatchObject({ automaticRecoveryFailures: 0 });
    expect((await f.current(selected.id)).classification).toBe("related");
  });

  // A paused request must retain future demand even if the other requester cancels its continuation.
  it("retains a paused request across evidence continuation and another request cancellation", async () => {
    vi.spyOn(models, "selectDecisionModel").mockReturnValue(
      models.DECISION_MODEL,
    );
    const f = await fixture();
    const selected = await f.seed(
      "synthetic-paused-evidence",
      "Synthetic order",
      {},
    );
    const submit = () =>
      startReclassification(ctx.db, { ids: [selected.shortcode] }, ctx.actor, {
        launcher: TEST_AI_WORK_LAUNCHER,
      });
    const first = await submit();
    const second = await submit();
    const [paused] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.shortcode, first.runIds[0]!));
    const [active] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.shortcode, second.runIds[0]!));
    await controlWorkflowRun(
      ctx.db,
      ctx.actor,
      { runPublicId: paused!.shortcode, action: "pause" },
      "mail_reclassify",
      TEST_AI_WORK_LAUNCHER,
    );
    let changes = 0;
    const relevance: MailRelevance = async () => {
      await getDb(ctx.db)
        .update(emailTable)
        .set({ checksum: `synthetic-changing-evidence-${++changes}` })
        .where(eq(emailTable.id, selected.id));
      return { classification: "related", reason: "Synthetic changing order" };
    };
    await driveAiWork(ctx.db, active!.id, {
      reclassification: { triage: f.triage, relevance },
    });
    const [child] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.parentRunId, active!.id));
    expect(child).toBeDefined();
    await controlWorkflowRun(
      ctx.db,
      ctx.actor,
      { runPublicId: child!.shortcode, action: "cancel" },
      "mail_reclassify",
      TEST_AI_WORK_LAUNCHER,
    );
    await controlWorkflowRun(
      ctx.db,
      ctx.actor,
      { runPublicId: paused!.shortcode, action: "resume" },
      "mail_reclassify",
      TEST_AI_WORK_LAUNCHER,
    );
    await driveAiWork(ctx.db, paused!.id, {
      reclassification: { triage: f.triage, relevance: f.relevance },
    });
    expect((await f.current(selected.id)).classification).toBe("related");
    expect(
      (await getDb(ctx.db).select().from(run).where(eq(run.id, paused!.id)))[0]
        ?.status,
    ).toBe("completed");
  });

  // Expiring authority after queueing cannot strand work when another current approval exists.
  it("rebinds queued work after revocation and retains the approval audit", async () => {
    const f = await fixture(["backfill", "continuous"]);
    const selected = await f.seed("synthetic-rebind", "Synthetic order", {});
    const submitted = await startReclassification(
      ctx.db,
      { ids: [selected.shortcode] },
      ctx.actor,
      { launcher: TEST_AI_WORK_LAUNCHER },
    );
    await revokeExecutionAuthorization(
      ctx.db,
      ctx.actor,
      f.refs.get("backfill")!,
    );
    const [oldBackfill] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, f.refs.get("backfill")!.runId));
    await issueExecutionAuthorization(
      ctx.db,
      ctx.actor,
      executionAuthorizationInput.parse(oldBackfill!.input),
    );
    const [oldContinuous] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, f.refs.get("continuous")!.runId));
    const newest = await issueExecutionAuthorization(
      ctx.db,
      ctx.actor,
      executionAuthorizationInput.parse(oldContinuous!.input),
    );
    const [owner] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.shortcode, submitted.runIds[0]!));
    await driveAiWork(ctx.db, owner!.id, {
      reclassification: { triage: f.triage, relevance: f.relevance },
    });
    const [item] = await requestedAiEvaluations(ctx.db, owner!.id);
    expect(item?.state).toBe("completed");
    expect(item?.snapshot).toMatchObject({
      executionAuthorization: newest,
      authorizationHistory: [f.refs.get("backfill")],
    });
  });

  it("retains legacy failed receipts when member retry has no durable roster", async () => {
    const f = await fixture();
    const selected = await f.seed(
      "synthetic-legacy-failed",
      "Synthetic order",
      {},
    );
    const submitted = await startReclassification(
      ctx.db,
      { ids: [selected.shortcode] },
      ctx.actor,
      { launcher: TEST_AI_WORK_LAUNCHER },
    );
    const [owner] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.shortcode, submitted.runIds[0]!));
    await getDb(ctx.db)
      .delete(aiEvaluationRequest)
      .where(eq(aiEvaluationRequest.runId, owner!.id));
    await getDb(ctx.db)
      .delete(aiEvaluation)
      .where(eq(aiEvaluation.runId, owner!.id));
    const progress = {
      kind: "mail_reclassification" as const,
      version: 1 as const,
      complete: true,
      results: [
        {
          id: selected.shortcode,
          outcome: "deferred" as const,
          classification: null,
          stage: null,
          conflict: false,
          error: "Synthetic old timeout",
        },
      ],
    };
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", progress })
      .where(eq(run.id, owner!.id));
    await expect(
      controlWorkflowRun(
        ctx.db,
        ctx.actor,
        { runPublicId: owner!.shortcode, action: "retry" },
        "mail_reclassify",
        TEST_AI_WORK_LAUNCHER,
      ),
    ).rejects.toThrow("historical recovery");
    expect(
      (await getDb(ctx.db).select().from(run).where(eq(run.id, owner!.id)))[0],
    ).toMatchObject({ status: "failed", progress });
  });

  it("reconciles an ended running Workflow during the full nightly recovery scan", async () => {
    const f = await fixture();
    const selected = await f.seed(
      "synthetic-ended-workflow",
      "Synthetic order",
      {},
    );
    const submitted = await startReclassification(
      ctx.db,
      { ids: [selected.shortcode] },
      ctx.actor,
      { launcher: TEST_AI_WORK_LAUNCHER },
    );
    const [owner] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.shortcode, submitted.runIds[0]!));
    const create = vi.fn(async () => {});
    await recoverManualAiWork(ctx.db, {
      ...TEST_AI_WORK_LAUNCHER,
      create,
      status: async () => ({
        state: "errored",
        error: "Synthetic platform termination",
      }),
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(
      (await getDb(ctx.db).select().from(run).where(eq(run.id, owner!.id)))[0],
    ).toMatchObject({
      status: "running",
      progress: { attempt: 2, automaticRecoveryFailures: 1 },
    });
    await driveAiWork(ctx.db, owner!.id, {
      reclassification: { triage: f.triage, relevance: f.relevance },
    });
    expect((await f.current(selected.id)).classification).toBe("related");
  });

  // Retry predecessors remain history; only unresolved current demand may execute or block completion.
  it("retries only unresolved replacements and reconciles a lost final checkpoint", async () => {
    const f = await fixture();
    const first = await f.seed(
      "synthetic-retry-first",
      "Synthetic settled A",
      {},
    );
    const second = await f.seed(
      "synthetic-retry-second",
      "Synthetic unresolved B",
      {},
    );
    const submitted = await startReclassification(
      ctx.db,
      { ids: [first.shortcode, second.shortcode] },
      ctx.actor,
      { launcher: TEST_AI_WORK_LAUNCHER },
    );
    const [owner] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.shortcode, submitted.runIds[0]!));
    for (const item of await requestedAiEvaluations(ctx.db, owner!.id))
      await getDb(ctx.db)
        .update(aiEvaluation)
        .set({
          state: "failed",
          attempts: 3,
          error: "Synthetic prior transient failures",
        })
        .where(eq(aiEvaluation.id, item.id));
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed" })
      .where(eq(run.id, owner!.id));
    const retry = () =>
      controlWorkflowRun(
        ctx.db,
        ctx.actor,
        { runPublicId: owner!.shortcode, action: "retry" },
        "mail_reclassify",
        TEST_AI_WORK_LAUNCHER,
      );
    await retry();
    await driveAiWork(ctx.db, owner!.id, {
      reclassification: {
        triage: f.triage,
        relevance: async (request) => {
          if (JSON.stringify(request).includes("Synthetic unresolved B"))
            throw new Error("Synthetic transient provider failure");
          return {
            classification: "related",
            reason: "Synthetic first target success",
          };
        },
      },
    });
    await retry();
    await driveAiWork(ctx.db, owner!.id, {
      reclassification: { triage: f.triage, relevance: f.relevance },
    });
    expect(
      f.getMessage.mock.calls.filter(([id]) => id === first.messageId),
    ).toHaveLength(1);
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", failureCode: "ai_work_workflow_failed" })
      .where(eq(run.id, owner!.id));
    await recoverManualAiWork(ctx.db, TEST_AI_WORK_LAUNCHER, [owner!.id]);
    expect(
      (await getDb(ctx.db).select().from(run).where(eq(run.id, owner!.id)))[0]
        ?.status,
    ).toBe("completed");
    await getDb(ctx.db)
      .update(run)
      .set({ status: "running", failureCode: null })
      .where(eq(run.id, owner!.id));
    await recoverManualAiWork(
      ctx.db,
      {
        ...TEST_AI_WORK_LAUNCHER,
        status: async () => ({
          state: "errored",
          error: "Synthetic ended before checkpoint",
        }),
      },
      [owner!.id],
    );
    expect(
      (await getDb(ctx.db).select().from(run).where(eq(run.id, owner!.id)))[0]
        ?.status,
    ).toBe("completed");
    expect(
      f.getMessage.mock.calls.filter(([id]) => id === first.messageId),
    ).toHaveLength(1);
  });

  it("waits for replacement metered authority without consuming target retries", async () => {
    const f = await fixture();
    const selected = await f.seed(
      "synthetic-budget-wait",
      "Synthetic order",
      {},
    );
    const submitted = await startReclassification(
      ctx.db,
      { ids: [selected.shortcode] },
      ctx.actor,
      { launcher: TEST_AI_WORK_LAUNCHER },
    );
    const [owner] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.shortcode, submitted.runIds[0]!));
    const bound = f.refs.get("backfill")!;
    await reserveExecutionAuthorization(ctx.db, {
      ref: bound,
      owner: { userId: ctx.actor.userId, ledgerPartyId: owner!.ledgerPartyId! },
      requestedScope: { mailboxId, discovery: "all_history" },
      physicalAttemptId: crypto.randomUUID(),
      reservationMicroUSD: 1_000_000,
    });
    await driveAiWork(ctx.db, owner!.id, {
      reclassification: {
        triage: f.triage,
        relevance: async () => {
          await pauseExecutionRun(
            ctx.db,
            owner!.id,
            "Paid research allowance refused: budget_exhausted.",
          );
          throw wrapAiGatewayError(
            new Error("Synthetic provider wrapper", {
              cause: new ExecutionBudgetError(100),
            }),
            {
              model: "gpt-6-luna",
              provider: "openai",
              route: "openai",
              feature: "mailbox-relevance",
              operation: "mailbox-relevance",
            },
          );
        },
      },
    });
    expect(
      (await getDb(ctx.db).select().from(run).where(eq(run.id, owner!.id)))[0]
        ?.status,
    ).toBe("paused_auth");
    expect((await requestedAiEvaluations(ctx.db, owner!.id))[0]).toMatchObject({
      state: "retry_wait",
      attempts: 0,
    });
    await recoverManualAiWork(ctx.db, TEST_AI_WORK_LAUNCHER, [owner!.id]);
    expect(
      (await getDb(ctx.db).select().from(run).where(eq(run.id, owner!.id)))[0]
        ?.status,
    ).toBe("paused_auth");
    const [approval] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, bound.runId));
    const replacement = await issueExecutionAuthorization(
      ctx.db,
      ctx.actor,
      executionAuthorizationInput.parse(approval!.input),
    );
    await recoverManualAiWork(ctx.db, TEST_AI_WORK_LAUNCHER, [owner!.id]);
    await driveAiWork(ctx.db, owner!.id, {
      reclassification: { triage: f.triage, relevance: f.relevance },
    });
    expect((await requestedAiEvaluations(ctx.db, owner!.id))[0]).toMatchObject({
      state: "completed",
      snapshot: {
        executionAuthorization: replacement,
        authorizationHistory: [bound],
      },
    });
  });

  // Missing old receipts permit bounded replay only after reconciliation; recovery cannot rewrite old history.
  it.each(["completed", "needs_review"])(
    "reconciles missing historical outcomes from %s into one linked continuation",
    async (status) => {
      const f = await fixture();
      const selected = await f.seed(
        "synthetic-historical-missing",
        "Synthetic order",
        {},
      );
      const submitted = await startReclassification(
        ctx.db,
        { ids: [selected.shortcode] },
        ctx.actor,
        { launcher: TEST_AI_WORK_LAUNCHER },
      );
      const [owner] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.shortcode, submitted.runIds[0]!));
      await getDb(ctx.db)
        .delete(aiEvaluationRequest)
        .where(eq(aiEvaluationRequest.runId, owner!.id));
      await getDb(ctx.db)
        .delete(aiEvaluation)
        .where(eq(aiEvaluation.runId, owner!.id));
      await getDb(ctx.db)
        .update(run)
        .set({
          status,
          purpose: status === "needs_review" ? "background" : "mail_reclassify",
          failureCode: status === "needs_review" ? "execution_limit" : null,
          progress: null,
        })
        .where(eq(run.id, owner!.id));
      const [historical] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, owner!.id));
      await recoverHistoricalReclassification(ctx.db);
      await recoverHistoricalReclassification(ctx.db);
      const children = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.parentRunId, owner!.id));
      expect(children).toHaveLength(1);
      await driveAiWork(ctx.db, children[0]!.id, {
        reclassification: { triage: f.triage, relevance: f.relevance },
      });
      expect((await f.current(selected.id)).classification).toBe("related");
      expect(
        (
          await getDb(ctx.db).select().from(run).where(eq(run.id, owner!.id))
        )[0],
      ).toEqual(historical);
      expect(f.getMessage).toHaveBeenCalledTimes(1);
    },
  );

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
