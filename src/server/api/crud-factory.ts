import { z, type ZodSchema } from "zod";
import { type PrismaClient } from "@prisma/client";
import { publicProcedure } from "./trpc";
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

// Reusable procedure builders
const createGetByIdProcedure = <T>(
  outputSchema: ZodSchema<T>,
  getByIdFn: (db: PrismaClient, id: string) => Promise<T>,
) =>
  publicProcedure
    .input(IDInput)
    .output(outputSchema)
    .query(async ({ ctx, input }) => getByIdFn(ctx.db, input.id));

const createCreateProcedure = <TInput, TOutput>(
  inputSchema: ZodSchema<TInput>,
  outputSchema: ZodSchema<TOutput>,
  createFn: (db: PrismaClient, data: TInput) => Promise<TOutput>,
) =>
  publicProcedure
    .input(inputSchema)
    .output(outputSchema)
    .mutation(async ({ ctx, input }) => createFn(ctx.db, input as TInput));

const createUpdateProcedure = <TInput, TOutput>(
  inputSchema: ZodSchema<TInput>,
  outputSchema: ZodSchema<TOutput>,
  updateFn: (db: PrismaClient, id: string, data: TInput) => Promise<TOutput>,
) =>
  publicProcedure
    .input(updateInputSchema(inputSchema))
    .output(outputSchema)
    .mutation(async ({ ctx, input }) => updateFn(ctx.db, input.id, input.data));

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
      db: PrismaClient,
      filters: TFilters,
      sort: SortParams,
      pagination: PaginationParams,
    ) => Promise<{ data: TOutput[]; count: number }>;
  };
}) {
  const list = publicProcedure
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
        ctx.db,
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
    getByID: (db: PrismaClient, id: string) => Promise<TOutput>;
    create: (db: PrismaClient, data: TCreateInput) => Promise<TOutput>;
    update: (
      db: PrismaClient,
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
    getByID: (db: PrismaClient, id: string) => Promise<TOutput>;
    list: (
      db: PrismaClient,
      filters: TFilters,
      sort: SortParams,
      pagination: PaginationParams,
    ) => Promise<{ data: TOutput[]; count: number }>;
    create: (db: PrismaClient, data: TCreateInput) => Promise<TOutput>;
    update: (
      db: PrismaClient,
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
