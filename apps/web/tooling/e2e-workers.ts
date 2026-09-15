export function resolveE2EWorkers(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): number {
  const configured = env.CUBBY_E2E_WORKERS;
  if (configured !== undefined) {
    const workers = Number(configured);
    if (!Number.isInteger(workers) || workers < 1 || workers > 3) {
      throw new Error("CUBBY_E2E_WORKERS must be 1, 2, or 3");
    }
    return workers;
  }
  return !env.CI && platform === "darwin" ? 3 : 1;
}
