import { WORKFLOW_EXECUTION_LIMITS } from "@cubby/shared/workflow-limits";
import type { WorkflowStep } from "cloudflare:workers";

import { WORKFLOW_CONTROL_EVENT } from "./activation";
import { BOOKKEEPING_RETRIES, type DurableSteps } from "./step";

/** Buffered events are hints; they never shorten the durable retry/admission deadline. */
export async function waitForWorkflowControl(
  steps: DurableSteps,
  input: {
    name: string;
    dueAt: number;
    now?: () => number;
    stopAfterWake?: boolean;
    waitForEvent(name: string, timeoutMs: number): Promise<void>;
    boundary(name: string, force?: boolean): Promise<boolean>;
  },
): Promise<boolean> {
  for (let wake = 0; ; wake++) {
    const name = `${input.name}:${wake}`;
    if (wake >= WORKFLOW_EXECUTION_LIMITS.controlWakesPerWait) {
      if (!(await input.boundary(`control hint budget · ${name}`, true)))
        throw new Error(
          "Workflow continuation refused after the control hint budget",
        );
      return true;
    }
    const remaining = await steps.do(
      `wait deadline · ${name}`,
      BOOKKEEPING_RETRIES,
      async () => Math.max(0, input.dueAt - (input.now ?? Date.now)()),
    );
    if (remaining === 0) return false;
    await input.waitForEvent(name, remaining);
    if (await input.boundary(`control wake · ${name}`)) return true;
    if (input.stopAfterWake) return false;
  }
}

/** Cloudflare adapter shared by capacity, policy, child and retry waits. */
export function workflowControlWait(
  step: WorkflowStep,
  boundary: (name: string, force?: boolean) => Promise<boolean>,
) {
  let waits = 0;
  return async (name: string, dueAt: number, stopAfterWake = false) => {
    if (waits++ >= WORKFLOW_EXECUTION_LIMITS.fallbackPagesPerInstance) {
      if (!(await boundary(`control wait budget · ${name}`, true)))
        throw new Error(
          "Workflow continuation refused after the control wait budget",
        );
      return true;
    }
    const deadline = await step.do(
      `control deadline · ${name}`,
      BOOKKEEPING_RETRIES,
      async () => dueAt,
    );
    return waitForWorkflowControl(step, {
      name,
      dueAt: deadline,
      stopAfterWake,
      boundary,
      waitForEvent: async (waitName, timeoutMs) => {
        try {
          await step.waitForEvent(waitName, {
            type: WORKFLOW_CONTROL_EVENT,
            timeout: `${Math.max(1, Math.ceil(timeoutMs / 1000))} seconds`,
          });
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !/time.?out|timed out/iu.test(error.message)
          )
            throw error;
        }
      },
    });
  };
}
