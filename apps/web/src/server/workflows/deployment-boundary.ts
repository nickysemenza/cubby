import type { StepPageSummary } from "~/server/domains/run/service/step-run";

import { BOOKKEEPING_RETRIES, type DurableSteps } from "./runs/step";

/**
 * Check only between committed pages. Retain the decision before creating a
 * successor: a lost create reply followed by rollback must not reactivate the
 * predecessor while that successor owns the checkpoint.
 */
export async function workflowDeploymentBoundary(
  steps: DurableSteps,
  input: {
    name: string;
    version: string;
    currentVersion(): Promise<string>;
    continue(): Promise<void>;
    force?: boolean;
    initial?: boolean;
    dashboard?: { nextInstanceId: string; summary: StepPageSummary | null };
  },
): Promise<boolean> {
  const handoff = await steps.do(
    `deployment guard · ${input.name}`,
    BOOKKEEPING_RETRIES,
    async () => {
      // The DO can still serve the preceding deployment at fresh startup.
      // Commit one bounded page before comparing; never sleep or chain empty
      // successors while propagation catches up. Forced budgets still win.
      const starting = input.initial && !input.force;
      const currentVersion =
        input.force || starting ? null : await input.currentVersion();
      return {
        handoff:
          Boolean(input.force) ||
          (!starting && currentVersion !== input.version),
        reason: input.force
          ? "instance budget"
          : starting
            ? "instance startup"
            : currentVersion !== input.version
              ? "deployment changed"
              : "deployment current",
        pinnedVersion: input.version,
        currentVersion,
      };
    },
  );
  if (!handoff.handoff) return false;
  await steps.do(
    input.dashboard
      ? `handoff → ${input.dashboard.nextInstanceId} · ${input.name}`
      : `handoff:${input.name}`,
    BOOKKEEPING_RETRIES,
    async () => {
      await input.continue();
      return { queued: true, ...input.dashboard };
    },
  );
  return true;
}
