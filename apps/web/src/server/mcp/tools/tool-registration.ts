import { mcpAppResourceUriForTool } from "@cubby/mcp-apps/metadata";
import type {
  McpServer,
  ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { toPublicErrorPayload } from "~/server/errors/app-error";
import { parseMcpWorkflowCaller } from "~/server/mcp/caller-contract";
import type { McpWorkflowCaller } from "~/server/mcp/workflow-caller";

import { declareToolOutputSchema } from "./tool-catalog";
import { requireObjectInputSchema, sdkOutputSchema } from "./tool-json-schema";

export type Caller = McpWorkflowCaller;
type ToolErrorCode = NonNullable<
  ReturnType<typeof toPublicErrorPayload>["code"]
>;

const toolArgumentsSchema = z.looseObject({});
const structuredContentSchema = z.looseObject({});
const emptyInputSchema = z.object({});

export type ToolArguments = z.output<typeof toolArgumentsSchema>;
export type ToolEntityExtractor = (params: ToolArguments) => string | undefined;
export type ToolExtra = Parameters<ToolCallback<typeof emptyInputSchema>>[1];
type StructuredContent = z.output<typeof structuredContentSchema>;
export type StructuredOutputSchema = z.core.$ZodType<StructuredContent>;

type ToolHandler<
  TInput extends z.ZodObject,
  TOutput extends StructuredOutputSchema,
> = (params: z.output<TInput>, extra: ToolExtra) => Promise<z.output<TOutput>>;

type RegisterMcpToolConfig<
  TInput extends z.ZodObject,
  TOutput extends StructuredOutputSchema,
> = {
  name: string;
  description: string;
  title?: string;
  inputSchema: TInput;
  outputSchema: TOutput;
  annotations: ToolAnnotations;
  handler: ToolHandler<TInput, TOutput>;
  telemetryEntity?: (params: z.output<TInput>) => string | undefined;
};

const toolEntityExtractors = new WeakMap<
  McpServer,
  Map<string, ToolEntityExtractor>
>();

function declareToolEntityExtractor<TInput extends z.ZodObject>(
  server: McpServer,
  name: string,
  inputSchema: TInput,
  extract: (params: z.output<TInput>) => string | undefined,
): void {
  const guardedExtractor = (params: ToolArguments) =>
    extract(z.parse(inputSchema, params));
  const existing = toolEntityExtractors.get(server);
  if (existing) {
    existing.set(name, guardedExtractor);
    return;
  }
  toolEntityExtractors.set(server, new Map([[name, guardedExtractor]]));
}

export function getToolEntityExtractor(
  server: McpServer,
  name: string,
): ToolEntityExtractor | undefined {
  return toolEntityExtractors.get(server)?.get(name);
}

function uiToolMeta(toolName: string) {
  const resourceUri = mcpAppResourceUriForTool(toolName);
  if (!resourceUri) return undefined;
  // MCP Apps clients read the nested pointer; keep the legacy alias for older
  // hosts while both forms are emitted from this one registration seam.
  return { ui: { resourceUri }, "ui/resourceUri": resourceUri };
}

export const READ_ONLY_CLOSED: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const READ_ONLY_OPEN: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const WRITE_CLOSED: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export const WRITE_DESTRUCTIVE_CLOSED: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

function structuredSuccess<TOutput extends StructuredOutputSchema>(
  data: z.output<TOutput>,
  outputSchema: TOutput,
): CallToolResult {
  const parsed = z.parse(outputSchema, data);
  return {
    structuredContent: parsed,
    content: [{ type: "text", text: JSON.stringify(parsed) }],
  };
}

/**
 * Refusal details stay in `_meta`, not `structuredContent`. The reference SDK
 * validates structured content against the success schema even for `isError`,
 * so putting `{code, reason}` there makes an ordinary refusal throw McpError.
 */
function structuredError<T>(error: T): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: "text", text: formatToolError(error) }],
    isError: true,
  };
  const meta = toolErrorMeta(error);
  if (meta) result._meta = meta;
  return result;
}

const ERROR_META_KEY = "cubby/error";

function toolErrorMeta<T>(error: T) {
  const payload = toPublicErrorPayload(error);
  if (!payload.code && !payload.reason && !payload.blockers) return undefined;
  return { [ERROR_META_KEY]: payload };
}

export interface ToolErrorDetail {
  code?: ToolErrorCode;
  reason?: string;
  message: string;
}

export function describeToolError<T>(error: T): ToolErrorDetail {
  const { code, reason } = toPublicErrorPayload(error);
  const message = error instanceof Error ? error.message : String(error);
  const detail: ToolErrorDetail = { message };
  if (code) detail.code = code;
  if (reason) detail.reason = reason;
  return detail;
}

function formatToolError<T>(error: T): string {
  const { code, reason, message } = describeToolError(error);
  if (!code) return message;
  return reason ? `${code}: ${message} (${reason})` : `${code}: ${message}`;
}

function callerFromExtra(
  extra: ToolExtra,
  key: "caller" | "readCaller",
): Caller | undefined {
  const candidate = extra.authInfo?.extra?.[key];
  return candidate === undefined
    ? undefined
    : parseMcpWorkflowCaller(candidate);
}

export function getCaller(extra: ToolExtra): Caller {
  const caller = callerFromExtra(extra, "caller");
  if (!caller) throw new Error("Authenticated workflow caller is missing");
  return caller;
}

export function getReadCaller(extra: ToolExtra): Caller {
  return callerFromExtra(extra, "readCaller") ?? getCaller(extra);
}

export function registerMcpTool<
  TInput extends z.ZodObject,
  TOutput extends StructuredOutputSchema,
>(server: McpServer, config: RegisterMcpToolConfig<TInput, TOutput>): void {
  const inputSchema = requireObjectInputSchema(config.name, config.inputSchema);
  if (config.telemetryEntity) {
    declareToolEntityExtractor(
      server,
      config.name,
      inputSchema,
      config.telemetryEntity,
    );
  }
  declareToolOutputSchema(server, config.name, config.outputSchema);

  const callback = async (
    params: ToolArguments,
    extra: ToolExtra,
  ): Promise<CallToolResult> => {
    try {
      const parsedParams = z.parse(inputSchema, params);
      const result = await config.handler(parsedParams, extra);
      return structuredSuccess(result, config.outputSchema);
    } catch (error) {
      return structuredError(error);
    }
  };

  server.registerTool(
    config.name,
    {
      title: config.title,
      description: config.description,
      inputSchema,
      outputSchema: sdkOutputSchema(config.outputSchema),
      annotations: config.annotations,
      _meta: uiToolMeta(config.name),
    },
    // SAFETY: the SDK's conditional ToolCallback type does not reduce for the
    // generic TInput. This callback accepts the broader SDK argument bag, parses
    // it through this exact inputSchema, preserves ToolExtra, and returns the
    // required CallToolResult in every branch.
    callback as ToolCallback<TInput>,
  );
}
