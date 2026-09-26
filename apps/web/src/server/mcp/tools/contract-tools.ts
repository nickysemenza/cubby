import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpToolSpec, OperationContract } from "~/contracts/define";
import type { DirectOperationRun } from "~/server/operation-domain.server";
import { readPolicyFor } from "~/server/read-policy";

import {
  getRequestContext,
  READ_ONLY_CLOSED,
  READ_ONLY_OPEN,
  registerMcpTool,
  type StructuredOutputSchema,
  WRITE_CLOSED,
  WRITE_DESTRUCTIVE_CLOSED,
} from "./tool-registration";

/** Contract outputs published as MCP tools are object-rooted. */
const structuredResult = z.looseObject({});

function annotationsFor(kind: "query" | "mutation", mcp: McpToolSpec) {
  if (kind === "query")
    return mcp.openWorld ? READ_ONLY_OPEN : READ_ONLY_CLOSED;
  return mcp.destructive ? WRITE_DESTRUCTIVE_CLOSED : WRITE_CLOSED;
}

/**
 * Register every `mcp`-flagged member of an implemented contract as a tool
 * that calls the same handler the browser and HTTP transports run.
 */
export function registerContractTools(
  server: McpServer,
  domain: {
    readonly contract: OperationContract;
    readonly runs: Readonly<Record<string, DirectOperationRun>>;
  },
): void {
  for (const [member, op] of Object.entries(domain.contract.ops)) {
    if (op.kind === "subscription" || !op.mcp) continue;
    const { mcp, kind } = op;
    const operation = domain.runs[member];
    if (!operation)
      throw new Error(`${domain.contract.domain}.${member} has no handler`);
    if (!(operation.input instanceof z.ZodObject))
      throw new Error(`${mcp.name}: contract input must be an object schema`);
    registerMcpTool(server, {
      name: mcp.name,
      description: mcp.description,
      inputSchema: operation.input,
      // SAFETY: the handler below rejects a non-object result, and the
      // registration parse validates it against this exact schema.
      outputSchema: operation.output as StructuredOutputSchema,
      annotations: annotationsFor(kind, mcp),
      readPolicy: () => mcp.readPolicy ?? readPolicyFor(operation.id, kind),
      handler: async (params, extra) => {
        const result = await operation.run(
          { ...getRequestContext(extra), signal: extra.signal },
          params,
        );
        return structuredResult.parse(result);
      },
    });
  }
}
