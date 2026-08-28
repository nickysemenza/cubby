import { mutationSideEffectsSchema } from "@cubby/schemas/background-jobs";
import { relationMutationOut } from "@cubby/schemas/common";
import { operationEffectSchema } from "@cubby/schemas/entity-integrity";
import { MAX_PAGE_SIZE, MAX_SORTS } from "@cubby/schemas/pagination";
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
} from "~/server/generated/entity-bindings.gen";
import {
  generatedEntityKernelEntities,
  generatedMergeEntityKernelEntities,
  generatedSearchEntityKernelEntities,
} from "~/server/generated/entity-kernel-entities.gen";

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

const relationItemSchema = z.object({
  id: z.string().min(1),
  quantity: z.number().int().min(1).max(9999).optional(),
});

const uniqueEntityIdsSchema = z
  .array(z.string().min(1))
  .min(1)
  .max(500)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "entity IDs must be unique",
  });

const relationCommandFields = {
  entity: z.enum(["product", "project", "purchase"]),
  relation: z.enum(["components", "resources", "products"]),
  id: z.string().min(1),
  items: z.array(relationItemSchema).min(1).max(500),
};

const validateRelationCommand = (
  value: {
    entity: "product" | "project" | "purchase";
    relation: "components" | "resources" | "products";
    items: { id: string; quantity?: number }[];
  },
  ctx: z.RefinementCtx,
) => {
  const expected = {
    product: "components",
    project: "resources",
    purchase: "products",
  }[value.entity];
  if (value.relation !== expected) {
    ctx.addIssue({
      code: "custom",
      path: ["relation"],
      message: `${value.entity} only supports the ${expected} relation`,
    });
  }
  if (
    value.entity !== "product" &&
    value.items.some((item) => item.quantity !== undefined)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["items"],
      message: "quantity is only valid for product components",
    });
  }
};

const attachCommandSchema = z
  .object({ action: z.literal("attach"), ...relationCommandFields })
  .superRefine(validateRelationCommand);
const detachCommandSchema = z
  .object({ action: z.literal("detach"), ...relationCommandFields })
  .superRefine(validateRelationCommand);
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
  attachCommandSchema,
  detachCommandSchema,
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
  deletedReferences: z.array(
    z.object({ entity: entityKernelEntitySchema, id: z.string().min(1) }),
  ),
  affectedEdges: z.array(
    z.object({
      edge: z.string().min(1),
      effect: operationEffectSchema,
      changed: z.number().int().nonnegative().nullable(),
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
export const entityRelationMutationResultSchema = z.object({
  action: z.enum(["attach", "detach"]),
  entity: z.enum(["product", "project", "purchase"]),
  relation: z.enum(["components", "resources", "products"]),
  result: relationMutationOut,
});

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
