import {
  mcpUsageActivityInput,
  mcpUsageActivityOut,
  mcpUsageDashboardInput,
  mcpUsageDashboardOut,
} from "@cubby/schemas/telemetry";
import {
  createTRPCRouter,
  protectedProcedure,
  strictOutput,
} from "~/server/api/trpc";
import {
  listMcpToolCatalog,
  MCP_SERVER_INSTRUCTIONS,
} from "~/server/mcp/server";
import { listMcpUsageActivity } from "~/server/repo/mcp-usage";
import { getMcpUsageDashboard } from "~/server/services/mcp-usage.service";

export const mcpRouter = createTRPCRouter({
  listTools: protectedProcedure.query(async () => {
    const catalog = await listMcpToolCatalog();
    return {
      ...catalog,
      instructions: MCP_SERVER_INSTRUCTIONS,
    };
  }),
  usageDashboard: protectedProcedure
    .input(mcpUsageDashboardInput)
    .output(strictOutput(mcpUsageDashboardOut))
    .query(async ({ ctx, input }) =>
      getMcpUsageDashboard(ctx.db, input.window),
    ),
  usageActivity: protectedProcedure
    .input(mcpUsageActivityInput)
    .output(strictOutput(mcpUsageActivityOut))
    .query(async ({ ctx, input }) => listMcpUsageActivity(ctx.db, input)),
});
