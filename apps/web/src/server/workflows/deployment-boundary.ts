import { BOOKKEEPING_RETRIES, type DurableSteps } from "./runs/step";

/**
 * Check only between committed pages. Retaining the decision alongside the
 * handoff makes replay follow the same branch; an earlier page cannot observe
 * a later deploy on replay and skip work whose result was already retained.
 */
export async function workflowDeploymentBoundary(
  steps: Pick<DurableSteps, "do">,
  input: {
    name: string;
    version: string;
    currentVersion(): Promise<string>;
    continue(): Promise<void>;
    force?: boolean;
  },
): Promise<boolean> {
  return steps.do(`deployment:${input.name}`, BOOKKEEPING_RETRIES, async () => {
    if (!input.force && (await input.currentVersion()) === input.version)
      return false;
    await input.continue();
    return true;
  });
}
