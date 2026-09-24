import * as Sentry from "@sentry/tanstackstart-react";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";

import { RouteErrorComponent } from "~/components/lazy-route-error";
import { RouteNotFound } from "~/components/lazy-route-not-found";
import { RoutePending } from "~/components/route-pending";
import { installPreloadErrorRecovery } from "~/lib/deploy-recovery";
import { isSupersededViewTransitionError } from "~/lib/error-utils";
import { installJsProfiler } from "~/lib/perf/js-self-profile";
import { installNavigationTracker } from "~/lib/perf/navigation-tracker";
import { SENTRY_DSN } from "~/lib/sentry-dsn";
import { sentryEnvironment } from "~/lib/sentry-environment";
import { SENTRY_IGNORED_ERRORS } from "~/lib/sentry-noise";
import { scrubSentryEvent } from "~/lib/sentry-scrub";

import * as TanstackQuery from "./integrations/tanstack-query/root-provider";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const rqContext = TanstackQuery.getContext();

  const router = createRouter({
    routeTree,
    context: {
      ...rqContext,
    },

    defaultPreload: "intent",
    defaultPreloadDelay: 120,
    // We use TanStack Query as the data cache (see setupRouterSsrQueryIntegration).
    // Setting the router's own preload stale time to 0 hands freshness back to
    // React Query: loaders run on every preload and ensureQueryData consults
    // RQ's staleTime, instead of the router short-circuiting with its own cache.
    defaultPreloadStaleTime: 0,
    // Preserve scroll position across back/forward navigation (long list pages).
    scrollRestoration: true,
    defaultErrorComponent: RouteErrorComponent,
    defaultNotFoundComponent: RouteNotFound,
    // Route-transition skeleton instead of a blank flash. Thresholds chosen so
    // preloaded (instant) navs show nothing, only genuinely-not-ready ones do;
    // pendingMinMs holds it long enough to avoid a flicker once shown.
    defaultPendingComponent: RoutePending,
    defaultPendingMs: 350,
    defaultPendingMinMs: 150,
  });

  // Initialize Sentry on client only. Dev keeps error reporting but drops
  // tracing and console-breadcrumb capture — each turns a busy moment into a
  // multi-second main-thread freeze in dev, because browser tracing builds an
  // O(n²) span tree from React 19's dev per-render `performance.measure`
  // entries (see below). Prod keeps both; its React build emits no such
  // measures.
  //
  // Session Replay is deliberately NOT enabled. `replayIntegration()` bundles
  // the full rrweb recorder into the eager entry chunk (~60 KiB gzip on every
  // first paint, sign-in page included) — too steep for a single-user app.
  // Errors and tracing don't depend on it.
  if (!router.isServer) {
    // Must be installed before a user can request a lazy route chunk. A tab
    // left open across a deploy gets one guarded reload onto the new build.
    installPreloadErrorRecovery();

    const isProd = import.meta.env.PROD;
    Sentry.init({
      dsn: SENTRY_DSN,
      // E2E uses the production bundle but installs this flag before client
      // scripts run. Disabling the SDK here keeps test events out of Sentry
      // without Playwright routing, which disables the browser HTTP cache.
      enabled: !("__CUBBY_E2E_DISABLE_SENTRY__" in window),
      sendDefaultPii: false,
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
        if (isSupersededViewTransitionError(hint.originalException)) {
          return null;
        }
        return scrubSentryEvent(event);
      },
      // Tracing OFF in dev. React 19's dev build emits a `performance.measure`
      // per component render; Sentry's browser tracing turns each into a span and
      // builds the span tree in O(n²) (`addSpanChildren`). On component-heavy
      // views (recipe prep/nested/matrix render every sub-recipe) that's an ~8s
      // main-thread freeze on load — confirmed via JS self-profiling (60% of
      // samples in `addSpanChildren`). Prod's React build emits no such measures,
      // so full tracing there is safe.
      // Sample 10% of prod pageloads for tracing — full 100% added meaningful
      // per-navigation instrumentation overhead with little extra signal for a
      // single-user app. Error capture is unaffected.
      tracesSampleRate: isProd ? 0.1 : 0,
      // No browser-tracing integration in dev: its pageload transaction collects
      // React 19's per-render `performance.measure` entries and builds the span
      // tree in O(n²) (`addSpanChildren`) — an ~8s load freeze on the
      // component-heavy recipe views (confirmed via JS self-profiling). Error
      // reporting still works without it. Prod keeps full tracing.
      integrations: isProd
        ? [Sentry.tanstackRouterBrowserTracingIntegration(router)]
        : [],
      // Don't record console output as breadcrumbs in dev — capturing hundreds
      // of warnings per second is the work that balloons into the freeze.
      beforeBreadcrumb: isProd
        ? undefined
        : (breadcrumb) =>
            breadcrumb.category === "console" ? null : breadcrumb,
    });
    installNavigationTracker(router);

    // Dev-only on-demand CPU profiler: `await __jsProfile(5000)` in the console.
    if (!isProd) installJsProfiler();

    // The service worker is gone; unregister any still installed from an
    // earlier deploy so it stops serving stale precached assets.
    navigator.serviceWorker
      ?.getRegistrations()
      .then((registrations) => registrations.forEach((r) => r.unregister()));
  }

  setupRouterSsrQueryIntegration({
    router,
    queryClient: rqContext.queryClient,
  });

  return router;
};
