import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import {
  listMcpToolCatalog,
  MCP_SERVER_INSTRUCTIONS,
} from "~/server/mcp/server";

export const mcpRouter = createTRPCRouter({
  listTools: protectedProcedure.query(async () => {
    const catalog = await listMcpToolCatalog();
    return {
      ...catalog,
      instructions: MCP_SERVER_INSTRUCTIONS,
    };
  }),
});
