import { mutationSideEffectsSchema } from "@cubby/schemas/background-jobs";
import {
  createPaginatedResponseSchemaWithContext,
  createSortPaginationFields,
  type PaginationParams,
  type SortInput,
} from "@cubby/schemas/pagination";
import type { TRPCUnsetMarker } from "@trpc/server";
import { type ZodSchema, z } from "zod";
import { executeEntity } from "~/server/entity-kernel";
import type {
  EntityKernelEntity,
  EntityMutationCommand,
} from "~/server/entity-kernel/contracts";
import { protectedProcedure, strictOutput } from "./trpc";

const asResolvedOutput = <T>(value: T): T extends TRPCUnsetMarker ? never : T =>
  value as T extends TRPCUnsetMarker ? never : T;

/**
 * Temporary wire-compatibility for named entity routers.
 *
 * These procedures contain no domain behavior: each maps the old route shape
 * to the single kernel command and unwraps its normalized envelope. New callers
 * use `entity.query` / `entity.mutate`; old browser routes can migrate without
 * preserving a second CRUD implementation.
 */
export function createEntityCompatibilityProcedures<
  const E extends Exclude<EntityKernelEntity, "image">,
  SId extends ZodSchema,
  SCreate extends ZodSchema,
  SUpdate extends ZodSchema,
  SOutput extends ZodSchema,
  SFilters extends ZodSchema,
  SList extends ZodSchema = SOutput,
>(
  binding: {
    entity: E;
    filters: SFilters;
    sort: {
      fields: readonly [string, ...string[]];
      default: string;
      groupable?: readonly [string, ...string[]];
    };
  },
  schemas: {
    idSchema: SId;
    createInput: SCreate;
    updateInput: SUpdate;
    output: SOutput;
    listOutput?: SList;
  },
) {
  // Preserve the branded parsed id through Zod's generic input boundary.
  // The binding was constructed from this exact schema; this only restores the
  // output type that `ZodSchema`'s `unknown` input default otherwise erases.
  const idSchema = schemas.idSchema as unknown as z.ZodType<
    z.output<SId>,
    unknown
  >;
  const listInput = z.object({
    filters: binding.filters,
    ...createSortPaginationFields({
      sortableFields: binding.sort.fields,
      defaultSort: binding.sort.default,
      groupableFields: binding.sort.groupable,
    }),
  });
  const mutationOutput = z.intersection(
    schemas.output,
    z.object({ sideEffects: mutationSideEffectsSchema }),
  );
  const listOutput = (schemas.listOutput ?? schemas.output) as SList;
  const getByID = protectedProcedure
    .input(z.object({ id: idSchema }))
    .output(strictOutput(schemas.output))
    .query(async ({ ctx, input }) => {
      const { id } = input as { id: z.output<SId> };
      const result = await executeEntity(ctx, {
        action: "get",
        entity: binding.entity,
        id: id as string,
        missing: "error",
      });
      if (result.action !== "get" || result.item === null)
        throw new Error("Entity kernel returned the wrong action");
      return asResolvedOutput(result.item as z.output<SOutput>);
    });

  const getByShortcode = protectedProcedure
    .input(z.object({ shortcode: idSchema }))
    .output(strictOutput(schemas.output.nullable()))
    .query(async ({ ctx, input }) => {
      const { shortcode } = input as { shortcode: z.output<SId> };
      const result = await executeEntity(ctx, {
        action: "get",
        entity: binding.entity,
        id: shortcode as string,
        missing: "null",
      });
      if (result.action !== "get")
        throw new Error("Entity kernel returned the wrong action");
      return asResolvedOutput(result.item as z.output<SOutput> | null);
    });

  const list = protectedProcedure
    .input(listInput)
    .output(
      strictOutput(
        createPaginatedResponseSchemaWithContext(listOutput, binding.entity),
      ),
    )
    .query(async ({ ctx, input }) => {
      const values = input as {
        filters: z.output<SFilters>;
        sort: SortInput;
        pagination: PaginationParams;
        groupBy?: string;
      };
      const result = await executeEntity(ctx, {
        action: "list",
        entity: binding.entity,
        filters: values.filters as Record<string, unknown>,
        sort: values.sort,
        pagination: values.pagination,
        groupBy: values.groupBy,
      });
      if (result.action !== "list")
        throw new Error("Entity kernel returned the wrong action");
      return asResolvedOutput({
        items: result.items as z.output<SList>[],
        meta: result.meta,
      });
    });

  const create = protectedProcedure
    .input(schemas.createInput)
    .output(strictOutput(mutationOutput))
    .mutation(async ({ ctx, input }) => {
      const result = await executeEntity(ctx, {
        action: "create",
        entity: binding.entity,
        data: input,
      } as unknown as EntityMutationCommand);
      if (result.action !== "create")
        throw new Error("Entity kernel returned the wrong action");
      return asResolvedOutput({
        ...(result.item as Record<string, unknown>),
        sideEffects: result.sideEffects,
      } as z.output<typeof mutationOutput>);
    });

  const update = protectedProcedure
    .input(z.object({ id: idSchema, data: schemas.updateInput }))
    .output(strictOutput(mutationOutput))
    .mutation(async ({ ctx, input }) => {
      const values = input as {
        id: z.output<SId>;
        data: z.output<SUpdate>;
      };
      const result = await executeEntity(ctx, {
        action: "update",
        entity: binding.entity,
        id: values.id,
        data: values.data,
      } as unknown as EntityMutationCommand);
      if (result.action !== "update")
        throw new Error("Entity kernel returned the wrong action");
      return asResolvedOutput({
        ...(result.item as Record<string, unknown>),
        sideEffects: result.sideEffects,
      } as z.output<typeof mutationOutput>);
    });

  const remove = protectedProcedure
    .input(z.object({ ids: z.array(idSchema).min(1).max(500) }))
    .output(
      strictOutput(
        z.object({
          deleted: z.number().int().nonnegative(),
          sideEffects: mutationSideEffectsSchema,
        }),
      ),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await executeEntity(ctx, {
        action: "delete",
        entity: binding.entity,
        ids: input.ids as string[],
      });
      if (result.action !== "delete")
        throw new Error("Entity kernel returned the wrong action");
      return { deleted: result.deleted, sideEffects: result.sideEffects };
    });

  return { getByID, getByShortcode, list, create, update, delete: remove };
}
