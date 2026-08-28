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
import { scrubSentryEvent } from "~/lib/sentry-scrub";

import * as TanstackQuery from "./integrations/tanstack-query/root-provider";
import { routeTree } from "./routeTree.gen";

// Defined by Vite for every build and dev mode; true only for CF builds.
// We gate SW registration on this rather than import.meta.env.PROD so the SW
// only ever registers for deployed CF builds, never a local production build.
declare const __CF_WORKERS__: boolean;

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
      sendDefaultPii: false,
      release: `cubby@${__GIT_COMMIT__}`,
      // Without this the SDK defaults to "production", so every error from
      // `vite dev` on localhost lands in the same bucket as a real user's.
      // That is not hypothetical: CUBBY-DY accumulated 761 events over 11 days
      // tagged production, all of them from http://localhost:3000, and it made
      // a genuine-looking prod issue out of transient HMR noise.
      //
      // Keyed on the build, not the hostname: a local `build:cf` preview is a
      // production bundle and should report as one — dev-server noise is the
      // thing being separated out here.
      environment: isProd ? "production" : "development",
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

    // Register the app-shell service worker. Gate on the CF build (the SW only
    // exists there; `vite dev` has no /sw.js and SW + HMR is noisy anyway).
    // Best-effort: a failed registration must not break boot.
    const isCfBuild = __CF_WORKERS__;
    if (isCfBuild && "serviceWorker" in navigator) {
      const register = () =>
        navigator.serviceWorker.register("/sw.js").catch((error) => {
          console.error("[service-worker] registration failed", error);
        });
      // This module executes during hydration, which can be AFTER `load` has
      // already fired — in which case a `load` listener would never run. So
      // register immediately when the document is already complete.
      if (document.readyState === "complete") {
        register();
      } else {
        window.addEventListener("load", register, { once: true });
      }
    }
  }

  setupRouterSsrQueryIntegration({
    router,
    queryClient: rqContext.queryClient,
  });

  return router;
};
