import { IDInput } from "@cubby/schemas/common";
import type { ActorContext } from "@cubby/schemas/context";
import type { Entity } from "@cubby/schemas/entity";
import type { UserId } from "@cubby/schemas/identifiers";
import {
  buildPaginatedResponse,
  createPaginatedResponseSchemaWithContext,
  type PaginationParams,
  type SortParams,
  sortPaginationCombo,
} from "@cubby/schemas/pagination";
import { type ZodSchema, z } from "zod";
import type { UPCLookupClient } from "~/server/clients/upc-lookup";
import type { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import type { IngredientService } from "~/server/services/ingredient.service";
import type { ProductService } from "~/server/services/product.service";
import type { RecipeCostingService } from "~/server/services/recipe-costing.service";
import { protectedProcedure } from "./trpc";

// Common input schema for update operations
const updateInputSchema = <T extends ZodSchema>(dataSchema: T) =>
  z.object({
    id: z.string(),
    data: dataSchema,
  });

/**
 * Base interface for services - used in public procedures where org may be null
 * @lintignore base interface extended by ProtectedCrudServices
 */
export interface CrudServices {
  db: Database;
  actorContext: ActorContext | null;
  services: {
    product: ProductService;
    ingredient: IngredientService;
    recipeCosting: RecipeCostingService;
  };
  usdaClient: USDAClient;
  upcLookupClient: UPCLookupClient;
  auth?: {
    userId: UserId | null;
    sessionId: string | null;
  };
}

/**
 * Extended interface for protected procedures where user is authenticated.
 * Use this type for repository callbacks in protected procedures to avoid
 * non-null assertions (!) on actorContext.
 */
interface ProtectedCrudServices extends CrudServices {
  actorContext: ActorContext;
}

// Reusable procedure builders
const createDeleteProcedure = <TId extends string = string>(
  deleteFn: (ctx: ProtectedCrudServices, ids: TId[]) => Promise<void>,
  idSchema?: z.ZodType<unknown>,
) =>
  protectedProcedure
    .input(z.object({ ids: z.array(idSchema ?? z.string()).max(500) }))
    .output(z.void())
    .mutation(async ({ ctx, input }) => {
      const ids = input.ids.map((id) =>
        idSchema ? (idSchema.parse(id) as TId) : (id as TId),
      );
      await deleteFn(ctx, ids);
    });

const createGetByIdProcedure = <T, TId extends string = string>(
  outputSchema: ZodSchema<T>,
  getByIdFn: (ctx: ProtectedCrudServices, id: TId) => Promise<T>,
  idSchema?: z.ZodType<unknown>,
) =>
  protectedProcedure
    .input(idSchema ? z.object({ id: idSchema }) : IDInput)
    .output(outputSchema)
    .query(({ ctx, input }) => {
      const id = idSchema
        ? (idSchema.parse(input.id) as TId)
        : (input.id as TId);
      return getByIdFn(ctx, id);
    });

// `inputSchema: S` (not `ZodSchema<TInput>`): annotating the param as
// ZodSchema<T> erases the schema's *input* type to `unknown` (Zod 4's ZodType
// input param defaults to unknown), which tRPC then exposes as the client
// mutation arg type — defeating compile-time checking of the payload. Keeping
// the concrete schema type `S` preserves `z.input<S>` end-to-end.
const createCreateProcedure = <S extends ZodSchema, TOutput>(
  inputSchema: S,
  outputSchema: ZodSchema<TOutput>,
  createFn: (ctx: ProtectedCrudServices, data: z.infer<S>) => Promise<TOutput>,
) =>
  protectedProcedure
    .input(inputSchema)
    .output(outputSchema)
    // `input` is cast back to `z.infer<S>` because tRPC can't resolve the parsed
    // type from the still-generic `S` inside this builder; the cast is local and
    // doesn't affect the procedure's public (concrete) input type at call sites.
    .mutation(({ ctx, input }) => createFn(ctx, input as z.infer<S>));

const createUpdateProcedure = <
  S extends ZodSchema,
  TOutput,
  TId extends string = string,
>(
  inputSchema: S,
  outputSchema: ZodSchema<TOutput>,
  updateFn: (
    ctx: ProtectedCrudServices,
    id: TId,
    data: z.infer<S>,
  ) => Promise<TOutput>,
  idSchema?: z.ZodType<unknown>,
) =>
  protectedProcedure
    .input(
      idSchema
        ? z.object({ id: idSchema, data: inputSchema })
        : updateInputSchema(inputSchema),
    )
    .output(outputSchema)
    .mutation(({ ctx, input }) => {
      // Cast back to the concrete shape: tRPC can't resolve the parsed type from
      // the generic `S` here (the public input type stays concrete at call sites).
      const { id: rawId, data } = input as { id: unknown; data: z.infer<S> };
      const id = idSchema ? (idSchema.parse(rawId) as TId) : (rawId as TId);
      return updateFn(ctx, id, data);
    });

// Simplified factory for just the list operation
export function createEntityListProcedure<TOutput, TFilters>({
  schemas,
  repository,
  entityName,
}: {
  schemas: {
    output: ZodSchema<TOutput>;
    filters: ZodSchema<TFilters>;
  };
  repository: {
    list: (
      ctx: ProtectedCrudServices,
      filters: TFilters,
      sort: SortParams,
      pagination: PaginationParams,
      groupBy?: string,
    ) => Promise<{ data: TOutput[]; count: number }>;
  };
  /** Entity type for enhanced error messages */
  entityName: Entity;
}) {
  const list = protectedProcedure
    .input(
      z
        .object({
          filters: schemas.filters,
        })
        .extend(sortPaginationCombo.shape),
    )
    .output(
      createPaginatedResponseSchemaWithContext(schemas.output, entityName),
    )
    .query(async ({ ctx, input }) => {
      const { data, count } = await repository.list(
        ctx,
        input.filters,
        input.sort,
        input.pagination,
        input.groupBy,
      );
      return buildPaginatedResponse(input.pagination, data, count);
    });

  return { list };
}

// Factory for getByID, create, update operations (without list)
export function createEntityCrudWithoutListProcedures<
  SCreate extends ZodSchema,
  SUpdate extends ZodSchema,
  TOutput,
  TId extends string = string,
>({
  schemas,
  repository,
}: {
  schemas: {
    createInput: SCreate;
    updateInput: SUpdate;
    output: ZodSchema<TOutput>;
    idSchema?: z.ZodType<unknown>;
  };
  repository: {
    getByID: (ctx: ProtectedCrudServices, id: TId) => Promise<TOutput>;
    create: (
      ctx: ProtectedCrudServices,
      data: z.infer<SCreate>,
    ) => Promise<TOutput>;
    update: (
      ctx: ProtectedCrudServices,
      id: TId,
      data: z.infer<SUpdate>,
    ) => Promise<TOutput>;
  };
}) {
  return {
    getByID: createGetByIdProcedure(
      schemas.output,
      repository.getByID,
      schemas.idSchema,
    ),
    create: createCreateProcedure(
      schemas.createInput,
      schemas.output,
      repository.create,
    ),
    update: createUpdateProcedure(
      schemas.updateInput,
      schemas.output,
      repository.update,
      schemas.idSchema,
    ),
  };
}

// Generic CRUD procedures factory for entities
export function createEntityCrudProcedures<
  SCreate extends ZodSchema,
  SUpdate extends ZodSchema,
  TOutput,
  TFilters,
  TId extends string = string,
>({
  schemas,
  repository,
  entityName,
}: {
  schemas: {
    createInput: SCreate;
    updateInput: SUpdate;
    output: ZodSchema<TOutput>;
    filters: ZodSchema<TFilters>;
    idSchema?: z.ZodType<unknown>;
  };
  repository: {
    getByID: (ctx: ProtectedCrudServices, id: TId) => Promise<TOutput>;
    list: (
      ctx: ProtectedCrudServices,
      filters: TFilters,
      sort: SortParams,
      pagination: PaginationParams,
      groupBy?: string,
    ) => Promise<{ data: TOutput[]; count: number }>;
    create: (
      ctx: ProtectedCrudServices,
      data: z.infer<SCreate>,
    ) => Promise<TOutput>;
    update: (
      ctx: ProtectedCrudServices,
      id: TId,
      data: z.infer<SUpdate>,
    ) => Promise<TOutput>;
  };
  /** Entity type for enhanced error messages */
  entityName: Entity;
}) {
  const { list } = createEntityListProcedure({
    schemas: {
      output: schemas.output,
      filters: schemas.filters,
    },
    repository: {
      list: repository.list,
    },
    entityName,
  });

  const { getByID, create, update } = createEntityCrudWithoutListProcedures({
    schemas: {
      createInput: schemas.createInput,
      updateInput: schemas.updateInput,
      output: schemas.output,
      idSchema: schemas.idSchema,
    },
    repository: {
      getByID: repository.getByID,
      create: repository.create,
      update: repository.update,
    },
  });

  return {
    getByID,
    list,
    create,
    update,
  };
}

/**
 * Creates a standalone delete procedure
 * Use this when you need delete functionality but want to keep it separate from CRUD
 */
export { createDeleteProcedure };
