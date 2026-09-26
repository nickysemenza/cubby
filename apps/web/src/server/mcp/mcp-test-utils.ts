import type {
  McpTelemetryIdentity,
  McpToolCallTelemetry,
} from "@cubby/schemas/telemetry";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { EntityKernelContext } from "~/server/entity-kernel";
import type { McpOperationContext } from "~/server/mcp/operation-context";

import type {
  McpRequestContext,
  ToolArguments,
} from "./tools/tool-registration";

/** Only the members a tool under test reads; absent handles stay null. */
export type McpTestRequestContext = {
  [Key in keyof McpRequestContext]?: McpRequestContext[Key] | null;
};

type McpTestEntityKernelContext = {
  [Key in keyof EntityKernelContext]: EntityKernelContext[Key] | null;
};

interface ToolCallExtra {
  entityKernel?: McpTestEntityKernelContext;
  operationContext?: McpOperationContext;
  telemetry?: {
    identity: McpTelemetryIdentity;
    emit: (event: McpToolCallTelemetry) => Promise<void>;
  };
}

/** Calls a tool through the production MCP transport with a test-supplied request context. */
export async function callMcpTool(
  server: McpServer,
  toolName: string,
  args: ToolArguments,
  requestContext: McpTestRequestContext = {},
  extra: ToolCallExtra = {},
) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });

  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    send(message, {
      ...options,
      authInfo: {
        token: "",
        clientId: "test",
        scopes: [],
        extra: {
          requestContext: {
            db: null,
            readDb: null,
            actorContext: null,
            ...requestContext,
          },
          ...extra,
        },
      },
    });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    return await client.callTool({ name: toolName, arguments: args });
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}
