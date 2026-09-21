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
  // Two, not three: at three the iPhone WebKit project flaked across four
  // unrelated specs whenever other sessions' gates loaded the host (2026-09-17),
  // and every run at two was clean. Each worker owns a browser, a Worker
  // harness, and a database, so they contend for the same finite CPU. On CI
  // (public ubuntu-latest, 4 vCPU) the workflow sets CUBBY_E2E_WORKERS
  // explicitly per lane — 2 for chromium, 1 for webkit — so this fallback of
  // 1 only applies if that env var is ever left unset there.
  return !env.CI && platform === "darwin" ? 2 : 1;
}
