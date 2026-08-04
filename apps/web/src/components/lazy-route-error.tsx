import { lazy } from "react";

/** Failure-only route UI; keep diagnostics out of successful navigations. */
export const RouteErrorComponent = lazy(() =>
  import("./route-error").then((module) => ({
    default: module.RouteErrorComponent,
  })),
);
