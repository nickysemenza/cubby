/** Built previews on loopback are local executions, even with production JS. */
export function sentryEnvironment(
  origin: string | undefined,
  fallback: string | undefined,
): string | undefined {
  if (!origin) return fallback;
  try {
    const hostname = new URL(origin).hostname.replace(/\.$/, "");
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname)
    ) {
      return fallback === "test" ? "test" : "development";
    }
  } catch {
    // SILENT: relative or malformed URLs cannot establish a runtime
    // environment; `fallback` below is the environment classification itself,
    // used unchanged rather than failing Sentry init over a bad origin.
  }
  return fallback;
}

/**
 * Worker-binding wrapper: E2E test mode always wins (shared local Worker
 * identity, see env.ts), then the deployed `SENTRY_ENVIRONMENT` var, then
 * "production". `APP_ORIGIN` stays the prod origin even under `wrangler dev`,
 * so it can't itself signal "development" — the var (set via `--var` for
 * `preview:cf`) is what distinguishes a local preview from prod.
 */
export function resolveWorkerSentryEnvironment(env: {
  APP_ORIGIN?: string;
  E2E_AUTH_TEST_MODE?: string;
  SENTRY_ENVIRONMENT?: string;
}): string | undefined {
  return sentryEnvironment(
    env.APP_ORIGIN,
    env.E2E_AUTH_TEST_MODE === "true"
      ? "test"
      : (env.SENTRY_ENVIRONMENT ?? "production"),
  );
}
