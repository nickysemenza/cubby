import { type AgentToolCall, agentToolCallSchema } from "@cubby/schemas/agent";
import type { UserId } from "@cubby/schemas/identifiers";
import type { McpTelemetryIdentity } from "@cubby/schemas/telemetry";
import { type Tool, toolDefinition } from "@tanstack/ai";
import { type JSONType, z } from "zod";

import { getErrorMessage } from "~/lib/error-utils";
import type { Database } from "~/server/db";
import type { McpWorkflowCaller } from "~/server/mcp/workflow-caller";
import { emitTelemetry } from "~/server/telemetry";

/**
 * Bridges the existing Cubby MCP server (server/mcp/server.ts) to the
 * @tanstack/ai agent loop. Instead of duplicating the 22 tool definitions,
 * we connect an in-process MCP client to the same `createMcpServer()` and
 * adapt each MCP tool into a @tanstack/ai tool. One tool surface, two
 * consumers (external clients over HTTP + the in-app agent here).
 */

// Read-only tools only for v1. The MCP server also exposes create_/update_/
// delete_ tools; the allowlist keeps the agent unable to mutate even though
// those handlers exist. Drop this filter (behind explicit UI confirmation) to
// enable writes later.
const READ_ONLY_PREFIXES = ["list_", "get_", "search_", "find_"];
export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * The serialized telemetry shape (`AgentToolCall`) plus the in-process-only
 * parsed result. Sourced from the schema so the shared fields can't drift;
 * `runtime.ts` strips `result` to produce the `AgentToolCall[]` that ships.
 */
export type ToolCallRecord = AgentToolCall & {
  /** Parsed JSON of the tool's text output, used for source extraction. */
  result: JSONType;
};

function createAgentMcpExtra(
  caller: McpWorkflowCaller | undefined,
  db: Database | undefined,
  userId: UserId | undefined,
) {
  const telemetry =
    db && userId
      ? {
          identity: {
            userId,
            clientId: "cubby-agent",
            surface: "in_app_agent",
          } satisfies McpTelemetryIdentity,
          emit: (event: Parameters<typeof emitTelemetry>[1]) =>
            emitTelemetry(db, event),
        }
      : undefined;
  return { caller, telemetry };
}

const mcpInputSchema = z.record(z.string(), z.json());
const mcpResultSchema = z.json();

interface AgentToolset {
  tools: Tool[];
  /** Mutated in place as the agent loop calls tools. */
  records: ToolCallRecord[];
  close: () => Promise<void>;
}

/**
 * Build the read-only agent toolset bound to an authenticated workflow caller.
 * The caller is injected into every MCP message via authInfo, mirroring how
 * `api/mcp.ts` passes `extra: { caller }` over HTTP.
 */
export async function createAgentToolset(
  caller?: McpWorkflowCaller,
  db?: Database,
  userId?: UserId,
): Promise<AgentToolset> {
  // Imported dynamically, not at module scope. This module hangs off the agent
  // router graph (root.ts → routers/agent.ts → runtime.ts → here), so a static
  // import would put @modelcontextprotocol/sdk + ajv + zod-to-json-schema
  // (~466 KiB) into the worker's eager chunk for every request — and defeat the
  // `await import()` that routes/api/mcp.ts already uses for the same module.
  const [
    { Client },
    { InMemoryTransport },
    { createMcpClientValidator },
    { createMcpServer },
    { CallToolResultSchema },
  ] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/inMemory.js"),
    import("~/server/mcp/validation"),
    import("~/server/mcp/server"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  // The MCP Client doesn't set authInfo on outgoing requests, so wrap the
  // client transport's send to attach the caller on every message.
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) => {
    const extra = createAgentMcpExtra(caller, db, userId);
    return originalSend(message, {
      ...options,
      authInfo: {
        token: "",
        clientId: "cubby-agent",
        scopes: [],
        extra,
      },
    });
  };

  const server = createMcpServer();
  const client = new Client(
    { name: "cubby-agent", version: "1.0.0" },
    { jsonSchemaValidator: createMcpClientValidator() },
  );

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const { tools: mcpTools } = await client.listTools();
  const records: ToolCallRecord[] = [];

  const tools: Tool[] = mcpTools
    .filter((mcpTool) => isReadOnlyTool(mcpTool.name))
    .map((mcpTool) =>
      toolDefinition({
        name: mcpTool.name,
        description: mcpTool.description ?? mcpTool.name,
        // MCP inputSchema is already a JSON Schema object; toolDefinition
        // accepts plain JSON Schema.
        inputSchema: mcpInputSchema.parse(mcpTool.inputSchema),
      }).server(async (rawArgs) => {
        const args = agentToolCallSchema.shape.args.parse(rawArgs ?? {});
        const startedAt = Date.now();
        let ok = true;
        let text = "";
        let parsed: JSONType = null;

        try {
          const res = CallToolResultSchema.parse(
            await client.callTool({
              name: mcpTool.name,
              arguments: args,
            }),
          );
          ok = res.isError !== true;
          if (
            ok &&
            res.structuredContent !== undefined &&
            res.structuredContent !== null
          ) {
            parsed = mcpResultSchema.parse(res.structuredContent);
            text = JSON.stringify(parsed, null, 2);
          } else {
            text = res.content
              .filter((content) => content.type === "text")
              .map((content) => content.text)
              .join("\n");
            try {
              parsed = mcpResultSchema.parse(JSON.parse(text));
            } catch {
              parsed = text;
            }
          }
        } catch (error) {
          ok = false;
          text = getErrorMessage(error);
          parsed = text;
        }

        records.push({
          tool: mcpTool.name,
          args,
          durationMs: Date.now() - startedAt,
          ok,
          result: parsed,
        });

        // Return the same text payload the model would see over MCP.
        return text;
      }),
    );

  const close = async () => {
    await Promise.allSettled([client.close(), server.close()]);
  };

  return { tools, records, close };
}
