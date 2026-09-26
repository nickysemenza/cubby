import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

import type { ReadPolicy } from "~/server/read-policy";

import {
  getRequestContext,
  type McpRequestContext,
  registerMcpTool,
  type StructuredOutputSchema,
  type ToolExtra,
} from "./tool-registration";

export function registerRouterTool<
  TInput extends z.ZodObject,
  TOutput extends StructuredOutputSchema,
>(
  server: McpServer,
  config: {
    name: string;
    description: string;
    inputSchema: TInput;
    outputSchema: TOutput;
    annotations: ToolAnnotations;
    telemetryEntity?: (params: z.output<TInput>) => string | undefined;
    readPolicy?: (params: z.output<TInput>) => ReadPolicy;
    call: (
      context: McpRequestContext,
      params: z.output<TInput>,
      extra: ToolExtra,
    ) => Promise<z.output<TOutput>>;
  },
): void {
  registerMcpTool(server, {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    annotations: config.annotations,
    telemetryEntity: config.telemetryEntity,
    readPolicy: config.readPolicy,
    handler: async (params, extra) =>
      config.call(getRequestContext(extra), params, extra),
  });
}
