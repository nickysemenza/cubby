import { mutationSideEffectsSchema } from "@cubby/schemas/background-jobs";
import { operationEffectSchema } from "@cubby/schemas/entity-integrity";
import { anyShortcodeSchema } from "@cubby/schemas/identifiers";
import {
  mcpResultDetail,
  mcpResultDetailFields,
} from "@cubby/schemas/mcp-detail";
import {
  MAX_PAGE_SIZE,
  MAX_SORTS,
  mcpPaginationFields,
} from "@cubby/schemas/pagination";
import {
  relatedSearchOutSchema,
  searchableEntitySchema,
  searchHitSchema,
} from "@cubby/schemas/search";
import { z } from "zod";

import {
  generatedEntityBulkUpdateCommandSchema,
  generatedEntityCreateCommandSchema,
  generatedEntityGetResultSchema,
  generatedEntityListResultSchema,
  generatedEntityMergeResultSchema,
  generatedEntityMutationCreateResultSchema,
  generatedEntityMutationUpdateResultSchema,
  generatedEntityUpdateCommandSchema,
  generatedMcpEntityBulkUpdateCommandSchema,
  generatedMcpEntityCreateCommandSchema,
  generatedMcpEntityUpdateCommandSchema,
  ENTITY_SCHEMA_BINDINGS,
} from "~/server/generated/entity-bindings.gen";
import {
  generatedEntityKernelEntities,
  generatedMergeEntityKernelEntities,
  generatedMcpEntityActionEntities,
  generatedSearchEntityKernelEntities,
} from "~/server/generated/entity-kernel-entities.gen";
import {
  generatedBrowserEntityRelationCommandSchema,
  generatedEntityRelationMutationResultSchema,
  generatedMcpEntityRelationCommandSchema,
} from "~/server/generated/entity-relation-contracts.gen";

export const ENTITY_KERNEL_ENTITIES = generatedEntityKernelEntities;

const entityKernelEntitySchema = z.enum(ENTITY_KERNEL_ENTITIES);
export type EntityKernelEntity = z.infer<typeof entityKernelEntitySchema>;

const searchableKernelEntitySchema = z.enum(
  generatedSearchEntityKernelEntities,
);

const sort = z.object({
  orderBy: z.string().min(1),
  direction: z.enum(["asc", "desc"]).default("asc"),
});

const listFields = {
  filters: z.record(z.string(), z.unknown()).default({}),
  sort: z.union([sort, z.array(sort).min(1).max(MAX_SORTS)]).optional(),
  pagination: z
    .object({
      pageIndex: z.number().int().min(0).default(0),
      pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(10),
    })
    .optional(),
  groupBy: z.string().min(1).optional(),
};

const resultDetail = mcpResultDetail;
const resultDetailFields = z.object(mcpResultDetailFields);
const mcpListPagination = z
  .object(mcpPaginationFields({ defaultPageSize: 10, maxPageSize: 500 }))
  .default({ pageIndex: 0, pageSize: 10 });

const mcpListCommandCases = generatedMcpEntityActionEntities.list.map(
  (entity) => {
    const binding = ENTITY_SCHEMA_BINDINGS[entity];
    // Widened before the chained calls: `.default` over a union of every
    // entity's typed filter object is not a callable union. The kernel
    // re-validates `filters` with the entity's own schema
    // (`entity-operations.ts`), so the command carries the loose shape.
    const entityFilters: z.ZodObject = binding.filters;
    const filters = entityFilters
      .extend({ ids: z.array(binding.id).min(1).max(500).optional() })
      .strict()
      .default({});
    return z.object({
      action: z.literal("list"),
      entity: z.literal(entity),
      filters,
      sort: listFields.sort,
      pagination: mcpListPagination,
      groupBy: listFields.groupBy,
      resultDetail,
    });
  },
);
const mcpListCommandSchema = z.union(
  // SAFETY: the generated entity roster is non-empty and contains far more
  // than Zod's required two union members.
  mcpListCommandCases as [
    (typeof mcpListCommandCases)[number],
    (typeof mcpListCommandCases)[number],
    ...(typeof mcpListCommandCases)[number][],
  ],
);

const entityQueryCommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("get"),
    entity: entityKernelEntitySchema,
    id: z.string().min(1),
    missing: z.enum(["error", "null"]).default("error"),
  }),
  z.object({
    action: z.literal("list"),
    entity: entityKernelEntitySchema,
    ...listFields,
  }),
  z.object({
    action: z.literal("search"),
    entity: searchableKernelEntitySchema,
    query: z.string().trim().min(1).max(100),
    limit: z.number().int().min(1).max(50).default(5),
    semantic: z.boolean().default(true),
  }),
]);

// Images are deliberately absent: image creation is an upload workflow, not a
// row CRUD action. The kernel exposes its real list/get/update/delete
// surface without inventing a dishonest `create` command.
const mergeableEntitySchema = z.enum(generatedMergeEntityKernelEntities);

const uniqueEntityIdsSchema = z
  .array(z.string().min(1))
  .min(1)
  .max(500)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "entity IDs must be unique",
  });

const deleteCommandSchema = z.object({
  action: z.literal("delete"),
  entity: entityKernelEntitySchema,
  ids: uniqueEntityIdsSchema,
});
/**
 * Bulk field patch over the same id bound bulk delete uses. `data` is the
 * entity's own update schema narrowed to the fields its literal spec declares
 * under `capabilities.bulkUpdate`, so an undeclared field is refused here
 * rather than in a repository.
 */
const bulkUpdateCommandSchema = generatedEntityBulkUpdateCommandSchema(
  uniqueEntityIdsSchema,
);

/** Strictly serializable commands exposed by the generic browser transport. */
export const entityBrowserMutationCommandSchema = z.union([
  generatedEntityCreateCommandSchema,
  generatedEntityUpdateCommandSchema,
  deleteCommandSchema,
  bulkUpdateCommandSchema,
  generatedBrowserEntityRelationCommandSchema,
]);

const entityMutationCommandSchema = z.union([
  entityBrowserMutationCommandSchema,
  z.object({
    action: z.literal("merge"),
    entity: mergeableEntitySchema,
    data: z.record(z.string(), z.unknown()),
  }),
]);

export const entityCommandSchema = z.union([
  entityQueryCommandSchema,
  entityMutationCommandSchema,
]);

export const entityMcpReadCommandSchema = z.union([
  z.object({
    action: z.literal("get"),
    entity: z.enum(generatedMcpEntityActionEntities.get),
    id: anyShortcodeSchema(generatedMcpEntityActionEntities.get),
    missing: z.enum(["error", "null"]).default("error"),
    resultDetail,
  }),
  mcpListCommandSchema,
  z.object({
    action: z.literal("search"),
    entity: z.enum(generatedMcpEntityActionEntities.search),
    query: z.string().trim().min(1).max(100),
    limit: z.number().int().min(1).max(50).default(5),
    semantic: z.boolean().default(true),
  }),
]);

const mcpDeleteCommandSchema = deleteCommandSchema.extend({
  entity: z.enum(generatedMcpEntityActionEntities.delete),
});

const mcpMergeCommandSchema = z.object({
  action: z.literal("merge"),
  entity: z.enum(generatedMcpEntityActionEntities.merge),
  data: z.record(z.string(), z.unknown()),
  resultDetail,
});

/** MCP ingress is generated from executable actions each literal exposes. */
export const entityMcpCommandSchema = z.union([
  entityMcpReadCommandSchema,
  generatedMcpEntityCreateCommandSchema.and(resultDetailFields),
  generatedMcpEntityUpdateCommandSchema.and(resultDetailFields),
  mcpDeleteCommandSchema,
  generatedMcpEntityBulkUpdateCommandSchema(uniqueEntityIdsSchema),
  generatedMcpEntityRelationCommandSchema,
  mcpMergeCommandSchema,
]);

export type EntityQueryCommand = z.infer<typeof entityQueryCommandSchema>;
export type EntityMutationCommand = z.infer<typeof entityMutationCommandSchema>;
export type EntityBrowserMutationCommand = z.infer<
  typeof entityBrowserMutationCommandSchema
>;
export type EntityBrowserMutationInput = z.input<
  typeof entityBrowserMutationCommandSchema
>;
export type EntityCommand = z.infer<typeof entityCommandSchema>;

export const entitySearchResultSchema = z.object({
  action: z.literal("search"),
  entity: searchableEntitySchema,
  lexical: z.array(searchHitSchema),
  semantic: relatedSearchOutSchema,
});

export const entityQueryResultSchema = z.discriminatedUnion("action", [
  generatedEntityGetResultSchema,
  generatedEntityListResultSchema,
  entitySearchResultSchema,
]);

export const entityDeleteResultSchema = z.object({
  action: z.literal("delete"),
  entity: entityKernelEntitySchema,
  deletedReferences: z
    .array(
      z.object({ entity: entityKernelEntitySchema, id: z.string().min(1) }),
    )
    .superRefine((references, context) => {
      const seen = new Set<string>();
      for (const reference of references) {
        const key = `${reference.entity}:${reference.id}`;
        if (seen.has(key)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate deleted reference: ${key}`,
          });
        }
        seen.add(key);
      }
    }),
  affectedEdges: z.array(
    z.object({
      edge: z.string().min(1),
      effect: operationEffectSchema,
      changed: z.number().int().nonnegative(),
    }),
  ),
  sideEffects: mutationSideEffectsSchema,
});
export const entityBulkUpdateResultSchema = z.object({
  action: z.literal("bulkUpdate"),
  entity: entityKernelEntitySchema,
  updatedReferences: z.array(
    z.object({ entity: entityKernelEntitySchema, id: z.string().min(1) }),
  ),
  sideEffects: mutationSideEffectsSchema,
});
export const entityRelationMutationResultSchema =
  generatedEntityRelationMutationResultSchema;

/** Strict wire result for browser mutations; merge remains a workflow API. */
export const entityBrowserMutationResultSchema = z.union([
  generatedEntityMutationCreateResultSchema,
  generatedEntityMutationUpdateResultSchema,
  entityDeleteResultSchema,
  entityBulkUpdateResultSchema,
  entityRelationMutationResultSchema,
]);

export const entityMutationResultSchema = z.union([
  entityBrowserMutationResultSchema,
  generatedEntityMergeResultSchema,
]);

type EntityKernelResult =
  | z.infer<typeof entityQueryResultSchema>
  | z.infer<typeof entityMutationResultSchema>;

type ResultForCommand<Command extends EntityCommand> =
  EntityKernelResult extends infer Result
    ? Result extends { action: string; entity: EntityKernelEntity }
      ? [Extract<Result["action"], Command["action"]>] extends [never]
        ? never
        : [Extract<Result["entity"], Command["entity"]>] extends [never]
          ? never
          : Result
      : never
    : never;

/** Preserve action/entity correlation through the small executeEntity seam. */
export type EntityResultFor<Command extends EntityCommand> =
  Command extends EntityCommand ? ResultForCommand<Command> : never;
export type EntityBrowserMutationResult = z.infer<
  typeof entityBrowserMutationResultSchema
>;
