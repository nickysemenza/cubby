import { mutationSideEffectsSchema } from "@cubby/schemas/background-jobs";
import { relationMutationOut } from "@cubby/schemas/common";
import { operationEffectSchema } from "@cubby/schemas/entity-integrity";
import { imageUpdateInput } from "@cubby/schemas/image";
import { MAX_PAGE_SIZE, MAX_SORTS } from "@cubby/schemas/pagination";
import {
  relatedSearchOutSchema,
  searchableEntitySchema,
  searchHitSchema,
} from "@cubby/schemas/search";
import { z } from "zod";
import {
  generatedEntityCreateCommandSchema,
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

export const entityMutationCommandSchema = z.union([
  generatedEntityCreateCommandSchema,
  generatedEntityUpdateCommandSchema,
  z.object({
    action: z.literal("update"),
    entity: z.literal("image"),
    id: z.string().min(1),
    data: imageUpdateInput,
  }),
  z.object({
    action: z.literal("delete"),
    entity: entityKernelEntitySchema,
    ids: uniqueEntityIdsSchema,
  }),
  z.object({
    action: z.literal("merge"),
    entity: mergeableEntitySchema,
    data: z.record(z.string(), z.unknown()),
  }),
  attachCommandSchema,
  detachCommandSchema,
]);

export const entityCommandSchema = z.union([
  entityQueryCommandSchema,
  entityMutationCommandSchema,
]);

export type EntityQueryCommand = z.infer<typeof entityQueryCommandSchema>;
export type EntityMutationCommand = z.infer<typeof entityMutationCommandSchema>;
export type EntityCommand = z.infer<typeof entityCommandSchema>;

export const entityQueryResultSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("get"),
    entity: entityKernelEntitySchema,
    item: z.unknown(),
  }),
  z.object({
    action: z.literal("list"),
    entity: entityKernelEntitySchema,
    items: z.array(z.unknown()),
    meta: z.object({
      pageIndex: z.number().int().nonnegative(),
      pageSize: z.number().int().positive().max(MAX_PAGE_SIZE),
      totalCount: z.number().int().nonnegative(),
      sums: z.record(z.string(), z.number()).optional(),
    }),
  }),
  z.object({
    action: z.literal("search"),
    entity: searchableEntitySchema,
    lexical: z.array(searchHitSchema),
    semantic: relatedSearchOutSchema,
  }),
]);

export const entityMutationResultSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    entity: entityKernelEntitySchema,
    item: z.unknown(),
    sideEffects: mutationSideEffectsSchema,
  }),
  z.object({
    action: z.literal("update"),
    entity: entityKernelEntitySchema,
    item: z.unknown(),
    sideEffects: mutationSideEffectsSchema,
  }),
  z.object({
    action: z.literal("delete"),
    entity: entityKernelEntitySchema,
    deleted: z.number().int().nonnegative(),
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
  }),
  z.object({
    action: z.literal("merge"),
    entity: mergeableEntitySchema,
    item: z.unknown(),
    mergeSummary: z.unknown(),
    sideEffects: mutationSideEffectsSchema,
  }),
  z.object({
    action: z.enum(["attach", "detach"]),
    entity: z.enum(["product", "project", "purchase"]),
    relation: z.enum(["components", "resources", "products"]),
    result: relationMutationOut,
  }),
]);
export type EntityMutationResult = z.infer<typeof entityMutationResultSchema>;
