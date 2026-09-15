import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  type EntityKernelContext,
  entityKernelContextSchema,
} from "~/server/entity-kernel";
import type { ReadPolicy } from "~/server/read-policy";

import {
  type Caller,
  getCaller,
  registerMcpTool,
  type StructuredOutputSchema,
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
      caller: Caller,
      params: z.output<TInput>,
      context: EntityKernelContext | undefined,
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
      config.call(
        getCaller(extra),
        params,
        extra.authInfo?.extra?.entityKernel === undefined
          ? undefined
          : entityKernelContextSchema.parse(extra.authInfo.extra.entityKernel),
      ),
  });
}
