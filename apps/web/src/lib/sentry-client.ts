import { SENTRY_DATA_COLLECTION } from "@cubby/worker-tracing/sentry-data-collection";
import { CUBBY_SENTRY_DSN } from "@cubby/worker-tracing/sentry-dsn";

import { isSupersededViewTransitionError } from "~/lib/error-utils";
import { sentryEnvironment } from "~/lib/sentry-environment";
import { SENTRY_IGNORED_ERRORS } from "~/lib/sentry-noise";
import { scrubSentryEvent } from "~/lib/sentry-scrub";

type SentryBrowser = typeof import("@sentry/tanstackstart-react");

/**
 * The browser SDK (~70 KiB gzip) loads once the page is idle after hydration,
 * not in the entry chunk. Errors and rejections raised before then are held
 * here and replayed into Sentry once it initializes, so an early crash is
 * still reported; after init the SDK's own global handlers take over. A failed
 * chunk load (offline) is not cached: the next error or capture retries, and
 * the buffer keeps only the first errors meanwhile.
 */
const EARLY_LIMIT = 50;
const early: unknown[] = [];
let sentry: Promise<SentryBrowser | undefined> | undefined;

const buffer = (event: ErrorEvent | PromiseRejectionEvent) => {
  if (early.length < EARLY_LIMIT)
    early.push(
      event instanceof PromiseRejectionEvent
        ? event.reason
        : (event.error ?? event.message),
    );
  void loadSentry();
};

function loadSentry(): Promise<SentryBrowser | undefined> {
  // The SSR guard keeps the browser SDK out of the Worker bundle entirely.
  if (import.meta.env.SSR) return Promise.resolve(undefined);
  return (sentry ??= import("@sentry/tanstackstart-react").then(
    (Sentry) => {
      initSentry(Sentry);
      window.removeEventListener("error", buffer);
      window.removeEventListener("unhandledrejection", buffer);
      for (const error of early.splice(0)) Sentry.captureException(error);
      return Sentry;
    },
    () => {
      sentry = undefined;
      return undefined;
    },
  ));
}

function initSentry(Sentry: SentryBrowser) {
  // Dev keeps error reporting but drops console-breadcrumb capture: hundreds
  // of warnings per second balloon into a multi-second main-thread freeze.
  //
  // Session Replay is deliberately NOT enabled: `replayIntegration()` bundles
  // the full rrweb recorder (~60 KiB gzip) — too steep for a single-user app.
  const isProd = import.meta.env.PROD;
  Sentry.init({
    dsn: CUBBY_SENTRY_DSN,
    // E2E uses the production bundle but installs this flag before client
    // scripts run. Disabling the SDK here keeps test events out of Sentry
    // without Playwright routing, which disables the browser HTTP cache.
    enabled:
      !("__CUBBY_E2E_DISABLE_SENTRY__" in window) &&
      (!import.meta.env.CUBBY_LOCAL_RUNTIME ||
        import.meta.env.CUBBY_LOCAL_TELEMETRY),
    dataCollection: SENTRY_DATA_COLLECTION,
    release: `cubby@${__GIT_COMMIT__}`,
    environment: sentryEnvironment(
      window.location.origin,
      isProd ? "production" : "development",
    ),
    // Drop known-noise messages before send — free-plan quota hygiene.
    ignoreErrors: SENTRY_IGNORED_ERRORS,
    // Keep the scrubber as defense in depth for manually attached request
    // data, even though the SDK no longer sends default PII.
    beforeSend: (event, hint) => {
      // Historical Safari cancellation from the removed View Transitions
      // integration. Keep this exact; other AbortErrors stay actionable.
      if (isSupersededViewTransitionError(hint.originalException)) return null;
      return scrubSentryEvent(event);
    },
    // Request spans are owned by Cloudflare; Sentry captures errors only.
    tracesSampler: () => 0,
    integrations: [],
    beforeBreadcrumb: isProd
      ? undefined
      : (breadcrumb) => (breadcrumb.category === "console" ? null : breadcrumb),
  });
}

/** Buffer early errors now; load and initialize the SDK once the page idles. */
export function installClientSentry(): void {
  window.addEventListener("error", buffer);
  window.addEventListener("unhandledrejection", buffer);
  const load = () => void loadSentry();
  // Safari has no requestIdleCallback.
  if ("requestIdleCallback" in window)
    window.requestIdleCallback(load, { timeout: 3000 });
  else setTimeout(load, 1000);
}

/** Report an error, loading the SDK first if it has not loaded yet. */
export async function captureClientException(
  ...args: Parameters<SentryBrowser["captureException"]>
): Promise<string | undefined> {
  const Sentry = await loadSentry();
  return Sentry?.captureException(...args);
}
