import type {
  McpTelemetryIdentity,
  McpToolCallTelemetry,
} from "@cubby/schemas/telemetry";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { EntityKernelContext } from "~/server/entity-kernel";

import type { ToolArguments } from "./tools/tool-registration";
import type { McpWorkflowCaller } from "./workflow-caller";

type PartialCaller<T> = T extends (...args: infer Args) => infer Result
  ? (...args: Args) => Result
  : T extends object
    ? { [Key in keyof T]?: PartialCaller<T[Key]> }
    : T;

export type McpTestCaller = PartialCaller<McpWorkflowCaller>;

type McpTestEntityKernelContext = {
  [Key in keyof EntityKernelContext]: EntityKernelContext[Key] | null;
};

interface ToolCallExtra {
  entityKernel?: McpTestEntityKernelContext;
  readCaller?: McpTestCaller;
  telemetry?: {
    identity: McpTelemetryIdentity;
    emit: (event: McpToolCallTelemetry) => Promise<void>;
  };
}

/** Calls a tool through the production MCP transport with only the caller port faked. */
export async function callMcpTool(
  server: McpServer,
  toolName: string,
  args: ToolArguments,
  caller: McpTestCaller,
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
        extra: { caller, ...extra },
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
