import { previewOperationSchema } from "@cubby/schemas/entity-integrity";
import { productShortcode } from "@cubby/schemas/identifiers";
import {
  ingredientResolvableNamesInput,
  ingredientResolveOrCreateResultOut,
} from "@cubby/schemas/ingredient";
import { resolvePlantsInput, resolvePlantsOutput } from "@cubby/schemas/plant";
import {
  productResolveNamesInput,
  productResolveNamesOut,
} from "@cubby/schemas/product";
import { z } from "zod";

import type { KernelActionName } from "~/contracts/mcp-define";
import {
  entitySummaryFields,
  entitySummaryResultSchema,
  mcpResultsEnvelope,
  projectEntityResult,
} from "~/contracts/mcp-projections";
import { resolveWithProductCandidatesWorkflow } from "~/server/domains/ingredient/operations.server";
import { resolveOrCreatePlants } from "~/server/domains/plant/repo/plant";
import { resolveProductNames } from "~/server/domains/product/repo/resolve-names";
import {
  type EntityCommand,
  type EntityKernelContext,
  executeEntity,
} from "~/server/entity-kernel";
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
import { executeEntityMutationRead } from "~/server/entity-kernel/execute";
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
import { ENTITY_LIST_READ_OPERATIONS } from "~/server/generated/entity-list-read-bindings.gen";
import {
  generatedMcpEntityRelationCommandSchema,
  generatedMcpEntityRelationPreviewInputSchema,
} from "~/server/generated/entity-relation-contracts.gen";
import { previewOperation } from "~/server/generic/integrity/operations/entity-integrity-preview.server";
import type { Principal } from "~/server/http/authenticate";

import {
  batchInputSchema,
  batchOutputSchema,
  type McpBatchConfig,
  runMcpBatch,
} from "./batch";
import {
  entitySelectedResultSchema,
  projectSelection,
  readSelection,
  type ReadSelection,
  selectionListFields,
} from "./entity-field-selection";

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
   * `principal.context` is the runner-selected context the verb reads and
   * writes through. `name` is the `${tool}.${action}` the call arrived as,
   * for batch reports.
   */
  run(
    input: z.output<z.ZodType>,
    principal: Principal,
    name: string,
    execution: BatchExecution,
  ): Promise<z.output<z.ZodType>>;
}

type BatchExecution = Parameters<typeof runMcpBatch>[1]["execution"];

/** `listRelation` is the `entityGraph.relation` action, not a kernel command. */
type McpEntityCommand = Exclude<EntityCommand, { action: "listRelation" }>;

const commandWithDetail = z.looseObject({
  resultDetail: z.enum(["summary", "compact", "full"]).optional(),
  fields: z.array(z.string()).optional(),
});

const kernelCommand = (
  command: z.output<typeof commandWithDetail>,
): McpEntityCommand => {
  const { resultDetail: _resultDetail, fields: _fields, ...rest } = command;
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
  context: EntityKernelContext,
  command: McpEntityCommand,
  detail?: ResultDetail | "reference",
  selection?: ReadSelection | null,
) => Promise<z.output<z.ZodType>>;

type ResultDetail = NonNullable<
  z.output<typeof commandWithDetail>["resultDetail"]
>;

const hasListReader = (
  entity: string,
): entity is keyof typeof ENTITY_LIST_READ_OPERATIONS =>
  Object.hasOwn(ENTITY_LIST_READ_OPERATIONS, entity);

/**
 * Production executor. A summary list publishes only `entitySummaryFields`, so
 * it reads one page with the groups owning those fields instead of the
 * complete row (data quality, pricing, USDA, media); every other command and
 * an entity without a progressive reader run the full kernel operation.
 */
const executeMcpEntity: McpEntityExecutor = async (
  context,
  command,
  detail,
  selection,
) => {
  if (!selection) return executeDetail(context, command, detail);
  // A selection the list reader can serve reads only its fields' groups.
  if (command.action === "list" && hasListReader(command.entity)) {
    const fields = selectionListFields(command.entity, selection);
    if (fields)
      return ENTITY_LIST_READ_OPERATIONS[command.entity].listFields(
        context,
        { ...command, filters: command.filters ?? {} },
        fields,
      );
  }
  return executeEntity(context, command);
};

const executeDetail: McpEntityExecutor = async (context, command, detail) => {
  if (
    detail === "reference" &&
    (command.action === "create" || command.action === "update")
  )
    return executeEntityMutationRead(context, command, ["id"]);
  return detail === "summary" &&
    command.action === "list" &&
    hasListReader(command.entity)
    ? ENTITY_LIST_READ_OPERATIONS[command.entity].listFields(
        context,
        { ...command, filters: command.filters ?? {} },
        entitySummaryFields(command.entity),
      )
    : executeEntity(context, command);
};

/** A kernel command run through the executor, then projected by `resultDetail`. */
const commandAction = (
  execute: McpEntityExecutor,
  verb: string,
  input: z.ZodType,
  output: z.ZodType,
): KernelMcpAction => ({
  verb,
  input,
  output,
  run: async (raw, principal) => {
    const command = commandWithDetail.parse(raw);
    const detail = command.resultDetail ?? "summary";
    const { context } = principal;
    const selection =
      command.action === "create" || command.action === "update"
        ? null
        : readSelection({
            ...z
              .object({ action: z.string(), entity: z.string() })
              .parse(command),
            resultDetail: command.resultDetail,
            fields: command.fields,
          });
    const project = (result: z.output<z.ZodType>) =>
      selection
        ? projectSelection(result, selection)
        : // SAFETY: every kernel result names its entity; the projection reads
          // only the manifest title field for it and the published output re-parses.
          projectEntityResult(
            {
              ...command,
              resultDetail: detail === "full" ? "full" : "summary",
            },
            result as Parameters<typeof projectEntityResult>[1],
          );
    return project(
      z
        .object({ action: z.string(), entity: z.string() })
        .passthrough()
        .parse(
          await execute(context, kernelCommand(command), detail, selection),
        ),
    );
  },
});

const batchCommandItemInput = z.union([
  generatedMcpEntityCreateCommandSchema,
  generatedMcpEntityUpdateCommandSchema,
]);
const batchCommandItemOutput = z.union([
  generatedMcpEntityMutationCreateResultSchema,
  generatedMcpEntityMutationUpdateResultSchema,
]);

type BatchSpec<TInput extends z.ZodType, TOutput extends z.ZodType> = Omit<
  McpBatchConfig<TInput, z.output<TOutput>>,
  "name"
>;

const batchCommandReference = z
  .object({
    action: z.enum(["create", "update"]),
    entity: z.string(),
    item: z.object({ id: z.string() }),
  })
  .passthrough();
const commandsBatch = (
  execute: McpEntityExecutor,
): BatchSpec<typeof batchCommandItemInput, typeof batchCommandItemOutput> => ({
  key: "commands",
  itemInput: batchCommandItemInput,
  itemOutput: batchCommandItemOutput,
  summaryOutput: batchCommandReference.transform((result) => ({
    reference: result.item.id,
  })),
  reference: (item: z.output<typeof batchCommandItemOutput>) => item.item.id,
  mutation: true,
  telemetryEntity: (items: Array<{ entity: string }>) => items[0]?.entity,
  run: async (item, principal) => execute(principal.context, item),
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
    principal: Principal,
  ) => previewEntity(principal.context, item),
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
          brandName: z.string().nullable(),
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

/** Build the kernel verbs over one executor (production: `executeMcpEntity`). */
export const createKernelMcpActions = (
  execute: McpEntityExecutor = executeMcpEntity,
) =>
  ({
    get: commandAction(
      execute,
      "get",
      entityMcpGetCommandSchema,
      z.union([
        generatedMcpEntityGetResultSchema,
        entitySummaryResultSchema,
        entitySelectedResultSchema,
      ]),
    ),
    list: commandAction(
      execute,
      "list",
      entityMcpListCommandSchema,
      z.union([
        generatedMcpEntityListResultSchema,
        entitySummaryResultSchema,
        entitySelectedResultSchema,
      ]),
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
      generatedMcpEntityMutationCreateResultSchema,
    ),
    update: commandAction(
      execute,
      "update",
      entityMcpUpdateCommandSchema,
      generatedMcpEntityMutationUpdateResultSchema,
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
      run: (raw, principal, name, execution) => {
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
          principal,
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
      run: async (raw, principal, name) => {
        const { context } = principal;
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
            principal,
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
      run: async (raw, principal) => {
        const input = productResolveInput.parse(raw);
        return {
          results: await resolveProductNames(principal.context.db, input),
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
      run: async (raw, principal) => {
        const { context } = principal;
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
