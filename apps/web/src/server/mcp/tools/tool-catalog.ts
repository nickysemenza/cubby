import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import {
  ListToolsRequestSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { advertisedJsonSchema } from "./tool-json-schema";

export type SdkRegisteredTool = {
  title?: string;
  description?: string;
  inputSchema?: z.ZodType;
  outputSchema?: z.ZodType;
  annotations?: ToolAnnotations;
  _meta?: object;
  enabled: boolean;
};

type SdkToolRegistry = { [toolName: string]: SdkRegisteredTool };
type SdkServerWithTools = { _registeredTools: SdkToolRegistry };
interface SdkServerCandidate {}

const declaredOutputSchemas = new WeakMap<
  McpServer,
  Map<string, z.core.$ZodType>
>();

function hasRegisteredTools(
  value: SdkServerCandidate,
): value is SdkServerWithTools {
  return "_registeredTools" in value;
}

/** Reads the SDK's private registry through one guarded adapter. */
function getRegisteredTools(server: McpServer): SdkToolRegistry {
  const candidate: object = server;
  if (!hasRegisteredTools(candidate)) {
    throw new Error("MCP SDK registered-tool storage is unavailable");
  }
  return candidate._registeredTools;
}

/** @internal Test and telemetry helper for SDK registration metadata. */
export function getRegisteredTool(
  server: McpServer,
  name: string,
): SdkRegisteredTool | undefined {
  return getRegisteredTools(server)[name];
}

/** Keeps the precise output contract when the SDK needs an object fallback. */
export function declareToolOutputSchema(
  server: McpServer,
  name: string,
  outputSchema: z.core.$ZodType,
): void {
  const existing = declaredOutputSchemas.get(server);
  if (existing) {
    existing.set(name, outputSchema);
    return;
  }
  declaredOutputSchemas.set(server, new Map([[name, outputSchema]]));
}

/** Installs the catalog adapter that strips fixture-only JSON Schema metadata. */
export function installMockStrippedListToolsHandler(server: McpServer): void {
  const registeredTools = getRegisteredTools(server);

  server.server.setRequestHandler(ListToolsRequestSchema, () =>
    ListToolsResultSchema.parse({
      tools: Object.entries(registeredTools)
        .filter(([, tool]) => tool.enabled)
        .map(([name, tool]) => {
          const outputSchema =
            declaredOutputSchemas.get(server)?.get(name) ?? tool.outputSchema;
          return {
            name,
            title: tool.title,
            description: tool.description,
            inputSchema: advertisedJsonSchema(name, tool.inputSchema, "input"),
            annotations: tool.annotations,
            outputSchema: outputSchema
              ? advertisedJsonSchema(name, outputSchema, "output")
              : undefined,
            _meta: tool._meta,
          };
        }),
    }),
  );
}
