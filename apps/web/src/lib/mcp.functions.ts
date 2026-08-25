import {
  mcpToolCatalogOut,
  type mcpUsageActivityInput,
  mcpUsageActivityOut,
  mcpUsageDashboardBrowserOut,
  type mcpUsageDashboardInput,
} from "@cubby/schemas/telemetry";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
import * as mcpBrowser from "~/server/mcp-browser.server";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";

const listMcpCatalogTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .handler(
    async ({ context }) =>
      await mcpBrowser.listMcpCatalogForBrowser({
        request: context.startOperation,
      }),
  );

const getMcpUsageDashboardTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof mcpUsageDashboardInput>,
  )
  .handler(
    async ({ data, context }) =>
      await mcpBrowser.getMcpUsageDashboardForBrowser({
        data,
        request: context.startOperation,
      }),
  );

const listMcpUsageActivityTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof mcpUsageActivityInput>)
  .handler(
    async ({ data, context }) =>
      await mcpBrowser.listMcpUsageActivityForBrowser({
        data,
        request: context.startOperation,
      }),
  );

const mcpCatalogOperation = startOperation<
  null,
  z.output<typeof mcpToolCatalogOut>
>({
  operation: "mcp.listTools",
  transport: (_input, { signal, headers }) =>
    listMcpCatalogTransport({ signal, headers }),
  parse: (result) => mcpToolCatalogOut.parse(result),
});

const mcpUsageDashboardOperation = startOperation<
  z.input<typeof mcpUsageDashboardInput>,
  z.output<typeof mcpUsageDashboardBrowserOut>
>({
  operation: "mcp.usageDashboard",
  transport: (data, { signal, headers }) =>
    getMcpUsageDashboardTransport({ data, signal, headers }),
  parse: (result) => mcpUsageDashboardBrowserOut.parse(result),
});

const mcpUsageActivityOperation = startOperation<
  z.input<typeof mcpUsageActivityInput>,
  z.output<typeof mcpUsageActivityOut>
>({
  operation: "mcp.usageActivity",
  transport: (data, { signal, headers }) =>
    listMcpUsageActivityTransport({ data, signal, headers }),
  parse: (result) => mcpUsageActivityOut.parse(result),
});

export const mcpCatalogQueryOptions = () =>
  queryOptions({
    queryKey: [["mcp", "listTools"]] as const,
    meta: mcpCatalogOperation.meta,
    queryFn: ({ signal }) => mcpCatalogOperation.call(null, { signal }),
  });

export const mcpUsageDashboardQueryOptions = (
  input: z.input<typeof mcpUsageDashboardInput>,
) =>
  queryOptions({
    queryKey: [["mcp", "usageDashboard"], { input }] as const,
    meta: mcpUsageDashboardOperation.meta,
    queryFn: ({ signal }) => mcpUsageDashboardOperation.call(input, { signal }),
  });

type McpUsageActivityInput = z.input<typeof mcpUsageActivityInput>;

export const mcpUsageActivityInfiniteQueryOptions = (
  input: McpUsageActivityInput,
) => {
  const { cursor: _cursor, ...inputWithoutCursor } = input;
  return infiniteQueryOptions({
    queryKey: [
      ["mcp", "usageActivity"],
      { input: inputWithoutCursor, type: "infinite" },
    ] as const,
    meta: mcpUsageActivityOperation.meta,
    initialPageParam: input.cursor ?? null,
    queryFn: ({ pageParam, signal }) =>
      mcpUsageActivityOperation.call(
        {
          ...input,
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        { signal },
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
};
