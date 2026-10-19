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
  },
): Promise<boolean> {
  const handoff = await steps.do(
    `deployment:${input.name}`,
    BOOKKEEPING_RETRIES,
    async () => input.force || (await input.currentVersion()) !== input.version,
  );
  if (!handoff) return false;
  if (input.initial && !input.force) {
    await steps.sleep(`deployment-settle:${input.name}`, 30_000);
    const settled = await steps.do(
      `deployment-settled:${input.name}`,
      BOOKKEEPING_RETRIES,
      async () => (await input.currentVersion()) !== input.version,
    );
    if (!settled) return false;
  }
  await steps.do(`handoff:${input.name}`, BOOKKEEPING_RETRIES, async () => {
    await input.continue();
    return null;
  });
  return true;
}
