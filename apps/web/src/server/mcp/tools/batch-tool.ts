import { mcpResultDetail } from "@cubby/schemas/mcp-detail";
import { purchaseImportRunExecution } from "@cubby/schemas/purchase-import";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { getEntityKernelContext } from "~/server/mcp/kernel-context";
import {
  executePurchaseAgentMutation,
  trustedPurchaseAgent,
} from "~/server/mcp/purchase-agent-protocol";

import {
  describeToolError,
  operationContextFromExtra,
  registerMcpTool,
  type McpToolRegistrationRuntime,
  type ToolErrorDetail,
  type ToolExtra,
  toolErrorDetailSchema,
} from "./tool-registration";

const DEFAULT_BATCH_MAX_ITEMS = 50;

type BatchResultDetail = "summary" | "full";

type BatchSuccess<TItem> = {
  index: number;
  status: "succeeded";
  reference: string;
  item?: TItem;
};

type BatchFailure = {
  index: number;
  status: "failed";
  error: ToolErrorDetail;
};

type BatchResult<TItem> = BatchSuccess<TItem> | BatchFailure;

function batchOutputSchema<TItemOutput extends z.ZodType>(
  itemOutputSchema: TItemOutput,
) {
  return z.object({
    summary: z.object({
      requested: z.number().int().nonnegative(),
      succeeded: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }),
    results: z.array(
      z.discriminatedUnion("status", [
        z.object({
          index: z.number().int().nonnegative(),
          status: z.literal("succeeded"),
          reference: z.string(),
          item: itemOutputSchema.optional(),
        }),
        z.object({
          index: z.number().int().nonnegative(),
          status: z.literal("failed"),
          error: toolErrorDetailSchema,
        }),
      ]),
    ),
  });
}

function batchResultDetailParam(fallback: BatchResultDetail) {
  return mcpResultDetail
    .default(fallback)
    .describe(
      `How much of each result to return. 'summary' gives {index, status, reference}; 'full' also includes the parsed item. This tool defaults to '${fallback}'.`,
    );
}

export function registerBatchTool<
  TItemInput extends z.ZodType,
  TItemOutput extends z.ZodType,
>(
  server: McpServer,
  config: {
    name: string;
    description: string;
    itemInputSchema: TItemInput;
    itemOutputSchema: TItemOutput;
    projectReference: (item: z.output<TItemOutput>) => string;
    maxItems?: number;
    defaultResultDetail?: BatchResultDetail;
    annotations: ToolAnnotations;
    telemetryEntity?: (params: {
      items: Array<z.output<TItemInput>>;
    }) => string | undefined;
    refineItems?: (
      items: Array<z.output<TItemInput>>,
      ctx: z.core.$RefinementCtx,
    ) => void;
    /** `extra` is the item's prepared tool extra (transactional for a trusted purchase agent). */
    run: (
      item: z.output<TItemInput>,
      extra: ToolExtra,
    ) => Promise<z.output<TItemOutput>>;
  },
  runtime?: McpToolRegistrationRuntime,
): void {
  const items = z
    .array(config.itemInputSchema)
    .min(1)
    .max(config.maxItems ?? DEFAULT_BATCH_MAX_ITEMS);
  const defaultDetail = config.defaultResultDetail ?? "summary";
  const baseInputSchema = z.strictObject({
    items,
    resultDetail: batchResultDetailParam(defaultDetail),
    _runExecution: purchaseImportRunExecution.optional(),
  });
  const inputSchema = config.refineItems
    ? baseInputSchema.superRefine((input, ctx) =>
        config.refineItems?.(input.items, ctx),
      )
    : baseInputSchema;
  const outputSchema = batchOutputSchema(config.itemOutputSchema);

  registerMcpTool(
    server,
    {
      name: config.name,
      description: config.description,
      inputSchema,
      outputSchema,
      annotations: config.annotations,
      purchaseAgentMutationHandled: true,
      telemetryEntity: config.telemetryEntity,
      handler: async (params, extra) => {
        const trusted = trustedPurchaseAgent(extra);
        const execution = params._runExecution;
        if (trusted && !execution)
          throw new Error(
            "Purchase-agent batch execution envelope is required",
          );
        if (trusted) {
          const itemOperationIds = execution?.itemOperationIds;
          if (
            !itemOperationIds ||
            itemOperationIds.length !== params.items.length ||
            new Set(itemOperationIds).size !== itemOperationIds.length ||
            itemOperationIds.includes(execution.operationId)
          ) {
            throw new Error(
              "Purchase-agent batches require one distinct stable operation id per item",
            );
          }
        }
        const results: Array<BatchResult<z.output<TItemOutput>>> = [];

        for (const [index, item] of params.items.entries()) {
          let stage: "run" | "output" = "run";
          try {
            const producedValue = trusted
              ? await executePurchaseAgentMutation({
                  db: getEntityKernelContext(extra).db,
                  actor: getEntityKernelContext(extra).actorContext,
                  operationContext: (() => {
                    const context = operationContextFromExtra(extra);
                    if (!context)
                      throw new Error(
                        "Purchase-agent operation context is missing",
                      );
                    return context;
                  })(),
                  trusted,
                  toolName: config.name,
                  args: { index, item },
                  execution: {
                    runId: execution!.runId,
                    operationId: execution!.itemOperationIds![index]!,
                  },
                  run: (transactionExtra) => config.run(item, transactionExtra),
                  baseExtra: extra,
                })
              : await config.run(item, extra);
            stage = "output";
            const produced = config.itemOutputSchema.parse(producedValue);
            const success: BatchSuccess<z.output<TItemOutput>> = {
              index,
              status: "succeeded",
              reference: config.projectReference(produced),
            };
            if (params.resultDetail === "full") success.item = produced;
            results.push(success);
          } catch (error) {
            results.push({
              index,
              status: "failed",
              error: describeToolError(
                error,
                {
                  operation: config.name,
                  authenticated: extra.authInfo !== undefined,
                  entity: config.telemetryEntity?.(params),
                  batchIndex: index,
                },
                stage,
              ),
            });
          }
        }

        const succeeded = results.filter(
          (result) => result.status === "succeeded",
        ).length;
        return {
          summary: {
            requested: results.length,
            succeeded,
            failed: results.length - succeeded,
          },
          results,
        };
      },
    },
    runtime,
  );
}

export function rejectDuplicateIds<TItem extends { id?: string }>(
  items: ReadonlyArray<TItem>,
  ctx: z.core.$RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (!item.id) continue;
    if (seen.has(item.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["items", index, "id"],
        message: `Duplicate update id ${item.id}; each item must target a different entity.`,
      });
    }
    seen.add(item.id);
  }
}
