import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";

import { installPreloadErrorRecovery } from "~/lib/deploy-recovery";
import { installJsProfiler } from "~/lib/perf/js-self-profile";
import { installNavigationTracker } from "~/lib/perf/navigation-tracker";
import { installClientSentry } from "~/lib/sentry-client";
import { RouteErrorComponent } from "~/ui/route-error";
import { RouteNotFound } from "~/ui/route-not-found";
import { RoutePending } from "~/ui/route-pending";

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

  if (!router.isServer) {
    // Must be installed before a user can request a lazy route chunk. A tab
    // left open across a deploy gets one guarded reload onto the new build.
    installPreloadErrorRecovery();

    installClientSentry();
    installNavigationTracker(router);

    // Dev-only on-demand CPU profiler: `await __jsProfile(5000)` in the console.
    if (!import.meta.env.PROD) installJsProfiler();
  }

  setupRouterSsrQueryIntegration({
    router,
    queryClient: rqContext.queryClient,
  });

  return router;
};
