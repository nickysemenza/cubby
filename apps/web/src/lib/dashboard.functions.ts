import {
  type DashboardCountsOut,
  dashboardCountsOut,
} from "@cubby/schemas/dashboard";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
import * as dashboardBrowser from "~/server/dashboard-browser.server";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";

const getDashboardCountsTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(
    async ({ context }) =>
      await dashboardBrowser.getDashboardCountsForBrowser({
        request: context.startOperation,
      }),
  );

const dashboardCountsOperation = startOperation<undefined, DashboardCountsOut>({
  operation: "dashboard.counts",
  transport: (_input, { signal, headers }) =>
    getDashboardCountsTransport({ signal, headers }),
  parse: (result) => dashboardCountsOut.parse(result),
});

export const dashboardCountsQueryOptions = (options?: { enabled?: boolean }) =>
  queryOptions({
    queryKey: [["dashboard", "counts"], { type: "query" }] as const,
    meta: dashboardCountsOperation.meta,
    queryFn: ({ signal }) =>
      dashboardCountsOperation.call(undefined, { signal }),
    ...options,
  });
