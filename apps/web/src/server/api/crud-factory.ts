import { z, type ZodSchema } from "zod";
import { type Database } from "~/server/db";
import { protectedProcedure } from "./trpc";
import { type ProductService } from "~/server/services/product.service";
import { type IngredientService } from "~/server/services/ingredient.service";
import { type USDAClient } from "~/server/clients/usda";
import { type UPCLookupClient } from "~/server/clients/upc-lookup";
import { IDInput } from "~/schemas/common";
import {
  buildPaginatedResponse,
  createPaginatedResponseSchemaWithContext,
  sortPaginationCombo,
  type SortParams,
  type PaginationParams,
} from "~/schemas/pagination";
import { UserId, type OrganizationId } from "~/schemas/identifiers";
import { type ActorContext } from "~/schemas/context";
import { type Entity } from "~/entities/types";

// Common input schema for update operations
const updateInputSchema = <T extends ZodSchema>(dataSchema: T) =>
  z.object({
    id: z.string(),
    data: dataSchema,
  });

// Base interface for services - used in public procedures where org may be null
export interface CrudServices {
  db: Database;
  organizationId: OrganizationId | null;
  actorContext: ActorContext | null;
  services: {
    product: ProductService;
    ingredient: IngredientService;
  };
  usdaClient: USDAClient;
  upcLookupClient: UPCLookupClient;
  auth?: {
    userId: UserId | null;
    sessionId: string | null;
  };
}

/**
 * Extended interface for protected procedures where organization is guaranteed.
 * Use this type for repository callbacks in protected procedures to avoid
 * non-null assertions (!) on organizationId and actorContext.
 */
export interface ProtectedCrudServices extends CrudServices {
  organizationId: OrganizationId;
  actorContext: ActorContext;
}

// Reusable procedure builders
const createDeleteProcedure = <TId extends string = string>(
  deleteFn: (ctx: ProtectedCrudServices, id: TId) => Promise<void>,
  idSchema?: z.ZodType<unknown>,
) =>
  protectedProcedure
    .input(idSchema ? z.object({ id: idSchema }) : IDInput)
    .output(z.void())
    .mutation(async ({ ctx, input }) => {
      const id = idSchema
        ? (idSchema.parse(input.id) as TId)
        : (input.id as TId);
      await deleteFn(ctx, id);
    });

const createGetByIdProcedure = <T, TId extends string = string>(
  outputSchema: ZodSchema<T>,
  getByIdFn: (ctx: ProtectedCrudServices, id: TId) => Promise<T>,
  idSchema?: z.ZodType<unknown>,
) =>
  protectedProcedure
    .input(idSchema ? z.object({ id: idSchema }) : IDInput)
    .output(outputSchema)
    .query(async ({ ctx, input }) => {
      const id = idSchema
        ? (idSchema.parse(input.id) as TId)
        : (input.id as TId);
      return getByIdFn(ctx, id);
    });

const createCreateProcedure = <TInput, TOutput>(
  inputSchema: ZodSchema<TInput>,
  outputSchema: ZodSchema<TOutput>,
  createFn: (ctx: ProtectedCrudServices, data: TInput) => Promise<TOutput>,
) =>
  protectedProcedure
    .input(inputSchema)
    .output(outputSchema)
    .mutation(async ({ ctx, input }) => createFn(ctx, input as TInput));

const createUpdateProcedure = <TInput, TOutput, TId extends string = string>(
  inputSchema: ZodSchema<TInput>,
  outputSchema: ZodSchema<TOutput>,
  updateFn: (
    ctx: ProtectedCrudServices,
    id: TId,
    data: TInput,
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
    .mutation(async ({ ctx, input }) => {
      const id = idSchema
        ? (idSchema.parse(input.id) as TId)
        : (input.id as TId);
      return updateFn(ctx, id, input.data);
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
      );
      return buildPaginatedResponse(input.pagination, data, count);
    });

  return { list };
}

// Factory for getByID, create, update operations (without list)
export function createEntityCrudWithoutListProcedures<
  TCreateInput,
  TUpdateInput,
  TOutput,
  TId extends string = string,
>({
  schemas,
  repository,
}: {
  schemas: {
    createInput: ZodSchema<TCreateInput>;
    updateInput: ZodSchema<TUpdateInput>;
    output: ZodSchema<TOutput>;
    idSchema?: z.ZodType<unknown>;
  };
  repository: {
    getByID: (ctx: ProtectedCrudServices, id: TId) => Promise<TOutput>;
    create: (
      ctx: ProtectedCrudServices,
      data: TCreateInput,
    ) => Promise<TOutput>;
    update: (
      ctx: ProtectedCrudServices,
      id: TId,
      data: TUpdateInput,
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
  TCreateInput,
  TUpdateInput,
  TOutput,
  TFilters,
  TId extends string = string,
>({
  schemas,
  repository,
  entityName,
}: {
  schemas: {
    createInput: ZodSchema<TCreateInput>;
    updateInput: ZodSchema<TUpdateInput>;
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
    ) => Promise<{ data: TOutput[]; count: number }>;
    create: (
      ctx: ProtectedCrudServices,
      data: TCreateInput,
    ) => Promise<TOutput>;
    update: (
      ctx: ProtectedCrudServices,
      id: TId,
      data: TUpdateInput,
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
