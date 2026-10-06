import { operationEffectSchema } from "@cubby/schemas/entity-integrity";
import { anyShortcodeSchema } from "@cubby/schemas/identifiers";
import {
  mcpResultDetail,
  mcpResultDetailFields,
} from "@cubby/schemas/mcp-detail";
import { mutationSideEffectsSchema } from "@cubby/schemas/mutation-side-effects";
import {
  DEFAULT_PAGE_SIZE,
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
  generatedEntityRelationListCommandSchema,
  generatedEntityRelationListResultSchema,
} from "~/entity/generated/entity-relation-lists.gen";
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
  generatedResolveEntityKernelEntities,
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
  sort: z.array(sort).min(1).max(MAX_SORTS).optional(),
  pagination: z
    .object({
      pageIndex: z.number().int().min(0).default(0),
      pageSize: z
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE_SIZE)
        .default(DEFAULT_PAGE_SIZE),
    })
    .optional(),
  groupBy: z.string().min(1).optional(),
};

const resultDetail = mcpResultDetail;
const resultDetailFields = z.object(mcpResultDetailFields);
const mcpListPagination = z
  .object(
    mcpPaginationFields({
      defaultPageSize: DEFAULT_PAGE_SIZE,
      maxPageSize: MAX_PAGE_SIZE,
    }),
  )
  .default({ pageIndex: 0, pageSize: DEFAULT_PAGE_SIZE });

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

const entityQueryCommandSchema = z.union([
  z.discriminatedUnion("action", [
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
  ]),
  generatedEntityRelationListCommandSchema,
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

const resolvableEntitySchema = z.enum(generatedResolveEntityKernelEntities);

/**
 * `capabilities.resolve`: names → live rows; `create: true` inserts the
 * misses (refused when the declaration says `createMissing: false`). Served
 * by `resolveEntity`, beside `entityCommandSchema` rather than in it, so the
 * transports' exhaustive command/result unions opt in explicitly.
 */
export const entityResolveCommandSchema = z.object({
  action: z.literal("resolve"),
  entity: resolvableEntitySchema,
  names: z.array(z.string().max(500)).min(1).max(1000),
  create: z.boolean().default(false),
});

/** Strictly serializable commands exposed by the generic browser transport. */
export const entityBrowserMutationCommandSchema = z.union([
  generatedEntityCreateCommandSchema,
  generatedEntityUpdateCommandSchema,
  deleteCommandSchema,
  bulkUpdateCommandSchema,
  generatedBrowserEntityRelationCommandSchema,
  // `data` is the entity's own merge input, parsed by its merge port.
  z.object({
    action: z.literal("merge"),
    entity: mergeableEntitySchema,
    data: z.record(z.string(), z.unknown()),
  }),
]);

export const entityCommandSchema = z.union([
  entityQueryCommandSchema,
  entityBrowserMutationCommandSchema,
]);

/**
 * MCP ingress, one schema per kernel verb (`server/mcp/kernel-actions.ts`
 * binds each to an `entity_read` / `entity` action). Generated from the
 * executable actions each literal exposes.
 */
export const entityMcpGetCommandSchema = z.object({
  action: z.literal("get"),
  entity: z.enum(generatedMcpEntityActionEntities.get),
  id: anyShortcodeSchema(generatedMcpEntityActionEntities.get),
  missing: z.enum(["error", "null"]).default("error"),
  resultDetail,
});
export const entityMcpListCommandSchema = mcpListCommandSchema;
export const entityMcpSearchCommandSchema = z.object({
  action: z.literal("search"),
  entity: z.enum(generatedMcpEntityActionEntities.search),
  query: z.string().trim().min(1).max(100),
  limit: z.number().int().min(1).max(50).default(5),
  semantic: z.boolean().default(true),
});
export const entityMcpCreateCommandSchema =
  generatedMcpEntityCreateCommandSchema.and(resultDetailFields);
export const entityMcpUpdateCommandSchema =
  generatedMcpEntityUpdateCommandSchema.and(resultDetailFields);
export const entityMcpDeleteCommandSchema = deleteCommandSchema.extend({
  entity: z.enum(generatedMcpEntityActionEntities.delete),
});
export const entityMcpBulkUpdateCommandSchema =
  generatedMcpEntityBulkUpdateCommandSchema(uniqueEntityIdsSchema);
export const entityMcpRelationCommandSchema =
  generatedMcpEntityRelationCommandSchema;
export const entityMcpMergeCommandSchema = z.object({
  action: z.literal("merge"),
  entity: z.enum(generatedMcpEntityActionEntities.merge),
  data: z.record(z.string(), z.unknown()),
  resultDetail,
});

export const entityMcpReadCommandSchema = z.union([
  entityMcpGetCommandSchema,
  entityMcpListCommandSchema,
  entityMcpSearchCommandSchema,
]);

export const entityMcpCommandSchema = z.union([
  entityMcpReadCommandSchema,
  entityMcpCreateCommandSchema,
  entityMcpUpdateCommandSchema,
  entityMcpDeleteCommandSchema,
  entityMcpBulkUpdateCommandSchema,
  entityMcpRelationCommandSchema,
  entityMcpMergeCommandSchema,
]);

export type EntityQueryCommand = z.infer<typeof entityQueryCommandSchema>;
export type EntityMutationCommand = z.infer<
  typeof entityBrowserMutationCommandSchema
>;
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

export const entityQueryResultSchema = z.union([
  z.discriminatedUnion("action", [
    generatedEntityGetResultSchema,
    generatedEntityListResultSchema,
    entitySearchResultSchema,
  ]),
  generatedEntityRelationListResultSchema,
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

export type EntityResolveCommand = z.input<typeof entityResolveCommandSchema>;

export const entityResolveResultSchema = z.object({
  action: z.literal("resolve"),
  entity: resolvableEntitySchema,
  /** One item per non-blank requested name, in request order. */
  items: z.array(
    z.object({
      name: z.string(),
      /** The matched or created row; null for an unresolved miss. */
      id: z.string().nullable(),
      /** An existing row matched the name or one of its declared aliases. */
      matched: z.boolean(),
      created: z.boolean(),
      /**
       * The resolved row's stored match values in declared order (its own
       * name, then aliases); empty for a miss. Differs from `name` when the
       * request matched through a casing variant or an alias.
       */
      matchValues: z.array(z.string()),
      /** Further exact matches, or a miss's closest contains-matches. */
      candidates: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  ),
  sideEffects: mutationSideEffectsSchema,
});

/** Strict wire result for browser mutations. */
export const entityBrowserMutationResultSchema = z.union([
  generatedEntityMutationCreateResultSchema,
  generatedEntityMutationUpdateResultSchema,
  entityDeleteResultSchema,
  entityBulkUpdateResultSchema,
  entityRelationMutationResultSchema,
  generatedEntityMergeResultSchema,
]);

type EntityKernelResult =
  | z.infer<typeof entityQueryResultSchema>
  | z.infer<typeof entityBrowserMutationResultSchema>;

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

/**
 * The result a command of `Action` on `Entity` can return: the same
 * action/entity correlation as {@link EntityResultFor}, from the two keys alone.
 */
export type EntityResultForAction<
  Action extends string,
  Entity extends string,
> = EntityKernelResult extends infer Result
  ? Result extends { action: Action; entity: EntityKernelEntity }
    ? [Extract<Result["entity"], Entity>] extends [never]
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
