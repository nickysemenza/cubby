import { MAX_STEP_RUN_INSTANCE_PAGES } from "@cubby/schemas/run-step";
import { createLogger } from "@cubby/worker-tracing";

import type { StepAdvance } from "~/server/domains/run/service/step-run";
import { runFailureText } from "~/server/workflows/runs/lifecycle";
import {
  BOOKKEEPING_RETRIES,
  type DurableSteps,
} from "~/server/workflows/runs/step";

// The subrequest budget belongs to the instance, not to each step.do page.
// Leave headroom for page retries, failure recording and successor dispatch.
const DEFAULT_PAGES_PER_INSTANCE = 5;
const INSTANCE_ELAPSED_MS = 10 * 60_000;
const log = createLogger("step-run-workflow");

/** Effects whose invocation/database ownership stays with the Cloudflare adapter. */
export interface StepRunWork {
  elapsedMs?(): number;
  advance(): Promise<StepAdvance>;
  boundary(name: string, force?: boolean): Promise<boolean>;
  wait(page: number, seconds: number): Promise<void>;
  fail(message: string): Promise<boolean>;
  recover(): Promise<void>;
}

export async function runStepRunWorkflow(
  steps: DurableSteps,
  work: StepRunWork,
) {
  try {
    const phasePages = new Map<string, number>();
    for (let page = 0; page < MAX_STEP_RUN_INSTANCE_PAGES; page++) {
      if (await work.boundary(`page:${page}`)) return;
      const advance = await steps.do(
        `page:${page}`,
        { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" } },
        () => work.advance(),
      );
      if (advance.kind !== "continue" && advance.kind !== "wait") return;
      const execution =
        advance.kind === "continue" ? advance.execution : undefined;
      const phase = execution?.phase ?? "default";
      const pages = (phasePages.get(phase) ?? 0) + 1;
      phasePages.set(phase, pages);
      if (advance.kind === "continue" && advance.waitSeconds)
        await steps.sleep(`capacity:${page}`, advance.waitSeconds * 1_000);
      const elapsed = await steps.do(
        `elapsed:${page}`,
        BOOKKEEPING_RETRIES,
        async () => (work.elapsedMs?.() ?? 0) >= INSTANCE_ELAPSED_MS,
      );
      if (
        elapsed ||
        pages >= (execution?.pagesPerInstance ?? DEFAULT_PAGES_PER_INSTANCE)
      ) {
        await work.boundary("continue", true);
        return;
      }
      if (advance.kind === "wait")
        try {
          await work.wait(page, advance.seconds);
        } catch {
          // SILENT: the event is a hint; the next page re-reads the child.
        }
    }
    await work.boundary("continue", true);
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
