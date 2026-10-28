import { parseEntityId, type RunId } from "@cubby/schemas/identifiers";
import {
  gatewayFetchThrough,
  type GatewayFetchRequest,
} from "@cubby/shared/ai/gateway-request";
import { fundedCubbyPiProviders } from "@cubby/shared/ai/pi-providers";
import { createModels } from "@earendil-works/pi-ai";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import {
  AI_BUDGET_LIMIT_USD,
  AiBudgetExhaustedError,
  DEFAULT_CREDIT_BUDGET_USD,
  PLAN_BUDGET_LIMIT_USD,
  readAiBudget,
  withAiBudget,
  withFreeBudget,
} from "~/server/ai/budget";
import { aiBudgetWindow } from "~/server/ai/budget-window";
import { setCfEnv } from "~/server/cf-env";
import { getDb } from "~/server/db/helpers";
import { aiUsage, job, run, runControlEvent } from "~/server/db/schema";
import { claimJob } from "~/server/generic/jobs/repo/external-claim";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { productionJobHandlers } from "~/server/workflows/jobs";

import { ensureRun } from "../repo/ensure-run";
import { resumeFundingPausedRuns } from "./ai-work";
import { freeRunPreflight, paidRunPreflight } from "./execution-transport";

const chatRequest = (model = "gpt-6-sol"): GatewayFetchRequest => ({
  // pi-ai's Anthropic SDK sends the beta query; budget checks must see past it.
  endpoint: model.startsWith("claude") ? "v1/messages?beta=true" : "responses",
  headers: new Headers(),
  input: "https://gateway.invalid/openai/responses",
  init: undefined,
  signal: undefined,
  query: async () => ({ model }),
});
const decisionRequest = (): GatewayFetchRequest => ({
  endpoint: "run/typesafe/jev",
  headers: new Headers(),
  input: "https://gateway.invalid/workers-ai/typesafe/jev",
  init: undefined,
  signal: undefined,
  query: async () => ({ questions: {} }),
});
const previousWindow = () => new Date(aiBudgetWindow().start.getTime() - 1);

// Failure modes: Claude credit spend counted as paid (or not at all); a
// background Run paying when free capacity returns within six hours, or
// paying silently when none can; interactive work losing today's paid
// fallback; an override paying past the paid budget without a confirmed
// amount, or keeping that amount past its window; a paused Run never resuming.
describe("household AI funding at the paid transport boundary", () => {
  const ctx = withTestDb();
  afterEach(() => setCfEnv(undefined));

  async function setup(
    purpose: "mail_import" | "mail_reclassify" | "mail_discovery",
    trigger: "scheduled" | "manual" = "scheduled",
    parentRunId?: RunId,
  ) {
    if (!(await getDb(ctx.db).query.ledgerParty.findFirst()))
      await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Synthetic budget member",
        kind: "member",
        userId: ctx.actor.userId,
      });
    return ensureRun(ctx.db, ctx.actor, {
      purpose,
      trigger,
      status: "running",
      input:
        purpose === "mail_reclassify"
          ? {
              kind: "mail_reclassify",
              mode: "relevance",
              mailboxId: "synthetic-budget-mailbox",
              emails: [
                {
                  emailId: parseEntityId("email", crypto.randomUUID()),
                  checksum: "synthetic",
                },
              ],
            }
          : purpose === "mail_discovery"
            ? {
                emailAuditVersion: 1,
                mailboxId: `synthetic-budget-mailbox-${crypto.randomUUID()}`,
                scopedQueries: [],
                executionPolicy: "import",
              }
            : {
                kind: "mail_research",
                sources: [
                  {
                    orderMailId: crypto.randomUUID(),
                    checksum: "a".repeat(64),
                  },
                ],
              },
      ...(purpose === "mail_discovery" && {
        progress: {
          attempt: 0,
          phase: "listing",
          pagesDone: 0,
          saved: 0,
          deleted: 0,
          excluded: 0,
          unrelated: 0,
          events: 0,
          droppedEvents: 0,
        },
      }),
      ...(parentRunId && { parentRunId }),
    });
  }

  async function spend(
    runId: RunId,
    usd: number,
    options: {
      feature?: string;
      model?: string;
      createdAt?: Date;
      credit?: boolean;
      /** A ChatGPT plan call: charged $0, counted at standard cost. */
      plan?: boolean;
      transport?: "gateway" | "chatgpt";
      standardCost?: number | null;
      chargedCost?: number | null;
      failure?: string;
    } = {},
  ) {
    await getDb(ctx.db)
      .insert(aiUsage)
      .values({
        runId,
        feature: options.feature ?? "purchase_import_agent",
        provider: options.credit ? "anthropic" : "openai",
        model:
          options.model ?? (options.credit ? "claude-opus-5-5" : "gpt-6-sol"),
        operation: "agent.generation",
        durationMs: 1,
        transport: options.transport ?? (options.plan ? "chatgpt" : "gateway"),
        chargedCost:
          options.chargedCost !== undefined
            ? options.chargedCost
            : options.credit || options.plan
              ? 0
              : usd,
        standardCost:
          options.standardCost !== undefined ? options.standardCost : usd,
        failure: options.failure ?? null,
        ...((options.credit || options.plan) && {
          costEvidence: {
            standard: null,
            charged: null,
            billingReason: options.credit ? "subscriber_credit" : "plan",
          },
        }),
        createdAt: options.createdAt ?? new Date(),
      });
  }

  async function grant(
    runId: RunId,
    options: {
      paidOverBudgetUsd?: number;
      createdAt?: Date;
      action?: "run_now_paid" | "resume";
    } = {},
  ) {
    const party = await getDb(ctx.db).query.ledgerParty.findFirst();
    if (!party) throw new Error("Synthetic member party is missing");
    await getDb(ctx.db)
      .insert(runControlEvent)
      .values({
        runId,
        action: options.action ?? "run_now_paid",
        controllerUserId: ctx.actor.userId,
        controllerName: "Synthetic member",
        controllerEmail: "member@example.test",
        controllerLedgerPartyId: party.id,
        controllerLedgerPartyShortcode: party.shortcode,
        controllerLedgerPartyName: party.name,
        controllerLedgerPartyKind: "member",
        paidOverBudgetUsd: options.paidOverBudgetUsd ?? null,
        createdAt: options.createdAt ?? new Date(),
      });
  }

  const status = async (runId: RunId) =>
    (
      await getDb(ctx.db)
        .select({
          status: run.status,
          failureCode: run.failureCode,
          dispatchError: run.dispatchError,
        })
        .from(run)
        .where(eq(run.id, runId))
    )[0];
  const pausedBefore = (runId: RunId) =>
    getDb(ctx.db)
      .update(run)
      .set({ updatedAt: previousWindow() })
      .where(eq(run.id, runId));

  // Automatic feature refreshes have purpose background but the default
  // ephemeral trigger; interactive ephemeral Runs must retain their ladder.
  it("caps credit for ephemeral background work only and lets both pay within the paid budget", async () => {
    const automatic = await ensureRun(ctx.db, ctx.actor, {
      purpose: "background",
    });
    const interactive = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
    });
    await spend(automatic, DEFAULT_CREDIT_BUDGET_USD, { credit: true });
    const automaticCredit = withFreeBudget(
      ctx.db,
      { model: "claude-opus-5-5", runId: automatic },
      undefined,
    );
    const interactiveCredit = withFreeBudget(
      ctx.db,
      { model: "claude-opus-5-5", runId: interactive },
      undefined,
    );
    const automaticPaid = withAiBudget(
      ctx.db,
      { model: "gpt-6-sol", runId: automatic },
      undefined,
    );
    const interactivePaid = withAiBudget(
      ctx.db,
      { model: "gpt-6-sol", runId: interactive },
      undefined,
    );
    if (
      !automaticCredit ||
      !interactiveCredit ||
      !automaticPaid ||
      !interactivePaid
    )
      throw new Error("Synthetic frontier admissions missing");
    expect(await automaticCredit(chatRequest(), "subscriber_credit")).toContain(
      "Claude credit budget reached",
    );
    expect(
      await interactiveCredit(chatRequest(), "subscriber_credit"),
    ).toBeNull();
    await expect(automaticPaid(chatRequest())).resolves.toBeUndefined();
    await expect(interactivePaid(chatRequest())).resolves.toBeUndefined();
  });

  // Storage refuses a paid amount that is not a positive run_now_paid grant.
  it("stores an over-budget amount only on a positive paid grant", async () => {
    const runId = await setup("mail_import");
    await grant(runId);
    await grant(runId, { paidOverBudgetUsd: 2 });
    for (const options of [
      { paidOverBudgetUsd: 0 },
      { paidOverBudgetUsd: -1 },
      { paidOverBudgetUsd: 2, action: "resume" as const },
    ])
      await expect(grant(runId, options)).rejects.toMatchObject({
        cause: { constraint: "RunControlEvent_paid_over_budget_check" },
      });
    const stored = await getDb(ctx.db)
      .select({ paid: runControlEvent.paidOverBudgetUsd })
      .from(runControlEvent)
      .where(eq(runControlEvent.runId, runId));
    expect(stored.map(({ paid }) => paid).sort()).toEqual([2, null]);
  });

  // Non-agent background features use the generic funding wrapper rather
  // than the agent preflight; a member grant must work at both boundaries.
  it("holds generic background feature admission to the paid limit unless a grant confirms more", async () => {
    const runId = await setup("mail_discovery");
    const preflight = withAiBudget(
      ctx.db,
      { model: "gpt-6-sol", runId },
      undefined,
    );
    if (!preflight) throw new Error("Synthetic frontier call has no preflight");
    await expect(preflight(chatRequest())).resolves.toBeUndefined();
    await spend(runId, AI_BUDGET_LIMIT_USD);
    await expect(preflight(chatRequest())).rejects.toBeInstanceOf(
      AiBudgetExhaustedError,
    );
    await grant(runId, { paidOverBudgetUsd: 1 });
    await expect(preflight(chatRequest())).resolves.toBeUndefined();
  });

  it("counts Claude credit at standard cost and never as paid", async () => {
    const runId = await setup("mail_import");
    await spend(runId, 5, { createdAt: previousWindow() });
    await spend(runId, 0.25);
    // Mailbox relevance is frontier chat spend like any other feature.
    await spend(runId, 0.5, { feature: "mailbox-relevance" });
    await spend(runId, 2, { credit: true });
    // An unknown charged cost on a credit row must not fall back into paid.
    await spend(runId, 1, { credit: true, chargedCost: null });
    await spend(runId, 3, { plan: true });
    await spend(runId, 5, {
      feature: "field-suggestion",
      model: "typesafe/jev",
    });
    await spend(runId, 5, {
      feature: "entity-embedding",
      model: "text-embedding-3-small",
    });
    const budget = await readAiBudget(ctx.db);
    expect(budget.paid).toEqual({
      limitUsd: AI_BUDGET_LIMIT_USD,
      spentUsd: expect.closeTo(0.75),
    });
    expect(budget.credit).toEqual({
      limitUsd: DEFAULT_CREDIT_BUDGET_USD,
      spentUsd: expect.closeTo(3),
    });
    expect(budget.plan).toEqual({
      limitUsd: PLAN_BUDGET_LIMIT_USD,
      spentUsd: expect.closeTo(3),
    });
  });

  it("refuses background credit and plan once each window budget is spent, but not interactive work", async () => {
    const background = await setup("mail_import");
    const interactive = await setup("mail_import", "manual");
    const opus = chatRequest("claude-opus-5-5");
    const credit = "subscriber_credit" as const;
    const plan = "subscription" as const;
    expect(await freeRunPreflight(ctx.db, background)(opus, credit)).toBeNull();
    await spend(background, DEFAULT_CREDIT_BUDGET_USD, { credit: true });
    expect(await freeRunPreflight(ctx.db, background)(opus, credit)).toMatch(
      /^Claude credit budget reached: \$1\.5 of \$1\.5 standard cost/u,
    );
    // Each budget refuses only its own rung.
    expect(
      await freeRunPreflight(ctx.db, background)(chatRequest(), plan),
    ).toBeNull();
    await spend(background, PLAN_BUDGET_LIMIT_USD, { plan: true });
    expect(
      await freeRunPreflight(ctx.db, background)(chatRequest(), plan),
    ).toMatch(/^ChatGPT plan budget reached: \$2 of \$2 standard cost/u);
    expect(
      await freeRunPreflight(ctx.db, interactive)(opus, credit),
    ).toBeNull();
    expect(
      await freeRunPreflight(ctx.db, interactive)(chatRequest(), plan),
    ).toBeNull();
    expect(
      await freeRunPreflight(ctx.db, background)(decisionRequest(), credit),
    ).toBeNull();
  });

  // Regression (2026-10-19): pi-ai's Anthropic SDK posts
  // `v1/messages?beta=true`, which the credit preflight did not recognize as a
  // chat call, so background coordinator and relevance calls spent $9.98 of a
  // $5 window budget without one refusal. Drive the real SDK request.
  it("stops background Claude credit at the window budget on pi-ai's real Anthropic request", async () => {
    const runId = await setup("mail_import");
    await spend(runId, DEFAULT_CREDIT_BUDGET_USD, { credit: true });
    const sent: string[] = [];
    const models = createModels();
    for (const provider of fundedCubbyPiProviders(
      (route, _unbilled, funding) =>
        gatewayFetchThrough({
          provider: route,
          funding,
          beforeFreeRequest: freeRunPreflight(ctx.db, runId),
          chatGpt: async () => {
            sent.push("chatgpt");
            return new Response(
              `data: ${JSON.stringify({ type: "response.completed", response: { id: "synthetic-response", status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } })}\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            );
          },
          gateway: async (request) => {
            sent.push(`gateway:${funding}:${request.endpoint}`);
            return new Response("synthetic gateway failure", { status: 500 });
          },
        }),
      undefined,
      { paid: false },
    ))
      models.setProvider(provider);
    const model = models.getModel("anthropic", "claude-opus-5-5");
    if (!model) throw new Error("Missing Opus");
    const response = await models.completeSimple(
      model,
      { messages: [] },
      { maxTokens: 512 },
    );
    expect(sent).toEqual(["chatgpt"]);
    expect(response.model).toBe("gpt-6-sol");
  });

  it("pays for background work within the paid budget once both free budgets are spent, then pauses it", async () => {
    const runId = await setup("mail_import");
    await spend(runId, DEFAULT_CREDIT_BUDGET_USD, { credit: true });
    await spend(runId, PLAN_BUDGET_LIMIT_USD, { plan: true });
    await paidRunPreflight(ctx.db, runId)(chatRequest());
    await spend(runId, AI_BUDGET_LIMIT_USD);
    await expect(
      paidRunPreflight(ctx.db, runId)(chatRequest()),
    ).rejects.toBeInstanceOf(AiBudgetExhaustedError);
    expect(await status(runId)).toMatchObject({
      status: "paused_auth",
      failureCode: "execution_limit",
      dispatchError: expect.stringMatching(/^AI budget reached: \$1 of \$1/u),
    });
  });

  it("keeps paying within the paid budget for interactive work", async () => {
    const runId = await setup("mail_import", "manual");
    await paidRunPreflight(ctx.db, runId)(chatRequest());
    await spend(runId, AI_BUDGET_LIMIT_USD);
    const refusal = await paidRunPreflight(
      ctx.db,
      runId,
    )(chatRequest()).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(AiBudgetExhaustedError);
  });

  it("lets a member's override pay within the paid budget, past it only by a confirmed amount this window", async () => {
    const parent = await setup("mail_discovery");
    const child = await setup("mail_import", "scheduled", parent);
    await grant(parent);
    // The override covers the Mail import Runs its discovery starts.
    await paidRunPreflight(ctx.db, child)(chatRequest());
    await spend(child, AI_BUDGET_LIMIT_USD);
    const over = await paidRunPreflight(
      ctx.db,
      child,
    )(chatRequest()).catch((error: unknown) => error);
    expect(over).toBeInstanceOf(AiBudgetExhaustedError);

    const confirmed = await setup("mail_import");
    await grant(confirmed, { paidOverBudgetUsd: 1 });
    await paidRunPreflight(ctx.db, confirmed)(chatRequest());
    await spend(confirmed, 1);
    await expect(
      paidRunPreflight(ctx.db, confirmed)(chatRequest()),
    ).rejects.toBeInstanceOf(AiBudgetExhaustedError);

    // An amount confirmed in an earlier window no longer stretches this one.
    const stale = await setup("mail_import");
    await grant(stale, { paidOverBudgetUsd: 5, createdAt: previousWindow() });
    await expect(
      paidRunPreflight(ctx.db, stale)(chatRequest()),
    ).rejects.toBeInstanceOf(AiBudgetExhaustedError);
  });

  // Review finding: a retry successor inherited background status through
  // its predecessor but not the member's paid grant, so it waited again.
  it("carries a paid grant to a retry successor", async () => {
    const original = await setup("mail_import");
    await spend(original, AI_BUDGET_LIMIT_USD);
    await grant(original, { paidOverBudgetUsd: 1 });
    // A retry follows a stopped Run and carries its frozen sources.
    const [stopped] = await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", failureCode: "execution_limit" })
      .where(eq(run.id, original))
      .returning({ input: run.input });
    const retry = await setup("mail_import");
    expect(retry).not.toBe(original);
    await expect(
      paidRunPreflight(ctx.db, retry)(chatRequest()),
    ).rejects.toBeInstanceOf(AiBudgetExhaustedError);
    await getDb(ctx.db)
      .update(run)
      // The ungranted attempt paused it; resume it as the retry of `original`.
      .set({
        predecessorRunId: original,
        input: stopped?.input,
        status: "running",
        failureCode: null,
        dispatchError: null,
      })
      .where(eq(run.id, retry));
    await paidRunPreflight(ctx.db, retry)(chatRequest());
  });

  // Review finding: a Run-bound call without the agent preflight (gateway
  // forward, purchase audit) threw the stop but left its Run running, so the
  // Run failed instead of resuming in the next window.
  it("pauses a background Run when generic paid admission stops it", async () => {
    const runId = await setup("mail_import");
    await spend(runId, AI_BUDGET_LIMIT_USD);
    const admit = withAiBudget<GatewayFetchRequest>(
      ctx.db,
      { model: "gpt-6-sol", runId },
      undefined,
    );
    await expect(admit?.(chatRequest())).rejects.toBeInstanceOf(
      AiBudgetExhaustedError,
    );
    expect(await status(runId)).toMatchObject({
      status: "paused_auth",
      failureCode: "execution_limit",
    });
  });

  it("resumes paused imports and leaves deferred discovery to the same due Job", async () => {
    const runId = await setup("mail_import");
    await spend(runId, AI_BUDGET_LIMIT_USD);
    await expect(
      paidRunPreflight(ctx.db, runId)(chatRequest()),
    ).rejects.toBeInstanceOf(AiBudgetExhaustedError);
    const discovery = await setup("mail_discovery");
    await getDb(ctx.db)
      .update(run)
      .set({ status: "paused_auth", failureCode: "execution_limit" })
      .where(eq(run.id, discovery));
    const discoveryJob = await enqueueJob(ctx.db, {
      key: `run:${discovery}`,
      kind: "run.execute",
      runId: discovery,
      input: { runId: discovery, purpose: "mail_discovery" },
      availableAt: new Date(Date.now() + 3_600_000),
    });
    // Paused this window: still waiting.
    expect(await resumeFundingPausedRuns(ctx.db, {})).toBe(0);
    await pausedBefore(runId);
    await pausedBefore(discovery);
    await getDb(ctx.db)
      .update(job)
      .set({ availableAt: new Date(0) })
      .where(eq(job.id, discoveryJob.id));
    const [resume] = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.kind, "run.funding-resume"));
    // One resume per funding window, not per Run: its handler resumes all.
    expect(resume).toMatchObject({
      runId: null,
      key: expect.stringMatching(/^funding-resume:\d{4}-\d{2}-\d{2}T/),
      waitReason: "ai_funding_window",
      waitUntil: expect.any(Date),
    });
    if (!resume) throw new Error("Expected durable funding resume");
    // The window ends: the timer's own deadline has passed.
    await getDb(ctx.db)
      .update(job)
      .set({
        availableAt: new Date(0),
        input: { until: new Date(0).toISOString() },
      })
      .where(eq(job.id, resume.id));
    expect(await advanceJob(ctx.db, resume.id, productionJobHandlers)).toBe(
      "succeeded",
    );
    expect(await status(runId)).toMatchObject({ status: "running" });
    expect((await status(runId))?.failureCode).not.toBe("execution_limit");
    expect(await status(discovery)).toMatchObject({
      status: "paused_auth",
      failureCode: "execution_limit",
    });
    expect(await claimJob(ctx.db, discoveryJob.id)).toMatchObject({
      id: discoveryJob.id,
      generation: discoveryJob.generation,
    });
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(job)
          .where(eq(job.kind, "purchase.dispatch"))
      ).map((item) => item.runId),
    ).toEqual([runId]);
  });

  // Production finding: each paused Run armed its own resume per window,
  // although one handler run resumes every paused Run.
  it("arms one funding resume per window for every paused Run", async () => {
    const first = await setup("mail_import");
    const second = await setup("mail_import");
    await spend(first, AI_BUDGET_LIMIT_USD);
    for (const runId of [first, second])
      await expect(
        paidRunPreflight(ctx.db, runId)(chatRequest()),
      ).rejects.toBeInstanceOf(AiBudgetExhaustedError);
    expect(await status(second)).toMatchObject({ status: "paused_auth" });
    const timers = await getDb(ctx.db)
      .select({ key: job.key, runId: job.runId })
      .from(job)
      .where(eq(job.kind, "run.funding-resume"));
    expect(timers).toEqual([
      { key: expect.stringMatching(/^funding-resume:/), runId: null },
    ]);
  });

  // Review finding: a budget raise brought the funding timer forward and it
  // completed early, so a re-exhaustion in the same window reused the
  // completed key and nothing resumed the Run.
  it("keeps the funding timer's window end through a budget raise", async () => {
    const runId = await setup("mail_import");
    await spend(runId, AI_BUDGET_LIMIT_USD);
    await expect(
      paidRunPreflight(ctx.db, runId)(chatRequest()),
    ).rejects.toBeInstanceOf(AiBudgetExhaustedError);
    const timer = async () =>
      (
        await getDb(ctx.db)
          .select()
          .from(job)
          .where(eq(job.kind, "run.funding-resume"))
      )[0];
    const armed = await timer();
    if (!armed) throw new Error("Expected durable funding resume");
    await resumeFundingPausedRuns(ctx.db, { anyWindow: true });
    expect(await advanceJob(ctx.db, armed.id, productionJobHandlers)).toBe(
      "succeeded",
    );
    expect(await timer()).toMatchObject({
      state: "queued",
      availableAt: armed.waitUntil,
      waitReason: "ai_funding_window",
    });
    await expect(
      paidRunPreflight(ctx.db, runId)(chatRequest()),
    ).rejects.toBeInstanceOf(AiBudgetExhaustedError);
    expect(await status(runId)).toMatchObject({ status: "paused_auth" });
    expect(await timer()).toMatchObject({
      id: armed.id,
      state: "queued",
      availableAt: armed.waitUntil,
    });
  });

  it("lets only one of two concurrent recoveries send a resumed import", async () => {
    const runId = await setup("mail_import");
    await getDb(ctx.db)
      .update(run)
      .set({
        status: "paused_auth",
        failureCode: "execution_limit",
        updatedAt: previousWindow(),
      })
      .where(eq(run.id, runId));
    const counts = await Promise.all([
      resumeFundingPausedRuns(ctx.db),
      resumeFundingPausedRuns(ctx.db),
    ]);
    expect([...counts].sort()).toEqual([0, 1]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(job)
        .where(eq(job.kind, "purchase.dispatch")),
    ).toHaveLength(1);
  });

  it("pauses a reclassification Run for recovery in a later window", async () => {
    const runId = await setup("mail_reclassify");
    await spend(runId, AI_BUDGET_LIMIT_USD);
    await expect(
      paidRunPreflight(ctx.db, runId)(chatRequest()),
    ).rejects.toBeInstanceOf(AiBudgetExhaustedError);
    expect(await status(runId)).toMatchObject({
      status: "paused_auth",
      failureCode: "execution_limit",
    });
  });

  it("never budgets closed-set decision models", async () => {
    const runId = await setup("mail_import");
    await spend(runId, AI_BUDGET_LIMIT_USD * 3);
    await paidRunPreflight(ctx.db, runId)(decisionRequest());
    expect((await status(runId))?.status).toBe("running");
  });

  it("refuses paid work for a Run that is no longer executable", async () => {
    const runId = await setup("mail_import");
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", failureCode: "user_cancelled" })
      .where(eq(run.id, runId));
    await expect(
      paidRunPreflight(ctx.db, runId)(chatRequest()),
    ).rejects.toThrow(/no longer executable/u);
  });
});
