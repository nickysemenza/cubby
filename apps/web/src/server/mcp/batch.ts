import { mcpResultDetail } from "@cubby/schemas/mcp-detail";
import type { purchaseImportRunExecution } from "@cubby/schemas/purchase-import";
import { z } from "zod";

import { getEntityKernelContext } from "~/server/mcp/kernel-context";
import {
  executePurchaseAgentMutation,
  trustedPurchaseAgent,
} from "~/server/mcp/purchase-agent-protocol";

import {
  describeToolError,
  operationContextFromExtra,
  type ToolErrorDetail,
  type ToolExtra,
  toolErrorDetailSchema,
} from "./tools/tool-registration";

/**
 * The batch form of an MCP action: up to `maxItems` independent items in
 * request order. A failed item neither stops nor rolls back the others, so the
 * result reports every index. A trusted purchase agent runs each mutation item
 * through its own stable operation id, so approval, replay, and the Run audit
 * trail stay per item.
 */

const DEFAULT_BATCH_MAX_ITEMS = 50;

type BatchResultDetail = "summary" | "full";

export interface McpBatchConfig<TItemInput extends z.ZodType, TItemOutput> {
  /** `${tool}.${action}`, the protocol and error-report name. */
  name: string;
  /** The envelope key holding the items (`items`, or `commands` for `entity`). */
  key: string;
  itemInput: TItemInput;
  itemOutput: z.ZodType<TItemOutput>;
  reference: (item: TItemOutput) => string;
  maxItems?: number;
  resultDetail?: BatchResultDetail;
  uniqueIds?: boolean;
  mutation: boolean;
  telemetryEntity?: (items: Array<z.output<TItemInput>>) => string | undefined;
  /** Its result is parsed by `itemOutput` before anything reads it. */
  run: (
    item: z.output<TItemInput>,
    extra: ToolExtra,
  ) => Promise<z.output<z.ZodType>>;
}

export function batchOutputSchema<TItemOutput extends z.ZodType>(
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

function rejectDuplicateIds(
  key: string,
  items: ReadonlyArray<unknown>,
  ctx: z.core.$RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    const id = z.object({ id: z.string() }).safeParse(item).data?.id;
    if (!id) continue;
    if (seen.has(id))
      ctx.addIssue({
        code: "custom",
        path: [key, index, "id"],
        message: `Duplicate update id ${id}; each item must target a different entity.`,
      });
    seen.add(id);
  }
}

export function batchInputSchema<TItemInput extends z.ZodType>(
  config: Pick<
    McpBatchConfig<TItemInput, z.output<z.ZodType>>,
    "key" | "itemInput" | "maxItems" | "resultDetail" | "uniqueIds"
  >,
) {
  const fallback = config.resultDetail ?? "summary";
  const envelope = {
    [config.key]: z
      .array(config.itemInput)
      .min(1)
      .max(config.maxItems ?? DEFAULT_BATCH_MAX_ITEMS),
    resultDetail: mcpResultDetail
      .default(fallback)
      .describe(
        `How much of each result to return. 'summary' gives {index, status, reference}; 'full' also includes the parsed item. Defaults to '${fallback}'.`,
      ),
  };
  const schema = z.strictObject(envelope);
  return config.uniqueIds
    ? schema.superRefine((input, ctx) =>
        rejectDuplicateIds(
          config.key,
          z.array(z.unknown()).parse(input[config.key]),
          ctx,
        ),
      )
    : schema;
}

type BatchSuccess<TItem> = {
  index: number;
  status: "succeeded";
  reference: string;
  item?: TItem;
};
type BatchResult<TItem> =
  | BatchSuccess<TItem>
  | { index: number; status: "failed"; error: ToolErrorDetail };

export async function runMcpBatch<TItemInput extends z.ZodType, TItemOutput>(
  config: McpBatchConfig<TItemInput, TItemOutput>,
  input: {
    items: Array<z.output<TItemInput>>;
    resultDetail: BatchResultDetail;
    execution: z.output<typeof purchaseImportRunExecution> | undefined;
  },
  extra: ToolExtra,
) {
  const trusted = config.mutation ? trustedPurchaseAgent(extra) : null;
  const { execution } = input;
  if (trusted) {
    const itemOperationIds = execution?.itemOperationIds;
    if (
      !execution ||
      !itemOperationIds ||
      itemOperationIds.length !== input.items.length ||
      new Set(itemOperationIds).size !== itemOperationIds.length ||
      itemOperationIds.includes(execution.operationId)
    )
      throw new Error(
        "Purchase-agent batches require one distinct stable operation id per item",
      );
  }
  const results: Array<BatchResult<TItemOutput>> = [];
  for (const [index, item] of input.items.entries()) {
    let stage: "run" | "output" = "run";
    try {
      const produced = trusted
        ? await executePurchaseAgentMutation({
            db: getEntityKernelContext(extra).db,
            actor: getEntityKernelContext(extra).actorContext,
            operationContext: requireOperationContext(extra),
            trusted,
            toolName: config.name,
            args: { index, item },
            execution: {
              // SAFETY: `trusted` implies the envelope checks above passed.
              runId: execution!.runId,
              operationId: execution!.itemOperationIds![index]!,
            },
            run: (transactionExtra) => config.run(item, transactionExtra),
            baseExtra: extra,
          })
        : await config.run(item, extra);
      stage = "output";
      const parsed = config.itemOutput.parse(produced);
      const success: BatchSuccess<TItemOutput> = {
        index,
        status: "succeeded",
        reference: config.reference(parsed),
      };
      if (input.resultDetail === "full") success.item = parsed;
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
            entity: config.telemetryEntity?.(input.items),
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
}

function requireOperationContext(extra: ToolExtra) {
  const context = operationContextFromExtra(extra);
  if (!context) throw new Error("Purchase-agent operation context is missing");
  return context;
}
