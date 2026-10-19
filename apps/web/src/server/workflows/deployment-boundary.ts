import { BOOKKEEPING_RETRIES, type DurableSteps } from "./runs/step";

/**
 * Check only between committed pages. Retain the decision before creating a
 * successor: a lost create reply followed by rollback must not reactivate the
 * predecessor while that successor owns the checkpoint.
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
  const handoff = await steps.do(
    `deployment:${input.name}`,
    BOOKKEEPING_RETRIES,
    async () => input.force || (await input.currentVersion()) !== input.version,
  );
  if (!handoff) return false;
  await steps.do(`handoff:${input.name}`, BOOKKEEPING_RETRIES, async () => {
    await input.continue();
    return null;
  });
  return true;
}
