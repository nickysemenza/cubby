import type {
  mcpUsageActivityInput,
  mcpUsageDashboardInput,
} from "@cubby/schemas/telemetry";
import type { z } from "zod";
import type { Database } from "~/server/db";
import { listMcpUsageActivity } from "~/server/repo/mcp-usage";
import { getMcpUsageDashboard } from "~/server/services/mcp-usage.service";

export const listMcpCatalogWorkflow = async () => {
  const { listMcpToolCatalog, MCP_SERVER_INSTRUCTIONS } = await import(
    "~/server/mcp/server"
  );
  const catalog = await listMcpToolCatalog();
  return { ...catalog, instructions: MCP_SERVER_INSTRUCTIONS };
};

export const getMcpUsageDashboardWorkflow = (
  db: Database,
  input: z.output<typeof mcpUsageDashboardInput>,
) => getMcpUsageDashboard(db, input.window);

export const listMcpUsageActivityWorkflow = (
  db: Database,
  input: z.output<typeof mcpUsageActivityInput>,
) => listMcpUsageActivity(db, input);
