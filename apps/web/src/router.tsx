import * as Sentry from "@sentry/tanstackstart-react";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { RouteErrorComponent } from "~/components/route-error";
import * as TanstackQuery from "./integrations/tanstack-query/root-provider";

// Import the generated route tree
import { routeTree } from "./routeTree.gen";

// Create a new router instance
export const getRouter = () => {
  const rqContext = TanstackQuery.getContext();

  const router = createRouter({
    routeTree,
    context: {
      ...rqContext,
    },

    defaultPreload: "intent",
    defaultViewTransition: true,
    defaultErrorComponent: RouteErrorComponent,
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
  }

  setupRouterSsrQueryIntegration({
    router,
    queryClient: rqContext.queryClient,
  });

  return router;
};
