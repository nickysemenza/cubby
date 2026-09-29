import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ListToolsRequestSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { type JSONType, z } from "zod";

import { advertisedJsonSchema } from "./tool-json-schema";

type JsonObject = Extract<JSONType, { [key: string]: JSONType }>;

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

export interface DeclaredToolSchemas {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: z.ZodType;
  readonly outputSchema?: z.core.$ZodType;
}

/**
 * Every registered, enabled tool's declared input/output schema — the same
 * resolution `installMockStrippedListToolsHandler` advertises as JSON Schema,
 * one level up: `outputSchema` is the precise schema `declareToolOutputSchema`
 * recorded, falling back to the SDK's own (possibly object-widened, see
 * `sdkOutputSchema`) registration when nothing was declared. Used by tests
 * that need every registered tool's real Zod schemas, e.g. a `toWire` parity
 * check across the whole catalog.
 */
export function listDeclaredToolSchemas(
  server: McpServer,
): readonly DeclaredToolSchemas[] {
  const registeredTools = getRegisteredTools(server);
  return Object.entries(registeredTools)
    .filter(([, tool]) => tool.enabled)
    .map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema:
        declaredOutputSchemas.get(server)?.get(name) ?? tool.outputSchema,
    }));
}

const declaredInputJsonSchemas = new WeakMap<
  McpServer,
  Map<string, JsonObject>
>();

/**
 * The published input JSON Schema of a multi-action tool. Its SDK-registered
 * input is a loose `{ action }` object (the per-action schemas are parsed by
 * the tool itself), so the precise document is declared here instead.
 */
export function declareToolInputJsonSchema(
  server: McpServer,
  name: string,
  schema: JsonObject,
): void {
  const existing = declaredInputJsonSchemas.get(server);
  if (existing) {
    existing.set(name, schema);
    return;
  }
  declaredInputJsonSchemas.set(server, new Map([[name, schema]]));
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

/**
 * Per-caller view of one tool: a replacement description and input schema,
 * `null` to hide the tool, or undefined to publish it unchanged.
 */
export type ToolCatalogView = (
  name: string,
) => { description: string; inputSchema: JsonObject } | null | undefined;

/**
 * Installs the catalog adapter that strips fixture-only JSON Schema metadata.
 * `narrow` may return a view for the calling principal (the purchase agent
 * sees only its run's actions).
 */
export function installMockStrippedListToolsHandler(
  server: McpServer,
  narrow?: (
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ) => Promise<ToolCatalogView | undefined>,
): void {
  const registeredTools = getRegisteredTools(server);

  server.server.setRequestHandler(ListToolsRequestSchema, async (_, extra) => {
    const view = narrow ? await narrow(extra) : undefined;
    return ListToolsResultSchema.parse({
      tools: listDeclaredToolSchemas(server).flatMap(
        ({ name, inputSchema, outputSchema }) => {
          const tool = registeredTools[name];
          const narrowed = view ? view(name) : undefined;
          if (narrowed === null) return [];
          return [
            {
              name,
              title: tool?.title,
              description: narrowed?.description ?? tool?.description,
              inputSchema:
                narrowed?.inputSchema ??
                declaredInputJsonSchemas.get(server)?.get(name) ??
                advertisedJsonSchema(name, inputSchema, "input"),
              annotations: tool?.annotations,
              outputSchema: outputSchema
                ? outputJsonSchema(name, outputSchema)
                : undefined,
              _meta: tool?._meta,
            },
          ];
        },
      ),
    });
  });
}

const outputJsonSchemas = new WeakMap<z.core.$ZodType, JsonObject>();

/** Output schemas are static per isolate; the largest serializes to megabytes. */
function outputJsonSchema(name: string, schema: z.core.$ZodType): JsonObject {
  const cached = outputJsonSchemas.get(schema);
  if (cached) return cached;
  const json = advertisedJsonSchema(name, schema, "output");
  outputJsonSchemas.set(schema, json);
  return json;
}
