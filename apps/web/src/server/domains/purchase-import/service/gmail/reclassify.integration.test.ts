import { type EmailId } from "@cubby/schemas/identifiers";
/**
 * Reclassify reruns every Relevance stage from the Gmail original. Failure
 * modes guarded here: skipping the relevance model under classification-only
 * policy; failing to settle unaccepted negatives; overriding
 * a member's resolution; losing a disagreement with the member's review;
 * re-pointing the Email's processing Run (which would freeze later refreshes);
 * admitting more than one capped batch; and a triage preview that writes
 * Relevance, history or retained content.
 */
import { mailReclassifyRunInput } from "@cubby/schemas/run-fields";
import * as models from "@cubby/shared/ai/models";
import { desc, eq } from "drizzle-orm";
import {
  driveAiWork,
  reclassifyForTest as reclassifyEmails,
} from "tooling/ai-work";
import { seedEmailClassificationFeedback } from "tooling/shared-assessment-fixtures";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AiBudgetExhaustedError, readAiBudget } from "~/server/ai/budget";
import { wrapAiGatewayError } from "~/server/ai/gateway-error";
import {
  cancelAiEvaluationRequests,
  requestedAiEvaluations,
} from "~/server/ai/repo/ai-evaluation-requests";
import { account } from "~/server/db/auth.schema";
import { getDb } from "~/server/db/helpers";
import { job } from "~/server/db/retained-tables";
import {
  aiEvaluation,
  aiEvaluationRequest,
  aiUsage,
  email as emailTable,
  emailClassificationObservation,
  orderMail,
  run,
} from "~/server/db/schema";
import { emailScaffold } from "~/server/domains/email/repo/email";
import { pauseExecutionRun } from "~/server/domains/run/repo/execution-context";
import { loadMailReclassificationRead } from "~/server/domains/run/repo/run-reclassification-read";
import { aiEvaluationItem } from "~/server/domains/run/service/ai-evaluation-drain.fixtures";
import { resumeFundingPausedRuns } from "~/server/domains/run/service/ai-work";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { controlWorkflowRun } from "~/server/workflows/runs/control";
import { reconcileWorkflowRuns } from "~/server/workflows/runs/lifecycle";

import { productionOrderMailAttachmentStorage } from "../../repo/gmail/attachment-storage";
import { originalChecksum } from "../../repo/gmail/checksum";
import { normalizeMessage } from "../../repo/gmail/normalize";
import * as providers from "../../repo/gmail/provider";
import type { GmailMessage, GmailProvider } from "../../repo/gmail/types";
import { HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION } from "../../repo/mail-source-identity";
import {
  previewMailTriage,
  reclassifyEmails as startReclassification,
} from "./reclassify";
import type { MailRelevance } from "./relevance";
import type { MailTriage } from "./triage";

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
    async function retain(emailId: EmailId) {
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
    const history = (emailId: EmailId) =>
      getDb(ctx.db)
        .select()
        .from(emailClassificationObservation)
        .where(eq(emailClassificationObservation.emailId, emailId))
        .orderBy(desc(emailClassificationObservation.createdAt));
    const current = async (emailId: EmailId) =>
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

  it("queues the complete roster without starting Gmail or model work in the request", async () => {
    const f = await fixture();
    const first = await f.seed("synthetic-queued-first", "Synthetic body.", {});
    const second = await f.seed(
      "synthetic-queued-second",
      "Synthetic body.",
      {},
    );
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
    const [recorded] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.shortcode, result.runIds[0]!));
    expect(recorded?.status).toBe("running");
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(job)
          .where(eq(job.key, `run:${recorded!.id}`))
      )[0],
    ).toMatchObject({
      state: "queued",
      kind: "run.execute",
      input: { runId: recorded!.id, purpose: "mail_reclassify" },
    });
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
    const conflicts = await emailScaffold.read(ctx.db, {
      filters: { reviewConflict: true },
      sorts: [],
      pagination: { pageIndex: 0, pageSize: 10 },
    });
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
    const reviewed = await emailScaffold.read(ctx.db, {
      filters: { reviewConflict: true },
      sorts: [],
      pagination: { pageIndex: 0, pageSize: 10 },
    });
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

  it("cancels a requested batch while retaining other live demand", async () => {
    vi.spyOn(models, "selectDecisionModel").mockReturnValue(
      models.DECISION_MODEL,
    );
    const f = await fixture();
    const emails = [];
    for (let index = 0; index < 6; index++)
      emails.push(
        await f.seed(`synthetic-cancel-batch-${index}`, "Synthetic order", {}),
      );
    const first = await startReclassification(
      ctx.db,
      { ids: emails.map((item) => item.shortcode) },
      ctx.actor,
      {},
    );
    const second = await startReclassification(
      ctx.db,
      { ids: emails.map((item) => item.shortcode) },
      ctx.actor,
      {},
    );
    const [owner] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.shortcode, first.runIds[0]!));
    await cancelAiEvaluationRequests(ctx.db, owner!.id);
    const items = await getDb(ctx.db).select().from(aiEvaluation);
    expect(items.filter((item) => item.state === "cancelled")).toHaveLength(0);
    expect(items.filter((item) => item.state === "queued")).toHaveLength(6);
    const [survivor] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.shortcode, second.runIds[0]!));
    expect((await requestedAiEvaluations(ctx.db, survivor!.id))[0]?.state).toBe(
      "queued",
    );
  });

  // Shared demand must survive one cancellation, without giving the cancelled request another Run's receipt.
  it("shares pending inference and preserves independent cancellation and receipts", async () => {
    vi.spyOn(models, "selectDecisionModel").mockReturnValue(
      models.DECISION_MODEL,
    );
    const f = await fixture();
    const selected = await f.seed("synthetic-shared", "Synthetic order", {});
    const submit = () =>
      startReclassification(
        ctx.db,
        { ids: [selected.shortcode] },
        ctx.actor,
        {},
      );
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

  // Cancelling a Run that already ended is a member-state refusal, not a 500.
  it("refuses to cancel an ended Run as a CONFLICT with the raw status", async () => {
    const f = await fixture();
    const selected = await f.seed("synthetic-ended", "Synthetic order", {});
    const { runIds } = await startReclassification(
      ctx.db,
      { ids: [selected.shortcode] },
      ctx.actor,
      {},
    );
    const cancel = () =>
      controlWorkflowRun(
        ctx.db,
        ctx.actor,
        { runPublicId: runIds[0]!, action: "cancel" },
        "mail_reclassify",
      );
    await cancel();
    await expect(cancel()).rejects.toMatchObject({
      code: "CONFLICT",
      reason: "RUN_CONTROL_REFUSED",
      message: "Only active work can be cancelled (failed)",
    });
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
      {},
    );
    const second = await startReclassification(
      ctx.db,
      { ids: [selected.shortcode] },
      ctx.actor,
      {},
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

  // Pausing its requester does not repeat paid work already owned by a shared target Job.
  it("finishes an Email across requester pause and resume without repeating inference", async () => {
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
      {},
    );
    const [owner] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.shortcode, submitted.runIds[0]!));
    const relevance = vi.fn<MailRelevance>(async () => {
      await controlWorkflowRun(
        ctx.db,
        ctx.actor,
        { runPublicId: owner!.shortcode, action: "pause" },
        "mail_reclassify",
      );
      await controlWorkflowRun(
        ctx.db,
        ctx.actor,
        { runPublicId: owner!.shortcode, action: "resume" },
        "mail_reclassify",
      );
      return { classification: "related", reason: "Synthetic order" };
    });
    await driveAiWork(ctx.db, owner!.id, {
      reclassification: { triage: f.triage, relevance },
    });
    expect((await requestedAiEvaluations(ctx.db, owner!.id))[0]?.state).toBe(
      "completed",
    );
    await driveAiWork(ctx.db, owner!.id, {
      reclassification: { triage: f.triage, relevance: f.relevance },
    });
    expect(
      (await requestedAiEvaluations(ctx.db, owner!.id))[0]?.receipt,
    ).toMatchObject({ result: { outcome: "replaced" } });
    expect((await f.current(selected.id)).classification).toBe("related");
    expect(relevance).toHaveBeenCalledTimes(1);
    expect(f.relevance).not.toHaveBeenCalled();
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
      {},
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
      ),
    ).rejects.toThrow("historical recovery");
    expect(
      (await getDb(ctx.db).select().from(run).where(eq(run.id, owner!.id)))[0],
    ).toMatchObject({ status: "failed", progress });
  });

  it("retries only unresolved replacements without fetching the successful Email again", async () => {
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
      {},
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
    expect(
      (await getDb(ctx.db).select().from(run).where(eq(run.id, owner!.id)))[0]
        ?.status,
    ).toBe("completed");
  });

  it("waits for the next budget window without consuming target retries", async () => {
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
      {},
    );
    const [owner] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.shortcode, submitted.runIds[0]!));
    const [spent] = await getDb(ctx.db)
      .insert(aiUsage)
      .values({
        runId: owner!.id,
        feature: "purchase_import_agent",
        provider: "openai",
        model: "gpt-6-luna",
        operation: "agent.generation",
        durationMs: 1,
        chargedCost: 1,
      })
      .returning();
    const exhausted = await readAiBudget(ctx.db);
    await driveAiWork(ctx.db, owner!.id, {
      reclassification: {
        triage: f.triage,
        relevance: async () => {
          await pauseExecutionRun(ctx.db, owner!.id, "Synthetic budget stop.");
          throw wrapAiGatewayError(
            new Error("Synthetic provider wrapper", {
              cause: new AiBudgetExhaustedError(exhausted),
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
    const [waiting] = await requestedAiEvaluations(ctx.db, owner!.id);
    expect(waiting).toMatchObject({ state: "queued" });
    // The funding wait defers the drain without spending the item's attempts.
    expect(await aiEvaluationItem(ctx.db, waiting!.id)).toMatchObject({
      attempts: 0,
    });
    await reconcileWorkflowRuns(ctx.db);
    expect(
      (await getDb(ctx.db).select().from(run).where(eq(run.id, owner!.id)))[0]
        ?.status,
    ).toBe("paused_auth");
    // The spend ages out of the window, as at the next window boundary.
    await getDb(ctx.db)
      .update(aiUsage)
      .set({ createdAt: new Date(Date.parse(exhausted.windowStart) - 1) })
      .where(eq(aiUsage.id, spent!.id));
    await resumeFundingPausedRuns(ctx.db, { anyWindow: true });
    await reconcileWorkflowRuns(ctx.db);
    await driveAiWork(ctx.db, owner!.id, {
      reclassification: { triage: f.triage, relevance: f.relevance },
    });
    expect((await requestedAiEvaluations(ctx.db, owner!.id))[0]).toMatchObject({
      state: "completed",
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
