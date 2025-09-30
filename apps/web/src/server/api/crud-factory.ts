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

// Common input schema for update operations
const updateInputSchema = <T extends ZodSchema>(dataSchema: T) =>
  z.object({
    id: z.string(),
    data: dataSchema,
  });

// Interface for services needed by CRUD operations
export interface CrudServices {
  db: PrismaClient;
  projectId: string;
  services: {
    product: ProductService;
    ingredient: IngredientService;
  };
  usdaClient: USDAClient;
}

// Reusable procedure builders
const createGetByIdProcedure = <T>(
  outputSchema: ZodSchema<T>,
  getByIdFn: (ctx: CrudServices, id: string) => Promise<T>,
) =>
  protectedProcedure
    .input(IDInput)
    .output(outputSchema)
    .query(async ({ ctx, input }) => getByIdFn(ctx, input.id));

const createCreateProcedure = <TInput, TOutput>(
  inputSchema: ZodSchema<TInput>,
  outputSchema: ZodSchema<TOutput>,
  createFn: (ctx: CrudServices, data: TInput) => Promise<TOutput>,
) =>
  protectedProcedure
    .input(inputSchema)
    .output(outputSchema)
    .mutation(async ({ ctx, input }) => createFn(ctx, input as TInput));

const createUpdateProcedure = <TInput, TOutput>(
  inputSchema: ZodSchema<TInput>,
  outputSchema: ZodSchema<TOutput>,
  updateFn: (ctx: CrudServices, id: string, data: TInput) => Promise<TOutput>,
) =>
  protectedProcedure
    .input(updateInputSchema(inputSchema))
    .output(outputSchema)
    .mutation(async ({ ctx, input }) => updateFn(ctx, input.id, input.data));

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
>({
  schemas,
  repository,
}: {
  schemas: {
    createInput: ZodSchema<TCreateInput>;
    updateInput: ZodSchema<TUpdateInput>;
    output: ZodSchema<TOutput>;
  };
  repository: {
    getByID: (ctx: CrudServices, id: string) => Promise<TOutput>;
    create: (ctx: CrudServices, data: TCreateInput) => Promise<TOutput>;
    update: (
      ctx: CrudServices,
      id: string,
      data: TUpdateInput,
    ) => Promise<TOutput>;
  };
}) {
  return {
    getByID: createGetByIdProcedure(schemas.output, repository.getByID),
    create: createCreateProcedure(
      schemas.createInput,
      schemas.output,
      repository.create,
    ),
    update: createUpdateProcedure(
      schemas.updateInput,
      schemas.output,
      repository.update,
    ),
  };
}

// Generic CRUD procedures factory for entities
export function createEntityCrudProcedures<
  TCreateInput,
  TUpdateInput,
  TOutput,
  TFilters,
>({
  schemas,
  repository,
}: {
  schemas: {
    createInput: ZodSchema<TCreateInput>;
    updateInput: ZodSchema<TUpdateInput>;
    output: ZodSchema<TOutput>;
    filters: ZodSchema<TFilters>;
  };
  repository: {
    getByID: (ctx: CrudServices, id: string) => Promise<TOutput>;
    list: (
      ctx: CrudServices,
      filters: TFilters,
      sort: SortParams,
      pagination: PaginationParams,
    ) => Promise<{ data: TOutput[]; count: number }>;
    create: (ctx: CrudServices, data: TCreateInput) => Promise<TOutput>;
    update: (
      ctx: CrudServices,
      id: string,
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
