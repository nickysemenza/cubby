import { z, type ZodSchema } from "zod";
import { type PrismaClient } from "@prisma/client";
import { protectedProcedure } from "./trpc";
import { type ProductService } from "~/server/services/product.service";
import { type IngredientService } from "~/server/services/ingredient.service";
import { type USDAClient } from "~/server/clients/usda";
import { IDInput } from "~/schemas/common";
import {
  buildPaginatedResponse,
  createPaginatedResponseSchema,
  sortPaginationCombo,
  type SortParams,
  type PaginationParams,
} from "~/schemas/pagination";
import { ProjectId } from "~/schemas/identifiers";

// Common input schema for update operations
const updateInputSchema = <T extends ZodSchema>(dataSchema: T) =>
  z.object({
    id: z.string(),
    data: dataSchema,
  });

// Interface for services needed by CRUD operations
export interface CrudServices {
  db: PrismaClient;
  projectId: ProjectId;
  services: {
    product: ProductService;
    ingredient: IngredientService;
  };
  usdaClient: USDAClient;
}

// Reusable procedure builders
const createGetByIdProcedure = <T, TId extends string = string>(
  outputSchema: ZodSchema<T>,
  getByIdFn: (ctx: CrudServices, id: TId) => Promise<T>,
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
  createFn: (ctx: CrudServices, data: TInput) => Promise<TOutput>,
) =>
  protectedProcedure
    .input(inputSchema)
    .output(outputSchema)
    .mutation(async ({ ctx, input }) => createFn(ctx, input as TInput));

const createUpdateProcedure = <TInput, TOutput, TId extends string = string>(
  inputSchema: ZodSchema<TInput>,
  outputSchema: ZodSchema<TOutput>,
  updateFn: (ctx: CrudServices, id: TId, data: TInput) => Promise<TOutput>,
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
}: {
  schemas: {
    output: ZodSchema<TOutput>;
    filters: ZodSchema<TFilters>;
  };
  repository: {
    list: (
      ctx: CrudServices,
      filters: TFilters,
      sort: SortParams,
      pagination: PaginationParams,
    ) => Promise<{ data: TOutput[]; count: number }>;
  };
}) {
  const list = protectedProcedure
    .input(
      z
        .object({
          filters: schemas.filters,
        })
        .extend(sortPaginationCombo.shape),
    )
    .output(createPaginatedResponseSchema(schemas.output))
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
    getByID: (ctx: CrudServices, id: TId) => Promise<TOutput>;
    create: (ctx: CrudServices, data: TCreateInput) => Promise<TOutput>;
    update: (
      ctx: CrudServices,
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
}: {
  schemas: {
    createInput: ZodSchema<TCreateInput>;
    updateInput: ZodSchema<TUpdateInput>;
    output: ZodSchema<TOutput>;
    filters: ZodSchema<TFilters>;
    idSchema?: z.ZodType<unknown>;
  };
  repository: {
    getByID: (ctx: CrudServices, id: TId) => Promise<TOutput>;
    list: (
      ctx: CrudServices,
      filters: TFilters,
      sort: SortParams,
      pagination: PaginationParams,
    ) => Promise<{ data: TOutput[]; count: number }>;
    create: (ctx: CrudServices, data: TCreateInput) => Promise<TOutput>;
    update: (
      ctx: CrudServices,
      id: TId,
      data: TUpdateInput,
    ) => Promise<TOutput>;
  };
}) {
  const { list } = createEntityListProcedure({
    schemas: {
      output: schemas.output,
      filters: schemas.filters,
    },
    repository: {
      list: repository.list,
    },
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
