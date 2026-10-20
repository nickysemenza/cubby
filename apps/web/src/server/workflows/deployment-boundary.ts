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
    epoch?: number;
    currentVersion(): Promise<{ version: string; epoch?: number }>;
    continue(): Promise<void>;
    force?: boolean;
    dashboard?: { nextInstanceId: string; summary: StepPageSummary | null };
  },
): Promise<boolean> {
  const handoff = await steps.do(
    `deployment guard · ${input.name}${input.force ? " · forced" : ""}`,
    BOOKKEEPING_RETRIES,
    async () => {
      const identity = input.force ? null : await input.currentVersion();
      const currentVersion = identity?.version ?? null;
      const changed =
        currentVersion !== input.version ||
        (input.epoch !== undefined && identity?.epoch !== input.epoch);
      return {
        handoff: Boolean(input.force) || changed,
        reason: input.force
          ? "instance budget"
          : changed
            ? "deployment changed"
            : "deployment current",
        pinnedVersion: input.version,
        currentVersion,
        pinnedEpoch: input.epoch ?? null,
        currentEpoch: identity?.epoch ?? null,
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
