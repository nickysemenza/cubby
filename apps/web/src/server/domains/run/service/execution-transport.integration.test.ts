import type { GatewayFetchRequest } from "@cubby/shared/ai/gateway-request";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  AI_BUDGET_LIMIT_USD,
  AiBudgetExhaustedError,
  aiBudgetWindow,
  readAiBudget,
} from "~/server/ai/budget";
import { getDb } from "~/server/db/helpers";
import { aiUsage, run } from "~/server/db/schema";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { ensureRun } from "../repo/ensure-run";
import { resumeBudgetPausedImports } from "./ai-work";
import { paidRunPreflight } from "./execution-transport";

const chatRequest = (): GatewayFetchRequest => ({
  endpoint: "responses",
  headers: new Headers(),
  input: "https://gateway.invalid/openai/responses",
  init: undefined,
  signal: undefined,
  query: async () => ({ model: "gpt-6-luna" }),
});
const decisionRequest = (): GatewayFetchRequest => ({
  endpoint: "run/typesafe/jev",
  headers: new Headers(),
  input: "https://gateway.invalid/workers-ai/typesafe/jev",
  init: undefined,
  signal: undefined,
  query: async () => ({ questions: {} }),
});

// Background spend must stop before transmission once a window is spent,
// pause its Run so recovery can resume it, and never block classification.
describe("household AI budget at the paid transport boundary", () => {
  const ctx = withTestDb();

  async function setup(purpose: "mail_import" | "mail_reclassify") {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic budget member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    return ensureRun(ctx.db, ctx.actor, {
      purpose,
      trigger: "scheduled",
      status: "running",
      input:
        purpose === "mail_reclassify"
          ? {
              kind: "mail_reclassify",
              mode: "relevance",
              mailboxId: "synthetic-budget-mailbox",
              emails: [{ emailId: crypto.randomUUID(), checksum: "synthetic" }],
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
    });
  }

  async function spend(
    runId: Awaited<ReturnType<typeof setup>>,
    usd: number,
    options: { feature?: string; model?: string; createdAt?: Date } = {},
  ) {
    await getDb(ctx.db)
      .insert(aiUsage)
      .values({
        runId,
        feature: options.feature ?? "purchase_import_agent",
        provider: "openai",
        model: options.model ?? "gpt-6-luna",
        operation: "agent.generation",
        durationMs: 1,
        chargedCost: usd,
        createdAt: options.createdAt ?? new Date(),
      });
  }

  const status = async (runId: Awaited<ReturnType<typeof setup>>) =>
    (
      await getDb(ctx.db)
        .select({ status: run.status, failureCode: run.failureCode })
        .from(run)
        .where(eq(run.id, runId))
    )[0];

  it("refuses paid chat once the window is spent and pauses the import Run for the next window", async () => {
    const runId = await setup("mail_import");
    await spend(runId, AI_BUDGET_LIMIT_USD);
    await expect(
      paidRunPreflight(ctx.db, runId, "purchase_import_agent")(chatRequest()),
    ).rejects.toBeInstanceOf(AiBudgetExhaustedError);
    expect(await status(runId)).toEqual({
      status: "paused_auth",
      failureCode: "execution_limit",
    });
    // Still spent: recovery leaves it waiting.
    expect(await resumeBudgetPausedImports(ctx.db)).toBe(0);
    await getDb(ctx.db)
      .update(aiUsage)
      .set({ createdAt: new Date(aiBudgetWindow().start.getTime() - 1) })
      .where(eq(aiUsage.runId, runId));
    expect(await resumeBudgetPausedImports(ctx.db)).toBe(1);
    expect((await status(runId))?.failureCode).not.toBe("execution_limit");
    expect((await status(runId))?.status).not.toBe("paused_auth");
  });

  it("pauses a reclassification Run for recovery in a later window", async () => {
    const runId = await setup("mail_reclassify");
    await spend(runId, AI_BUDGET_LIMIT_USD);
    await expect(
      paidRunPreflight(ctx.db, runId, "purchase_import_agent")(chatRequest()),
    ).rejects.toBeInstanceOf(AiBudgetExhaustedError);
    expect(await status(runId)).toEqual({
      status: "paused_auth",
      failureCode: "execution_limit",
    });
  });

  it("never budgets classification or closed-set decision models", async () => {
    const runId = await setup("mail_import");
    await spend(runId, AI_BUDGET_LIMIT_USD * 3);
    await paidRunPreflight(ctx.db, runId, "mailbox-relevance")(chatRequest());
    await paidRunPreflight(
      ctx.db,
      runId,
      "purchase_import_agent",
    )(decisionRequest());
    expect((await status(runId))?.status).toBe("running");
  });

  it("counts only this window's frontier chat spend outside classification", async () => {
    const runId = await setup("mail_import");
    const window = aiBudgetWindow();
    await spend(runId, 5, {
      createdAt: new Date(window.start.getTime() - 1),
    });
    await spend(runId, 5, { feature: "mailbox-relevance" });
    await spend(runId, 5, {
      feature: "field-suggestion",
      model: "typesafe/jev",
    });
    await spend(runId, 5, {
      feature: "entity-embedding",
      model: "text-embedding-3-small",
    });
    await spend(runId, 0.25);
    expect((await readAiBudget(ctx.db)).spentUsd).toBeCloseTo(0.25);
    await paidRunPreflight(
      ctx.db,
      runId,
      "purchase_import_agent",
    )(chatRequest());
  });

  it("refuses paid work for a Run that is no longer executable", async () => {
    const runId = await setup("mail_import");
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", failureCode: "user_cancelled" })
      .where(eq(run.id, runId));
    await expect(
      paidRunPreflight(ctx.db, runId, "purchase_import_agent")(chatRequest()),
    ).rejects.toThrow(/no longer executable/u);
  });
});
