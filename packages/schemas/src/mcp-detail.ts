import { z } from "zod";

export const mcpResultDetail = z
  .enum(["summary", "full"])
  .default("summary")
  .describe(
    "How much record detail to return. 'summary' returns identity and relevant status; 'full' returns the complete MCP projection.",
  );

export const mcpResultDetailFields = { resultDetail: mcpResultDetail };
export type McpResultDetail = z.output<typeof mcpResultDetail>;
