import type { AgentToolCall } from "@cubby/schemas/agent";
import { type Tool, toolDefinition } from "@tanstack/ai";
import { getErrorMessage } from "~/lib/error-utils";
import type { DomainCaller } from "~/server/api/domain";

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
  result: unknown;
};

interface AgentToolset {
  tools: Tool[];
  /** Mutated in place as the agent loop calls tools. */
  records: ToolCallRecord[];
  close: () => Promise<void>;
}

/**
 * Build the read-only agent toolset bound to an authenticated tRPC caller.
 * The caller is injected into every MCP message via authInfo, mirroring how
 * `api/mcp.ts` passes `extra: { caller }` over HTTP.
 */
export async function createAgentToolset(
  caller: DomainCaller,
): Promise<AgentToolset> {
  // Imported dynamically, not at module scope. This module hangs off the tRPC
  // router graph (root.ts → routers/agent.ts → runtime.ts → here), so a static
  // import would put @modelcontextprotocol/sdk + ajv + zod-to-json-schema
  // (~466 KiB) into the worker's eager chunk for every request — and defeat the
  // `await import()` that routes/api/mcp.ts already uses for the same module.
  const [{ Client }, { InMemoryTransport }, { createMcpServer }] =
    await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/inMemory.js"),
      import("~/server/mcp/server"),
    ]);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  // The MCP Client doesn't set authInfo on outgoing requests, so wrap the
  // client transport's send to attach the caller on every message.
  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: {
        token: "",
        clientId: "cubby-agent",
        scopes: [],
        extra: { caller },
      },
    });

  const server = createMcpServer();
  const client = new Client({ name: "cubby-agent", version: "1.0.0" });

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
        inputSchema: mcpTool.inputSchema as Record<string, unknown>,
      }).server(async (rawArgs) => {
        const args = (rawArgs ?? {}) as Record<string, unknown>;
        const startedAt = Date.now();
        let ok = true;
        let text = "";
        let parsed: unknown = null;

        try {
          const res = await client.callTool({
            name: mcpTool.name,
            arguments: args,
          });
          ok = res.isError !== true;
          if (
            ok &&
            res.structuredContent !== undefined &&
            res.structuredContent !== null
          ) {
            parsed = res.structuredContent;
            text = JSON.stringify(parsed, null, 2);
          } else {
            text = (res.content as Array<{ type: string; text?: string }>)
              .filter((c) => c.type === "text" && typeof c.text === "string")
              .map((c) => c.text)
              .join("\n");
            try {
              parsed = JSON.parse(text);
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
