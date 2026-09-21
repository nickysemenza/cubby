import { mcpAppResourceUriForTool } from "@cubby/mcp-apps/metadata";
import { purchaseImportRunExecution } from "@cubby/schemas/purchase-import";
import type {
  McpServer,
  ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { scheduleCalendarFeedDirty } from "~/server/calendar/client";
import { recordDatabaseWrite } from "~/server/database-freshness/client";
import { importRun } from "~/server/db/schema";
import { toPublicErrorPayload } from "~/server/errors/app-error";
import {
  errorReportingHeaders,
  withErrorReporting,
} from "~/server/errors/report-error";
import { parseMcpWorkflowCaller } from "~/server/mcp/caller-contract";
import { getEntityKernelContext } from "~/server/mcp/kernel-context";
import { McpOperationContext } from "~/server/mcp/operation-context";
import {
  decoratePurchaseAgentInputSchema,
  executePurchaseAgentMutation,
  trustedPurchaseAgent,
} from "~/server/mcp/purchase-agent-protocol";
import type { McpWorkflowCaller } from "~/server/mcp/workflow-caller";
import {
  assertImportRunCapabilityById,
  capabilityForPurchaseAgentTool,
} from "~/server/purchase-import/capabilities";
import type { ReadPolicy } from "~/server/read-policy";
import { getDb } from "~/server/repo/database-helpers";
import { publicStartOperationErrorSchema } from "~/server/start-operation.contract";
import {
  normalizeStartOperationError,
  type OperationFailureContext,
  type OperationStage,
} from "~/server/start-operation.server";
import { getRequestId } from "~/server/tracing";

import { declareToolOutputSchema } from "./tool-catalog";
import { requireObjectInputSchema, sdkOutputSchema } from "./tool-json-schema";

export type Caller = McpWorkflowCaller;

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
  /** Explicit exceptions shared with Start-operation read policy. */
  readPolicy?: (params: z.output<TInput>) => ReadPolicy;
  /**
   * A small number of tools carry both reads and writes in one public schema.
   * Their parsed input, rather than the broad SDK annotation, decides whether
   * this execution needs the authoritative database and advances freshness.
   */
  isMutation?: (params: z.output<TInput>) => boolean;
  /** Batch registration enforces the purchase-agent protocol per item. */
  purchaseAgentMutationHandled?: boolean;
};

export interface McpToolRegistrationRuntime {
  markCalendarDirty(reason: string): void;
  recordDatabaseWrite?(source: string): Promise<void>;
}

const productionMcpToolRegistrationRuntime: McpToolRegistrationRuntime = {
  markCalendarDirty: (reason) => scheduleCalendarFeedDirty(reason),
  recordDatabaseWrite,
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
function structuredError<T>(
  error: T,
  context: OperationFailureContext,
  stage: OperationStage,
): CallToolResult {
  const detail = describeToolError(error, context, stage);
  return {
    content: [
      {
        type: "text",
        text: `${formatToolError(detail)}\n\n${JSON.stringify(detail)}`,
      },
    ],
    isError: true,
    _meta: { "cubby/error": detail },
  };
}

export const toolErrorDetailSchema = publicStartOperationErrorSchema.partial({
  code: true,
});
export type ToolErrorDetail = z.infer<typeof toolErrorDetailSchema>;

export function describeToolError<T>(
  error: T,
  context?: OperationFailureContext,
  stage: OperationStage = "run",
): ToolErrorDetail {
  if (context) {
    const headers = context.headers ?? errorReportingHeaders();
    const detail = normalizeStartOperationError(
      error,
      stage,
      getRequestId(headers),
      {
        ...context,
        headers,
      },
    ).publicError;
    const payload = toPublicErrorPayload(error);
    if (payload.code) {
      detail.code = payload.code;
      detail.reason = payload.reason;
      if (payload.blockers && context.authenticated)
        detail.blockers = payload.blockers;
    }
    return detail;
  }
  const { code, reason } = toPublicErrorPayload(error);
  const message = error instanceof Error ? error.message : String(error);
  const detail: ToolErrorDetail = { message };
  if (code) detail.code = code;
  if (reason) detail.reason = reason;
  return detail;
}

function formatToolError({ code, reason, message }: ToolErrorDetail): string {
  if (!code) return message;
  return reason ? `${code}: ${message} (${reason})` : `${code}: ${message}`;
}

function callerFromExtra(extra: ToolExtra, key: "caller"): Caller | undefined {
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

export function operationContextFromExtra(
  extra: ToolExtra,
): McpOperationContext | undefined {
  const candidate = extra.authInfo?.extra?.operationContext;
  return candidate instanceof McpOperationContext ? candidate : undefined;
}

async function prepareToolExtra(
  extra: ToolExtra,
  policy: ReadPolicy,
): Promise<ToolExtra> {
  const operationContext = operationContextFromExtra(extra);
  if (!operationContext || !extra.authInfo) return extra;
  const prepared = await operationContext.prepare(policy);
  return {
    ...extra,
    authInfo: {
      ...extra.authInfo,
      extra: { ...extra.authInfo?.extra, ...prepared },
    },
  };
}

export function registerMcpTool<
  TInput extends z.ZodObject,
  TOutput extends StructuredOutputSchema,
>(
  server: McpServer,
  config: RegisterMcpToolConfig<TInput, TOutput>,
  runtime: McpToolRegistrationRuntime = productionMcpToolRegistrationRuntime,
): void {
  const inputSchema = requireObjectInputSchema(config.name, config.inputSchema);
  const registeredInputSchema = decoratePurchaseAgentInputSchema(inputSchema);
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
  ): Promise<CallToolResult> =>
    // eslint-disable-next-line complexity -- Registration centralizes auth, capability, approval, telemetry, and error contracts.
    withErrorReporting(async () => {
      let stage: OperationStage = "input";
      let entity: string | undefined;
      let mutation = false;
      let enteredHandler = false;
      try {
        const parsedParams = z.parse(inputSchema, params);
        entity = config.telemetryEntity?.(parsedParams);
        stage = "context";
        mutation =
          config.isMutation?.(parsedParams) ??
          config.annotations.readOnlyHint !== true;
        const configuredReadPolicy = config.readPolicy?.(parsedParams);
        const preparedExtra = await prepareToolExtra(
          extra,
          mutation ? "strong" : (configuredReadPolicy ?? "context"),
        );
        enteredHandler = true;
        const trusted = trustedPurchaseAgent(preparedExtra);
        const operationContext = operationContextFromExtra(preparedExtra);
        if (trusted) {
          const capability = capabilityForPurchaseAgentTool(
            config.name,
            mutation,
          );
          if (capability) {
            const parsedKernel = getEntityKernelContext(preparedExtra);
            await assertImportRunCapabilityById(
              parsedKernel.db,
              trusted.runId,
              capability,
            );
          }
        }
        const autoAllowedPurchaseImportTool =
          config.name === "prepare_purchase_import" ||
          config.name === "commit_purchase_import" ||
          config.purchaseAgentMutationHandled === true;
        if (trusted && mutation && autoAllowedPurchaseImportTool) {
          const execution = z
            .object({ _runExecution: purchaseImportRunExecution })
            .parse(params)._runExecution;
          const parsedKernel = getEntityKernelContext(preparedExtra);
          const [delegatedRun] = await getDb(parsedKernel.db)
            .select({ publicId: importRun.publicId })
            .from(importRun)
            .where(eq(importRun.id, trusted.runId))
            .limit(1);
          if (delegatedRun?.publicId !== execution.runPublicId)
            throw new Error(
              "Purchase-agent run execution does not match its delegation",
            );
        }
        stage = "run";
        const result =
          trusted && mutation && !autoAllowedPurchaseImportTool
            ? await (async () => {
                if (!operationContext)
                  throw new Error(
                    "Purchase-agent operation context is missing",
                  );
                const execution = z
                  .object({ _runExecution: purchaseImportRunExecution })
                  .parse(params)._runExecution;
                const parsedKernel = getEntityKernelContext(preparedExtra);
                return executePurchaseAgentMutation({
                  db: parsedKernel.db,
                  actor: parsedKernel.actorContext,
                  operationContext,
                  trusted,
                  toolName: config.name,
                  args: parsedParams,
                  execution,
                  run: (transactionExtra) =>
                    config.handler(parsedParams, transactionExtra),
                  baseExtra: preparedExtra,
                });
              })()
            : await config.handler(parsedParams, preparedExtra);
        stage = "output";
        const response = structuredSuccess(result, config.outputSchema);
        if (mutation) {
          runtime.markCalendarDirty(`mcp.${config.name}`);
        }
        return response;
      } catch (error) {
        return structuredError(
          error,
          {
            operation: config.name,
            authenticated: extra.authInfo !== undefined,
            entity,
          },
          stage,
        );
      } finally {
        // A tool can commit before later validation or another item in a batch
        // fails. Advancing the shared window here keeps every client strong for
        // that possible partial write without turning a committed response into
        // an error when the Durable Object is unavailable.
        if (enteredHandler && mutation) {
          await runtime.recordDatabaseWrite?.(`mcp.${config.name}`);
        }
      }
    });

  server.registerTool(
    config.name,
    {
      title: config.title,
      description: config.description,
      // SAFETY: decoration preserves the original object shape and only makes
      // the trusted purchase-agent execution envelope available to the SDK.
      inputSchema: registeredInputSchema as TInput,
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
