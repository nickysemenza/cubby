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
  // harness, and a database, so they contend for the same finite CPU. CI's
  // default remains one worker; the two-runner workflow currently benchmarks
  // --workers=2 after browser-cache and reduced-motion changes. The prior
  // attempt flaked on inventory-session.spec (2026-09-21, a 15s visibility
  // timeout).
  return !env.CI && platform === "darwin" ? 2 : 1;
}
