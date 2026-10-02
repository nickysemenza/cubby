import {
  type McpServer,
  type ServerContext,
  type CallToolRequest,
  type CallToolResult,
} from "@modelcontextprotocol/server";

export type ToolCallProtocolHandler = (
  request: CallToolRequest,
  extra: ServerContext,
) => Promise<CallToolResult>;

type SdkRequestHandlerRegistry = {
  _requestHandlers: Map<string, ToolCallProtocolHandler>;
};

interface SdkProtocolCandidate {}

function hasRequestHandlerRegistry(
  candidate: SdkProtocolCandidate,
): candidate is SdkRequestHandlerRegistry {
  return "_requestHandlers" in candidate;
}

/**
 * Replaces the SDK-installed tools/call handler through one guarded adapter.
 * The method key fixes the otherwise-private registry entry to the SDK's
 * public CallToolRequest and CallToolResult contracts.
 */
export function installToolCallProtocolHandler(
  server: McpServer,
  decorate: (
    dispatch: ToolCallProtocolHandler,
    request: CallToolRequest,
    extra: ServerContext,
  ) => Promise<CallToolResult>,
): void {
  const protocol: object = server.server;
  if (!hasRequestHandlerRegistry(protocol)) {
    throw new Error("MCP SDK request-handler storage is unavailable");
  }

  const dispatch = protocol._requestHandlers.get("tools/call");
  if (!dispatch) throw new Error("MCP tools/call handler is not installed");

  protocol._requestHandlers.set("tools/call", (request, extra) =>
    decorate(dispatch, request, extra),
  );
}
