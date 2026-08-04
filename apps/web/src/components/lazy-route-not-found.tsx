import { lazy } from "react";

/** Failure-only route UI; keep the branded 404 out of the eager closure. */
export const RouteNotFound = lazy(() =>
  import("./route-not-found").then((module) => ({
    default: module.RouteNotFound,
  })),
);
