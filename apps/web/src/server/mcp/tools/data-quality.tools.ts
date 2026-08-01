import {
  clearDataExceptionInput,
  dataQuality,
  setDataExceptionInput,
} from "@cubby/schemas/data-quality";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCaller, registerMcpTool, WRITE_CLOSED } from "./_shared";

export function registerDataQualityTools(server: McpServer) {
  registerMcpTool(server, {
    name: "set_data_exception",
    description:
      "Record explicit negative knowledge for one Purchase or Product completeness check. The note is required and should explain why the fact was not issued, is unavailable/not applicable, lacks sufficient detail, or why a mismatch is expected. Upserts by check without creating duplicates and returns the newly computed dataQuality summary. Use only after available sources have been searched.",
    inputSchema: setDataExceptionInput,
    outputSchema: dataQuality,
    annotations: WRITE_CLOSED,
    handler: (params, extra) =>
      getCaller(extra).dataQuality.setException(params),
  });

  registerMcpTool(server, {
    name: "clear_data_exception",
    description:
      "Clear exactly one explicit Purchase or Product data exception and return the newly computed dataQuality summary. Any still-missing fact immediately reappears as a gap.",
    inputSchema: clearDataExceptionInput,
    outputSchema: dataQuality,
    annotations: WRITE_CLOSED,
    handler: (params, extra) =>
      getCaller(extra).dataQuality.clearException(params),
  });
}
