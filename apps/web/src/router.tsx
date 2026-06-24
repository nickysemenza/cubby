import * as Sentry from "@sentry/tanstackstart-react";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { RouteErrorComponent } from "~/components/route-error";
import { RouteNotFound } from "~/components/route-not-found";
import { RoutePending } from "~/components/route-pending";
import { installJsProfiler } from "~/lib/perf/js-self-profile";
import * as TanstackQuery from "./integrations/tanstack-query/root-provider";

// Import the generated route tree
import { routeTree } from "./routeTree.gen";

// Defined by Vite only for CF builds (build:cf), absent under `vite dev`.
// We gate SW registration on this rather than import.meta.env.PROD so the SW
// only ever registers for deployed CF builds, never a local production build.
declare const __CF_WORKERS__: boolean | undefined;

// Create a new router instance
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
    defaultViewTransition: true,
    defaultErrorComponent: RouteErrorComponent,
    defaultNotFoundComponent: RouteNotFound,
    // Route-transition skeleton instead of a blank flash. Thresholds chosen so
    // preloaded (instant) navs show nothing, only genuinely-not-ready ones do;
    // pendingMinMs holds it long enough to avoid a flicker once shown.
    defaultPendingComponent: RoutePending,
    defaultPendingMs: 200,
    defaultPendingMinMs: 400,
  });

  // Initialize Sentry on client only. Dev keeps error reporting but drops
  // tracing, Replay, and console-breadcrumb capture — each turns a busy moment
  // into a multi-second main-thread freeze in dev: Replay serializes the DOM on
  // every console call, and browser tracing builds an O(n²) span tree from React
  // 19's dev per-render `performance.measure` entries (see below). Prod keeps all
  // three (its React build emits no such measures; Replay is sampled).
  if (!router.isServer) {
    const isProd = import.meta.env.PROD;
    Sentry.init({
      dsn: "https://a50b2f76dd1586f95cdd29cd13a6c0dc@o83311.ingest.us.sentry.io/4508775559135232",
      sendDefaultPii: true,
      // Tracing OFF in dev. React 19's dev build emits a `performance.measure`
      // per component render; Sentry's browser tracing turns each into a span and
      // builds the span tree in O(n²) (`addSpanChildren`). On component-heavy
      // views (recipe prep/nested/matrix render every sub-recipe) that's an ~8s
      // main-thread freeze on load — confirmed via JS self-profiling (60% of
      // samples in `addSpanChildren`). Prod's React build emits no such measures,
      // so full tracing there is safe.
      // Sample 10% of prod pageloads for tracing — full 100% added meaningful
      // per-navigation instrumentation overhead with little extra signal for a
      // single-user app. Errors + replay sampling are unaffected.
      tracesSampleRate: isProd ? 0.1 : 0,
      replaysSessionSampleRate: isProd ? 0.1 : 0,
      replaysOnErrorSampleRate: isProd ? 1.0 : 0,
      // No browser-tracing integration in dev: its pageload transaction collects
      // React 19's per-render `performance.measure` entries and builds the span
      // tree in O(n²) (`addSpanChildren`) — an ~8s load freeze on the
      // component-heavy recipe views (confirmed via JS self-profiling). Error
      // reporting still works without it. Prod keeps full tracing + replay.
      integrations: isProd
        ? [
            Sentry.tanstackRouterBrowserTracingIntegration(router),
            Sentry.replayIntegration(),
          ]
        : [],
      // Don't record console output as breadcrumbs in dev — capturing hundreds
      // of warnings per second is the work that balloons into the freeze.
      beforeBreadcrumb: isProd
        ? undefined
        : (breadcrumb) =>
            breadcrumb.category === "console" ? null : breadcrumb,
    });

    // Dev-only on-demand CPU profiler: `await __jsProfile(5000)` in the console.
    if (!isProd) installJsProfiler();

    // Register the app-shell service worker. Gate on the CF build (the SW only
    // exists there; `vite dev` has no /sw.js and SW + HMR is noisy anyway).
    // Best-effort: a failed registration must not break boot.
    const isCfBuild =
      typeof __CF_WORKERS__ !== "undefined" && __CF_WORKERS__ === true;
    if (isCfBuild && "serviceWorker" in navigator) {
      const register = () =>
        navigator.serviceWorker.register("/sw.js").catch(() => {});
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
