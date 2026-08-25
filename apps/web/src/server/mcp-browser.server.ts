import {
  mcpToolCatalogOut,
  mcpUsageActivityInput,
  mcpUsageActivityOut,
  mcpUsageDashboardBrowserOut,
  mcpUsageDashboardInput,
} from "@cubby/schemas/telemetry";
import { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import {
  getMcpUsageDashboardWorkflow,
  listMcpCatalogWorkflow,
  listMcpUsageActivityWorkflow,
} from "~/server/workflows/mcp-browser.server";

export const listMcpCatalogForBrowser = (options: {
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "mcp.listTools",
    type: "query",
    input: null,
    inputSchema: z.null(),
    outputSchema: mcpToolCatalogOut,
    request: options.request,
    readPolicy: "strong",
    run: () => listMcpCatalogWorkflow(),
  });

export const getMcpUsageDashboardForBrowser = (options: {
  data: z.input<typeof mcpUsageDashboardInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "mcp.usageDashboard",
    type: "query",
    input: options.data,
    inputSchema: mcpUsageDashboardInput,
    outputSchema: mcpUsageDashboardBrowserOut,
    request: options.request,
    readPolicy: "strong",
    run: (context, input) => getMcpUsageDashboardWorkflow(context.db, input),
  });

export const listMcpUsageActivityForBrowser = (options: {
  data: z.input<typeof mcpUsageActivityInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "mcp.usageActivity",
    type: "query",
    input: options.data,
    inputSchema: mcpUsageActivityInput,
    outputSchema: mcpUsageActivityOut,
    request: options.request,
    readPolicy: "strong",
    run: (context, input) => listMcpUsageActivityWorkflow(context.db, input),
  });
