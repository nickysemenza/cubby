import type { RunId } from "@cubby/schemas/identifiers";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import type { GatewayFetchRequest } from "@cubby/shared/ai/gateway-request";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import {
  AI_BUDGET_LIMIT_USD,
  AiBudgetExhaustedError,
  AiFundingWaitError,
  DEFAULT_CREDIT_BUDGET_USD,
  aiBudgetWindow,
  readAiBudget,
} from "~/server/ai/budget";
import { readChatGptPlanAvailability } from "~/server/ai/funding";
import { setCfEnv } from "~/server/cf-env";
import { getDb } from "~/server/db/helpers";
import { aiUsage, run, runControlEvent } from "~/server/db/schema";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import type { WorkflowLauncher } from "~/server/workflows/runs/launcher";

import { ensureRun } from "../repo/ensure-run";
import { resumeFundingPausedRuns } from "./ai-work";
import { creditRunPreflight, paidRunPreflight } from "./execution-transport";

const chatRequest = (model = "gpt-6-sol"): GatewayFetchRequest => ({
  endpoint: model.startsWith("claude") ? "v1/messages" : "responses",
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
const connectedPlan = {
  planConnection: async () => ({
    connected: true,
    needsReauthorization: false,
  }),
};
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
              emails: [{ emailId: crypto.randomUUID(), checksum: "synthetic" }],
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
        transport: options.transport ?? "gateway",
        chargedCost:
          options.chargedCost !== undefined
            ? options.chargedCost
            : options.credit
              ? 0
              : usd,
        standardCost:
          options.standardCost !== undefined ? options.standardCost : usd,
        failure: options.failure ?? null,
        ...(options.credit && {
          costEvidence: {
            standard: null,
            charged: null,
            billingReason: "subscriber_credit",
          },
        }),
        createdAt: options.createdAt ?? new Date(),
      });
  }

  async function grant(
    runId: RunId,
    options: { paidOverBudgetUsd?: number; createdAt?: Date } = {},
  ) {
    const party = await getDb(ctx.db).query.ledgerParty.findFirst();
    if (!party) throw new Error("Synthetic member party is missing");
    await getDb(ctx.db)
      .insert(runControlEvent)
      .values({
        runId,
        action: "run_now_paid",
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

  it("counts Claude credit at standard cost and never as paid", async () => {
    const runId = await setup("mail_import");
    await spend(runId, 5, { createdAt: previousWindow() });
    await spend(runId, 0.25);
    // Mailbox relevance is frontier chat spend like any other feature.
    await spend(runId, 0.5, { feature: "mailbox-relevance" });
    await spend(runId, 2, { credit: true });
    // An unknown charged cost on a credit row must not fall back into paid.
    await spend(runId, 1, { credit: true, chargedCost: null });
    await spend(runId, 3, { transport: "chatgpt", chargedCost: 0 });
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
  });

  it("refuses background credit once its window budget is spent, but not interactive credit", async () => {
    const background = await setup("mail_import");
    const interactive = await setup("mail_import", "manual");
    const opus = chatRequest("claude-opus-5-5");
    expect(await creditRunPreflight(ctx.db, background)(opus)).toBeNull();
    await spend(background, DEFAULT_CREDIT_BUDGET_USD, { credit: true });
    expect(await creditRunPreflight(ctx.db, background)(opus)).toMatch(
      /^Claude credit budget reached: \$5 of \$5 standard cost/u,
    );
    expect(await creditRunPreflight(ctx.db, interactive)(opus)).toBeNull();
    expect(
      await creditRunPreflight(ctx.db, background)(decisionRequest()),
    ).toBeNull();
  });

  it("pauses background work for the next window instead of paying while the plan is quota-refused", async () => {
    const runId = await setup("mail_import");
    await spend(runId, DEFAULT_CREDIT_BUDGET_USD, { credit: true });
    await spend(runId, 0, {
      transport: "chatgpt",
      standardCost: null,
      chargedCost: null,
      failure:
        '429 {"error":{"type":"usage_limit_reached","resets_in_seconds":600}}',
    });
    expect(
      (await readChatGptPlanAvailability(ctx.db, connectedPlan)).state,
    ).toBe("paused");
    const refusal = await paidRunPreflight(
      ctx.db,
      runId,
      connectedPlan,
    )(chatRequest()).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(AiFundingWaitError);
    expect(await status(runId)).toMatchObject({
      status: "paused_auth",
      failureCode: "execution_limit",
      dispatchError: expect.stringMatching(
        /^Waiting for free AI capacity; background work never pays\. Claude credit budget used: \$5 of \$5.*usage_limit_reached/su,
      ),
    });
  });

  it("stays paused with a reason when no free capacity can return within six hours", async () => {
    const runId = await setup("mail_discovery");
    await spend(runId, 0, {
      credit: true,
      standardCost: null,
      chargedCost: null,
      failure:
        "400 Your credit balance is too low to access the Anthropic API.",
    });
    // The test runtime has no plan storage: the plan reads as disconnected.
    await expect(
      paidRunPreflight(ctx.db, runId)(chatRequest()),
    ).rejects.toBeInstanceOf(AiFundingWaitError);
    expect(await status(runId)).toMatchObject({
      status: "paused_auth",
      failureCode: "execution_limit",
      dispatchError: expect.stringMatching(
        /^No free AI capacity can return within six hours.*credit balance is too low.*ChatGPT plan unavailable \(disconnected\)/su,
      ),
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
    expect(refusal).not.toBeInstanceOf(AiFundingWaitError);
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
    expect(over).not.toBeInstanceOf(AiFundingWaitError);

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

  it("resumes paused imports and discovery in the next window", async () => {
    const runId = await setup("mail_import");
    await spend(runId, DEFAULT_CREDIT_BUDGET_USD, { credit: true });
    await expect(
      paidRunPreflight(ctx.db, runId)(chatRequest()),
    ).rejects.toBeInstanceOf(AiFundingWaitError);
    const discovery = await setup("mail_discovery");
    await getDb(ctx.db)
      .update(run)
      .set({ status: "paused_auth", failureCode: "execution_limit" })
      .where(eq(run.id, discovery));
    const launched: string[] = [];
    const launcher: WorkflowLauncher = {
      create: async (_purpose, id) => {
        launched.push(id);
      },
      status: async () => ({ state: "running", error: null }),
      terminate: async () => undefined,
    };
    const sent: string[] = [];
    setCfEnv(
      fromPartial<Env>({
        PURCHASE_AGENT_QUEUE: {
          send: async (event: PurchaseAgentEvent) => {
            sent.push(event.runId);
          },
        },
      }),
    );
    // Paused this window: still waiting.
    expect(await resumeFundingPausedRuns(ctx.db, { launcher })).toBe(0);
    await pausedBefore(runId);
    await pausedBefore(discovery);
    expect(await resumeFundingPausedRuns(ctx.db, { launcher })).toBe(2);
    expect(await status(runId)).toMatchObject({ status: "running" });
    expect((await status(runId))?.failureCode).not.toBe("execution_limit");
    expect(await status(discovery)).toMatchObject({
      status: "running",
      failureCode: null,
    });
    expect(launched).toHaveLength(1);
    expect(sent).toEqual([runId]);
  });

  // A resume interrupted before its queue send must not strand the Run.
  it("resends an interrupted budget resume with its existing generation", async () => {
    const runId = await setup("mail_import");
    const eventId = crypto.randomUUID();
    await getDb(ctx.db)
      .update(run)
      .set({
        failureCode: "budget_resume_pending",
        dispatchEventId: eventId,
        updatedAt: new Date(Date.now() - 60_000),
      })
      .where(eq(run.id, runId));
    // Recent: another recovery may still be sending it.
    expect(await resumeFundingPausedRuns(ctx.db)).toBe(0);
    await getDb(ctx.db)
      .update(run)
      .set({ updatedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(run.id, runId));
    expect(await resumeFundingPausedRuns(ctx.db)).toBe(1);
    const [resent] = await getDb(ctx.db)
      .select({
        dispatchEventId: run.dispatchEventId,
        dispatchAttempts: run.dispatchAttempts,
        failureCode: run.failureCode,
      })
      .from(run)
      .where(eq(run.id, runId));
    expect(resent).toMatchObject({
      dispatchEventId: eventId,
      dispatchAttempts: 1,
    });
    expect(resent?.failureCode).not.toBe("budget_resume_pending");
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
    const [sent] = await getDb(ctx.db)
      .select({ dispatchAttempts: run.dispatchAttempts })
      .from(run)
      .where(eq(run.id, runId));
    expect(sent?.dispatchAttempts).toBe(1);
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
