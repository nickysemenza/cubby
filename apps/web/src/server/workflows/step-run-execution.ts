import { MAX_STEP_RUN_INSTANCE_PAGES } from "@cubby/schemas/run-step";
import { WORKFLOW_EXECUTION_LIMITS } from "@cubby/shared/workflow-limits";
import { createLogger } from "@cubby/worker-tracing";

import type {
  StepAdvance,
  StepPagePlan,
  StepPageSummary,
} from "~/server/domains/run/service/step-run";
import { runFailureText } from "~/server/workflows/runs/lifecycle";
import {
  BOOKKEEPING_RETRIES,
  type DurableSteps,
} from "~/server/workflows/runs/step";

const log = createLogger("step-run-workflow");

/** Effects whose invocation/database ownership stays with the Cloudflare adapter. */
export interface StepRunWork {
  inspect(): Promise<StepPagePlan | null>;
  elapsedMs?(): number;
  advance(): Promise<StepAdvance>;
  boundary(
    name: string,
    force?: boolean,
    dashboard?: { nextInstanceId: string; summary: StepPageSummary | null },
  ): Promise<boolean>;
  wait(page: number, seconds: number): Promise<void>;
  fail(message: string): Promise<boolean>;
  recover(): Promise<void>;
}

export async function runStepRunWorkflow(
  steps: DurableSteps,
  work: StepRunWork,
) {
  try {
    let dashboard:
      | { nextInstanceId: string; summary: StepPageSummary | null }
      | undefined;
    let pageAllowanceUsed = 0;
    for (let page = 0; page < MAX_STEP_RUN_INSTANCE_PAGES; page++) {
      // Names are memoization keys. Inspect once inside step.do: only this saved
      // checkpoint (never live counts or wall time) may name the page on replay.
      const plan = await steps.do(
        `inspect checkpoint p${page + 1}`,
        BOOKKEEPING_RETRIES,
        () => work.inspect(),
      );
      if (!plan) return;
      // Different ledger steps can share a phase and page ordinal.
      const name = `${plan.name} · ${plan.scope}`;
      dashboard = {
        nextInstanceId: plan.nextInstanceId,
        summary: plan.summary,
      };
      if (await work.boundary(name, false, dashboard)) return;
      const advance = await steps.do(
        name,
        {
          timeout: "15 minutes",
          retries: {
            limit: WORKFLOW_EXECUTION_LIMITS.pageAttempts - 1,
            delay: "5 seconds",
            backoff: "exponential",
          },
        },
        () => work.advance(),
      );
      dashboard.summary = advance.summary ?? dashboard.summary;
      if (advance.kind !== "continue" && advance.kind !== "wait") return;
      const execution =
        advance.kind === "continue" ? advance.execution : undefined;
      // Static page costs share one allowance across phases. Database-only
      // pages consume a smaller share than a page of independent model calls.
      pageAllowanceUsed +=
        1 /
        (execution?.pagesPerInstance ??
          WORKFLOW_EXECUTION_LIMITS.fallbackPagesPerInstance);
      if (advance.kind === "continue" && advance.waitSeconds)
        await steps.sleep(`capacity:${page}`, advance.waitSeconds * 1_000);
      const elapsed = await steps.do(
        `instance budget · ${name}`,
        BOOKKEEPING_RETRIES,
        async () => ({
          handoffDue:
            (work.elapsedMs?.() ?? 0) >= WORKFLOW_EXECUTION_LIMITS.elapsedMs,
          budgetMinutes: WORKFLOW_EXECUTION_LIMITS.elapsedMs / 60_000,
        }),
      );
      if (
        elapsed.handoffDue ||
        // Tolerate accumulated floating-point error at an exact page bound.
        pageAllowanceUsed >= 1 - Number.EPSILON * MAX_STEP_RUN_INSTANCE_PAGES
      ) {
        await work.boundary("continue", true, dashboard);
        return;
      }
      if (advance.kind === "wait")
        try {
          await work.wait(page, advance.seconds);
        } catch {
          // SILENT: the event is a hint; the next page re-reads the child.
        }
    }
    await work.boundary("continue", true, dashboard);
  } catch (error) {
    let message = runFailureText(
      error instanceof Error ? error : String(error),
    );
    log.error("Workflow page failed", { error: message });
    try {
      await steps.do(
        "fail",
        { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } },
        async () => {
          try {
            return await work.fail(message);
          } catch (recordingError) {
            message += `\nFailure recording failed:\n${runFailureText(recordingError instanceof Error ? recordingError : String(recordingError))}`;
            log.error("Workflow failure recording failed", { error: message });
            // Cloudflare status preserves message, not the nested cause graph.
            throw new Error(message, { cause: recordingError });
          }
        },
      );
    } catch (recordingError) {
      // Reconciliation can store this combined instance error from a fresh
      // invocation even if the current invocation cannot reach the database.
      throw new Error(message, { cause: recordingError });
    }
    try {
      await work.recover();
    } catch (recoveryError) {
      message += `\nRecovery scheduling failed:\n${runFailureText(recoveryError instanceof Error ? recoveryError : String(recoveryError))}`;
      log.error("Workflow recovery scheduling failed", { error: message });
      throw new Error(message, { cause: recoveryError });
    }
    throw error;
  }
}
