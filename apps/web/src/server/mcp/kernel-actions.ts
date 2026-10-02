import { previewOperationSchema } from "@cubby/schemas/entity-integrity";
import { productShortcode } from "@cubby/schemas/identifiers";
import {
  productRecipeCoverageChangesOut,
  recipeLineCoverageOut,
} from "@cubby/schemas/import-recipe";
import {
  ingredientResolvableNamesInput,
  ingredientResolveOrCreateResultOut,
} from "@cubby/schemas/ingredient";
import { resolvePlantsInput, resolvePlantsOutput } from "@cubby/schemas/plant";
import {
  productResolveNamesInput,
  productResolveNamesOut,
  productUpdateData,
} from "@cubby/schemas/product";
import { z } from "zod";

import type { KernelActionName } from "~/contracts/mcp-define";
import {
  entitySummaryResultSchema,
  mcpResultsEnvelope,
  projectEntityResult,
} from "~/contracts/mcp-projections";
import { type EntityCommand, executeEntity } from "~/server/entity-kernel";
import {
  entityBulkUpdateResultSchema,
  entityCommandSchema,
  entityDeleteResultSchema,
  entityMcpBulkUpdateCommandSchema,
  entityMcpCreateCommandSchema,
  entityMcpDeleteCommandSchema,
  entityMcpGetCommandSchema,
  entityMcpListCommandSchema,
  entityMcpMergeCommandSchema,
  entityMcpRelationCommandSchema,
  entityMcpSearchCommandSchema,
  entityMcpUpdateCommandSchema,
  entityRelationMutationResultSchema,
  entitySearchResultSchema,
} from "~/server/entity-kernel/contracts";
import {
  entityPreviewInputSchema,
  entityPreviewOutputSchema,
  previewEntity,
} from "~/server/entity-kernel/preview";
import {
  generatedMcpEntityCreateCommandSchema,
  generatedMcpEntityGetResultSchema,
  generatedMcpEntityListResultSchema,
  generatedMcpEntityMergeResultSchema,
  generatedMcpEntityMutationCreateResultSchema,
  generatedMcpEntityMutationUpdateResultSchema,
  generatedMcpEntityUpdateCommandSchema,
} from "~/server/generated/entity-bindings.gen";
import {
  generatedMcpEntityRelationCommandSchema,
  generatedMcpEntityRelationPreviewInputSchema,
} from "~/server/generated/entity-relation-contracts.gen";
import { previewOperation } from "~/server/operations/entity-integrity-preview.server";
import { resolveWithProductCandidatesWorkflow } from "~/server/operations/ingredient.server";
import { beginProductCoverage } from "~/server/operations/product-recipe-coverage.server";
import { recipeLineCoverage } from "~/server/operations/recipe.server";
import { resolveOrCreatePlants } from "~/server/repo/plant";
import { resolveProductNames } from "~/server/repo/product/resolve-names";

import {
  batchInputSchema,
  batchOutputSchema,
  type McpBatchConfig,
  runMcpBatch,
} from "./batch";
import { getEntityKernelContext } from "./kernel-context";
import type { ToolExtra } from "./tools/tool-registration";

/**
 * The entity-kernel verbs behind the `entity_read` / `entity` tools. Each verb
 * takes the tool arguments with the tool's `action` swapped for the kernel
 * command's own `action` literal (`link` → `attach`), so a kernel command is
 * exactly the object an agent sends.
 */
export interface KernelMcpAction {
  /** The kernel command `action` the input schema expects, when it has one. */
  readonly verb?: string;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  /**
   * `input` is what `input` above parsed; the result is parsed by `output`.
   * `name` is the `${tool}.${action}` the call arrived as, for batch reports.
   */
  run(
    input: z.output<z.ZodType>,
    extra: ToolExtra,
    name: string,
    execution: BatchExecution,
  ): Promise<z.output<z.ZodType>>;
}

type BatchExecution = Parameters<typeof runMcpBatch>[1]["execution"];

/** `listRelation` is the `entityGraph.relation` action, not a kernel command. */
type McpEntityCommand = Exclude<EntityCommand, { action: "listRelation" }>;

const commandWithDetail = z.looseObject({
  resultDetail: z.enum(["summary", "full"]).optional(),
});

const kernelCommand = (
  command: z.output<typeof commandWithDetail>,
): McpEntityCommand => {
  const { resultDetail: _resultDetail, ...rest } = command;
  const parsed = entityCommandSchema.parse(rest);
  if (parsed.action === "listRelation")
    throw new Error("listRelation is not an entity tool command");
  return parsed;
};

/**
 * The kernel executor the verbs run through. Injectable so a boundary test can
 * exercise dispatch, projection, and batches over synthetic kernel results.
 */
export type McpEntityExecutor = (
  context: ReturnType<typeof getEntityKernelContext>,
  command: McpEntityCommand,
) => Promise<z.output<z.ZodType>>;

const writtenEntity = z.object({
  entity: z.string(),
  item: z.object({ id: z.string() }),
});

/**
 * A write answers with coverage diagnostics beside the entity: a recipe's
 * `lineCoverage` (per costed line, which of price / weight / nutrients are
 * still missing) and a Product update's `recipeCoverageChanges` (which recipe
 * lines it closed or regressed). They live on the MCP projection only — the
 * entity output schemas are unchanged.
 */
const writeCoverageOut = z.object({
  lineCoverage: recipeLineCoverageOut.optional(),
  recipeCoverageChanges: productRecipeCoverageChangesOut.optional(),
});

const productUpdateIdentity = z.object({
  action: z.literal("update"),
  entity: z.literal("product"),
  id: z.string(),
  data: productUpdateData,
});

/**
 * Runs a kernel write and merges coverage diagnostics into its result. A
 * Product update snapshots the affected recipe lines before the write so the
 * result can say which it closed; a recipe write reads its lines after.
 */
async function executeWithCoverage(
  execute: McpEntityExecutor,
  context: ReturnType<typeof getEntityKernelContext>,
  command: McpEntityCommand,
  project: (result: z.output<z.ZodType>) => z.output<z.ZodType> = (r) => r,
) {
  const productUpdate = productUpdateIdentity.safeParse(command);
  const finishProduct = productUpdate.success
    ? await beginProductCoverage(
        context,
        productUpdate.data.id,
        productUpdate.data.data,
      )
    : null;
  const result = z
    .object({ action: z.string(), entity: z.string() })
    .passthrough()
    .parse(await execute(context, command));
  const projected = z.looseObject({}).parse(project(result));
  const written = writtenEntity.safeParse(projected);
  if (!written.success) return projected;
  if (written.data.entity === "recipe")
    return {
      ...projected,
      lineCoverage: await recipeLineCoverage(context, written.data.item.id),
    };
  if (finishProduct)
    return { ...projected, recipeCoverageChanges: await finishProduct() };
  return projected;
}

/** A kernel command run through the executor, then projected by `resultDetail`. */
const commandAction = (
  execute: McpEntityExecutor,
  verb: string,
  input: z.ZodType,
  output: z.ZodType,
  options: { coverage?: boolean } = {},
): KernelMcpAction => ({
  verb,
  input,
  output,
  run: async (raw, extra) => {
    const command = commandWithDetail.parse(raw);
    const context = getEntityKernelContext(extra);
    const project = (result: z.output<z.ZodType>) =>
      // SAFETY: every kernel result names its entity; the projection reads only
      // the manifest title field for it and the published output re-parses.
      projectEntityResult(
        command,
        result as Parameters<typeof projectEntityResult>[1],
      );
    if (options.coverage)
      return executeWithCoverage(
        execute,
        context,
        kernelCommand(command),
        project,
      );
    return project(
      z
        .object({ action: z.string(), entity: z.string() })
        .passthrough()
        .parse(await execute(context, kernelCommand(command))),
    );
  },
});

const batchCommandItemInput = z.union([
  generatedMcpEntityCreateCommandSchema,
  generatedMcpEntityUpdateCommandSchema,
]);
const batchCommandItemOutput = z.union([
  generatedMcpEntityMutationCreateResultSchema.and(writeCoverageOut),
  generatedMcpEntityMutationUpdateResultSchema.and(writeCoverageOut),
]);

type BatchSpec<TInput extends z.ZodType, TOutput extends z.ZodType> = Omit<
  McpBatchConfig<TInput, z.output<TOutput>>,
  "name"
>;

const commandsBatch = (
  execute: McpEntityExecutor,
): BatchSpec<typeof batchCommandItemInput, typeof batchCommandItemOutput> => ({
  key: "commands",
  itemInput: batchCommandItemInput,
  itemOutput: batchCommandItemOutput,
  reference: (item: z.output<typeof batchCommandItemOutput>) => item.item.id,
  mutation: true,
  telemetryEntity: (items: Array<{ entity: string }>) => items[0]?.entity,
  run: async (item: z.output<typeof batchCommandItemInput>, extra: ToolExtra) =>
    executeWithCoverage(execute, getEntityKernelContext(extra), item),
});

const previewBatch: BatchSpec<
  typeof entityPreviewInputSchema,
  typeof entityPreviewOutputSchema
> = {
  key: "items",
  itemInput: entityPreviewInputSchema,
  itemOutput: entityPreviewOutputSchema,
  reference: (result: z.output<typeof entityPreviewOutputSchema>) =>
    `${result.entity}:${String(result.proposed.id ?? "preview")}`,
  mutation: false,
  telemetryEntity: (items: Array<{ entity: string }>) => items[0]?.entity,
  run: async (
    item: z.output<typeof entityPreviewInputSchema>,
    extra: ToolExtra,
  ) => previewEntity(getEntityKernelContext(extra), item),
};

const previewBatchInput = batchInputSchema(previewBatch);
const previewOperationInput = z.strictObject({
  operation: generatedMcpEntityRelationPreviewInputSchema,
});

const commandsInput = batchInputSchema({
  key: "commands",
  itemInput: batchCommandItemInput,
});

const productResolveInput = productResolveNamesInput.extend({
  entity: z.literal("product"),
});
const resolveOrCreateInput = z.discriminatedUnion("entity", [
  ingredientResolvableNamesInput.extend({
    entity: z.literal("ingredient"),
    linkProductId: productShortcode
      .optional()
      .describe(
        "Link this Product to the resolved ingredient (requires exactly one name), through the normal Product update. Pick it from a previous call's candidateProducts.",
      ),
  }),
  resolvePlantsInput.extend({ entity: z.literal("plant") }),
]);
const ingredientResolveWithProductsOut = z.array(
  ingredientResolveOrCreateResultOut.extend({
    candidateProducts: z
      .array(
        z.object({
          id: productShortcode,
          name: z.string(),
          manufacturer: z.string(),
        }),
      )
      .describe(
        "Up to 5 live Products with no ingredient link whose name contains every word of the ingredient, best match first. Advisory: link one with linkProductId.",
      ),
    linkedProduct: z
      .object({ id: productShortcode })
      .optional()
      .describe("Present when linkProductId was applied."),
  }),
);

/** Build the kernel verbs over one executor (production: `executeEntity`). */
export const createKernelMcpActions = (
  execute: McpEntityExecutor = executeEntity,
) =>
  ({
    get: commandAction(
      execute,
      "get",
      entityMcpGetCommandSchema,
      z.union([generatedMcpEntityGetResultSchema, entitySummaryResultSchema]),
    ),
    list: commandAction(
      execute,
      "list",
      entityMcpListCommandSchema,
      z.union([generatedMcpEntityListResultSchema, entitySummaryResultSchema]),
    ),
    search: commandAction(
      execute,
      "search",
      entityMcpSearchCommandSchema,
      entitySearchResultSchema,
    ),
    create: commandAction(
      execute,
      "create",
      entityMcpCreateCommandSchema,
      z.union([
        generatedMcpEntityMutationCreateResultSchema.and(writeCoverageOut),
        entitySummaryResultSchema,
      ]),
      { coverage: true },
    ),
    update: commandAction(
      execute,
      "update",
      entityMcpUpdateCommandSchema,
      z.union([
        generatedMcpEntityMutationUpdateResultSchema.and(writeCoverageOut),
        entitySummaryResultSchema,
      ]),
      { coverage: true },
    ),
    merge: commandAction(
      execute,
      "merge",
      entityMcpMergeCommandSchema,
      z.union([generatedMcpEntityMergeResultSchema, entitySummaryResultSchema]),
    ),
    delete: commandAction(
      execute,
      "delete",
      entityMcpDeleteCommandSchema,
      entityDeleteResultSchema,
    ),
    bulkUpdate: commandAction(
      execute,
      "bulkUpdate",
      entityMcpBulkUpdateCommandSchema,
      entityBulkUpdateResultSchema,
    ),
    link: commandAction(
      execute,
      "attach",
      entityMcpRelationCommandSchema,
      entityRelationMutationResultSchema,
    ),
    unlink: commandAction(
      execute,
      "detach",
      entityMcpRelationCommandSchema,
      entityRelationMutationResultSchema,
    ),
    commands: {
      input: commandsInput,
      output: batchOutputSchema(batchCommandItemOutput),
      run: (raw, extra, name, execution) => {
        const input = z
          .object({
            commands: z.array(batchCommandItemInput),
            resultDetail: z.enum(["summary", "full"]),
          })
          .parse(raw);
        return runMcpBatch(
          { ...commandsBatch(execute), name },
          {
            items: input.commands,
            resultDetail: input.resultDetail,
            execution,
          },
          extra,
        );
      },
    },
    /**
     * One create preview, a batch of up to 50 (`items`), or an attach/detach
     * dry run (`operation`). None of them writes.
     */
    preview: {
      input: z.union([
        entityPreviewInputSchema,
        previewBatchInput,
        previewOperationInput,
      ]),
      output: z.union([
        entityPreviewOutputSchema,
        batchOutputSchema(entityPreviewOutputSchema),
        previewOperationSchema,
      ]),
      run: async (raw, extra, name) => {
        const context = getEntityKernelContext(extra);
        const operation = previewOperationInput.safeParse(raw);
        if (operation.success)
          return previewOperation(
            context.db,
            generatedMcpEntityRelationCommandSchema.parse(
              operation.data.operation,
            ),
            new Date(),
          );
        if (previewBatchInput.safeParse(raw).success) {
          const batch = z
            .object({
              items: z.array(entityPreviewInputSchema),
              resultDetail: z.enum(["summary", "full"]),
            })
            .parse(raw);
          return runMcpBatch(
            { ...previewBatch, name },
            {
              items: batch.items,
              resultDetail: batch.resultDetail,
              execution: undefined,
            },
            extra,
          );
        }
        return previewEntity(context, entityPreviewInputSchema.parse(raw));
      },
    },
    /**
     * Name or external-id → id lookup that never creates: a Product is
     * identity plus cost basis, not just a name, so its create stays a
     * deliberate `entity` call.
     */
    resolve: {
      input: productResolveInput,
      output: mcpResultsEnvelope(productResolveNamesOut),
      run: async (raw, extra) => {
        const input = productResolveInput.parse(raw);
        return {
          results: await resolveProductNames(
            getEntityKernelContext(extra).db,
            input,
          ),
        };
      },
    },
    /** Name → id, creating what is missing (an ingredient or cultivar is just a name). */
    resolveOrCreate: {
      input: resolveOrCreateInput,
      output: z.union([
        mcpResultsEnvelope(ingredientResolveWithProductsOut),
        resolvePlantsOutput,
      ]),
      run: async (raw, extra) => {
        const context = getEntityKernelContext(extra);
        const input = resolveOrCreateInput.parse(raw);
        if (input.entity === "plant")
          return resolveOrCreatePlants(context.db, input, context.actorContext);
        return {
          results: await resolveWithProductCandidatesWorkflow(context, {
            names: input.names,
            linkProductId: input.linkProductId,
          }),
        };
      },
    },
  }) satisfies Record<KernelActionName, KernelMcpAction>;

export const KERNEL_MCP_ACTIONS = createKernelMcpActions();
