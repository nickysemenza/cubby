import type {
  McpToolUsageStatus,
  McpUsageDashboardOut,
  McpUsageWindow,
} from "@cubby/schemas/telemetry";
import { groupBy } from "es-toolkit";
import type { Database } from "~/server/db";
import { listMcpToolCatalog } from "~/server/mcp/server";
import {
  getMcpUsageAggregateData,
  mcpUsageSince,
} from "~/server/repo/mcp-usage";

export async function getMcpUsageDashboard(
  db: Database,
  window: McpUsageWindow,
): Promise<McpUsageDashboardOut> {
  const [catalog, usage] = await Promise.all([
    listMcpToolCatalog(),
    getMcpUsageAggregateData(db, window),
  ]);
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

  const tools = [...allNames]
    .map((toolName) => {
      const registered = registeredNames.has(toolName);
      const definition = catalogByTool.get(toolName);
      const lifetime = lifetimeByTool.get(toolName);
      const period = periodByTool.get(toolName);
      const status: McpToolUsageStatus = !registered
        ? "retired"
        : !lifetime
          ? "never"
          : period && period.calls > 0
            ? "active"
            : "inactive";
      return {
        toolName,
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
        status,
        registered,
        lifetimeCalls: lifetime?.calls ?? 0,
        periodCalls: period?.calls ?? 0,
        periodSuccesses: period?.successes ?? 0,
        periodErrors: period?.errors ?? 0,
        firstUsedAt: lifetime?.firstUsedAt ?? null,
        lastUsedAt: lifetime?.lastUsedAt ?? null,
        lastRelease: lifetime?.lastRelease ?? null,
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

  const totals = {
    registered: registeredNames.size,
    active: tools.filter((tool) => tool.status === "active").length,
    inactive: tools.filter((tool) => tool.status === "inactive").length,
    never: tools.filter((tool) => tool.status === "never").length,
    retired: tools.filter((tool) => tool.status === "retired").length,
    calls: usage.periodTools.reduce((sum, row) => sum + row.calls, 0),
    errors: usage.periodTools.reduce((sum, row) => sum + row.errors, 0),
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
      success: rows.reduce((sum, row) => sum + row.success, 0),
      error: rows.reduce((sum, row) => sum + row.error, 0),
      total: rows.reduce((sum, row) => sum + row.total, 0),
    })),
    tools,
    users: usage.userBreakdown,
    clients: usage.clientBreakdown,
    surfaces: usage.surfaceBreakdown,
  };
}
