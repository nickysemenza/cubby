import {
  createPaginatedResponseSchemaWithContext,
  createSortPaginationFields,
  type PaginationParams,
  type SortInput,
} from "@cubby/schemas/pagination";
import type { TRPCUnsetMarker } from "@trpc/server";
import { type ZodSchema, z } from "zod";
import { executeEntity } from "~/server/entity-kernel";
import type { EntityKernelEntity } from "~/server/entity-kernel/contracts";
import { protectedProcedure, strictOutput } from "./trpc";

const asResolvedOutput = <T>(value: T): T extends TRPCUnsetMarker ? never : T =>
  value as T extends TRPCUnsetMarker ? never : T;

/**
 * Temporary list compatibility for named entity routers.
 *
 * These procedures contain no domain behavior: each maps the old route shape
 * to the kernel list command and unwraps its normalized envelope. Generic
 * detail reads and writes use Start functions while specialized list
 * projections and workflows remain on tRPC.
 */
export function createEntityListCompatibilityProcedure<
  const E extends Exclude<EntityKernelEntity, "image">,
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
    output: SOutput;
    listOutput?: SList;
  },
) {
  const listInput = z.object({
    filters: binding.filters,
    ...createSortPaginationFields({
      sortableFields: binding.sort.fields,
      defaultSort: binding.sort.default,
      groupableFields: binding.sort.groupable,
    }),
  });
  const listOutput = (schemas.listOutput ?? schemas.output) as SList;
  return protectedProcedure
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
}
