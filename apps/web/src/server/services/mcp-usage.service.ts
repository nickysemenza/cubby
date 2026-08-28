import type {
  McpToolUsageStatus,
  McpUsageDashboardOut,
  McpUsageWindow,
} from "@cubby/schemas/telemetry";
import { groupBy, sumBy } from "es-toolkit";

import type { Database } from "~/server/db";
import { listMcpToolCatalog } from "~/server/mcp/server";
import {
  getMcpUsageAggregateData,
  mcpUsageSince,
} from "~/server/repo/mcp-usage";

export interface McpUsageDashboardPort {
  listCatalog: typeof listMcpToolCatalog;
  loadAggregate: typeof getMcpUsageAggregateData;
}

const productionMcpUsageDashboardPort: McpUsageDashboardPort = {
  listCatalog: listMcpToolCatalog,
  loadAggregate: getMcpUsageAggregateData,
};

type McpToolCatalog = Awaited<ReturnType<typeof listMcpToolCatalog>>;
type McpUsageAggregate = Awaited<ReturnType<typeof getMcpUsageAggregateData>>;
type McpCatalogTool = McpToolCatalog["tools"][number];
type McpLifetimeUsage = McpUsageAggregate["lifetimeTools"][number];
type McpPeriodUsage = McpUsageAggregate["periodTools"][number];

const toolUsageStatus = (
  registered: boolean,
  hasLifetimeUsage: boolean,
  periodCalls: number,
): McpToolUsageStatus => {
  if (!registered) return "retired";
  if (!hasLifetimeUsage) return "never";
  return periodCalls > 0 ? "active" : "inactive";
};

const catalogFields = (definition: McpCatalogTool | undefined) => ({
  title: definition?.title ?? null,
  description: definition?.description ?? null,
  inputSchema: definition?.inputSchema ?? null,
  outputSchema: definition?.outputSchema ?? null,
  annotations: definition?.annotations
    ? {
        readOnlyHint: definition.annotations.readOnlyHint,
        destructiveHint: definition.annotations.destructiveHint,
        idempotentHint: definition.annotations.idempotentHint,
        openWorldHint: definition.annotations.openWorldHint,
      }
    : null,
});

const usageFields = (
  lifetime: McpLifetimeUsage | undefined,
  period: McpPeriodUsage | undefined,
) => ({
  lifetimeCalls: lifetime?.calls ?? 0,
  periodCalls: period?.calls ?? 0,
  periodSuccesses: period?.successes ?? 0,
  periodErrors: period?.errors ?? 0,
  firstUsedAt: lifetime?.firstUsedAt ?? null,
  lastUsedAt: lifetime?.lastUsedAt ?? null,
  lastRelease: lifetime?.lastRelease ?? null,
});

function buildToolUsageRows(
  catalog: McpToolCatalog,
  usage: McpUsageAggregate,
): McpUsageDashboardOut["tools"] {
  const registeredNames = new Set(catalog.tools.map((tool) => tool.name));
  const catalogByTool = new Map(catalog.tools.map((tool) => [tool.name, tool]));
  const lifetimeByTool = new Map(
    usage.lifetimeTools.map((row) => [row.toolName, row]),
  );
  const periodByTool = new Map(
    usage.periodTools.map((row) => [row.toolName, row]),
  );
  const usersByTool = groupBy(usage.toolUsers, (row) => row.toolName);
  const clientsByTool = groupBy(usage.toolClients, (row) => row.toolName);
  const dailyByTool = groupBy(usage.daily, (row) => row.toolName);
  const allNames = new Set([...registeredNames, ...lifetimeByTool.keys()]);

  return [...allNames]
    .map((toolName) => {
      const registered = registeredNames.has(toolName);
      const definition = catalogByTool.get(toolName);
      const lifetime = lifetimeByTool.get(toolName);
      const period = periodByTool.get(toolName);
      const metrics = usageFields(lifetime, period);
      return {
        toolName,
        ...catalogFields(definition),
        ...metrics,
        status: toolUsageStatus(
          registered,
          lifetime !== undefined,
          metrics.periodCalls,
        ),
        registered,
        daily: (dailyByTool[toolName] ?? []).map(
          ({ day, success, error, total }) => ({ day, success, error, total }),
        ),
        users: (usersByTool[toolName] ?? []).map(({ id, name, email }) => ({
          id,
          name,
          email,
        })),
        clients: (clientsByTool[toolName] ?? []).map(({ id, name }) => ({
          id,
          name: id === "cubby-agent" ? "Cubby in-app agent" : name,
        })),
      };
    })
    .sort(
      (a, b) =>
        b.periodCalls - a.periodCalls || a.toolName.localeCompare(b.toolName),
    );
}

export async function getMcpUsageDashboard(
  db: Database,
  window: McpUsageWindow,
  port: McpUsageDashboardPort = productionMcpUsageDashboardPort,
): Promise<McpUsageDashboardOut> {
  const [catalog, usage] = await Promise.all([
    port.listCatalog(),
    port.loadAggregate(db, window),
  ]);
  const registeredNames = new Set(catalog.tools.map((tool) => tool.name));
  const tools = buildToolUsageRows(catalog, usage);

  const totals = {
    registered: registeredNames.size,
    active: tools.filter((tool) => tool.status === "active").length,
    inactive: tools.filter((tool) => tool.status === "inactive").length,
    never: tools.filter((tool) => tool.status === "never").length,
    retired: tools.filter((tool) => tool.status === "retired").length,
    calls: sumBy(usage.periodTools, (row) => row.calls),
    errors: sumBy(usage.periodTools, (row) => row.errors),
  };
  const since = mcpUsageSince(window);
  const dailyByDay = groupBy(usage.daily, (row) => row.day);

  return {
    window,
    observationStartedAt: usage.observationStartedAt,
    observationComplete:
      window === "lifetime" ||
      (!!usage.observationStartedAt &&
        !!since &&
        usage.observationStartedAt <= since),
    totals,
    daily: Object.entries(dailyByDay).map(([day, rows]) => ({
      day,
      success: sumBy(rows, (row) => row.success),
      error: sumBy(rows, (row) => row.error),
      total: sumBy(rows, (row) => row.total),
    })),
    tools,
    users: usage.userBreakdown,
    clients: usage.clientBreakdown,
    surfaces: usage.surfaceBreakdown,
    entities: usage.entityBreakdown,
  };
}
