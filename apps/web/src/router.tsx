import * as Sentry from "@sentry/tanstackstart-react";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { RouteErrorComponent } from "~/components/route-error";
import { RoutePending } from "~/components/route-pending";
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
    defaultViewTransition: true,
    defaultErrorComponent: RouteErrorComponent,
    // Route-transition skeleton instead of a blank flash. Thresholds chosen so
    // preloaded (instant) navs show nothing, only genuinely-not-ready ones do;
    // pendingMinMs holds it long enough to avoid a flicker once shown.
    defaultPendingComponent: RoutePending,
    defaultPendingMs: 200,
    defaultPendingMinMs: 400,
  });

  // Initialize Sentry on client only. Dev keeps error reporting AND tracing,
  // but drops Replay and console-breadcrumb capture: those two are what turn a
  // flood of console.error warnings (e.g. a React setState-in-render warning)
  // into a 30s+ main-thread freeze — Replay serializes the DOM and captures
  // every console call. Tracing is safe; it doesn't run per console.error.
  if (!router.isServer) {
    const isProd = import.meta.env.PROD;
    Sentry.init({
      dsn: "https://a50b2f76dd1586f95cdd29cd13a6c0dc@o83311.ingest.us.sentry.io/4508775559135232",
      sendDefaultPii: true,
      tracesSampleRate: 1.0,
      replaysSessionSampleRate: isProd ? 0.1 : 0,
      replaysOnErrorSampleRate: isProd ? 1.0 : 0,
      integrations: isProd
        ? [
            Sentry.tanstackRouterBrowserTracingIntegration(router),
            Sentry.replayIntegration(),
          ]
        : [Sentry.tanstackRouterBrowserTracingIntegration(router)],
      // Don't record console output as breadcrumbs in dev — capturing hundreds
      // of warnings per second is the work that balloons into the freeze.
      beforeBreadcrumb: isProd
        ? undefined
        : (breadcrumb) =>
            breadcrumb.category === "console" ? null : breadcrumb,
    });

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
