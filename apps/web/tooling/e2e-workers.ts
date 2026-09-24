export function resolveE2EWorkers(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): number {
  const configured = env.CUBBY_E2E_WORKERS;
  if (configured !== undefined) {
    const workers = Number(configured);
    if (!Number.isInteger(workers) || workers < 1 || workers > 4) {
      throw new Error("CUBBY_E2E_WORKERS must be 1, 2, 3, or 4");
    }
    return workers;
  }
  // Each worker owns a browser, a Worker harness, and a database, so they
  // contend for the same finite CPU. Local macOS uses two workers. CI
  // (public ubuntu-latest, 4 vCPU) leaves CUBBY_E2E_WORKERS unset and runs one
  // worker per runner, assigning desktop specs across two runners instead:
  // CUBBY_E2E_WORKERS=2
  // on a single runner flaked (2026-09-21, inventory-session.spec, a 15s
  // toBeVisible timeout).
  return !env.CI && platform === "darwin" ? 2 : 1;
}
