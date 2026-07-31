import {
  type BackgroundBatchRef,
  mutationSideEffectsSchema,
} from "@cubby/schemas/background-jobs";
import { IDInput } from "@cubby/schemas/common";
import type { ActorContext } from "@cubby/schemas/context";
import type { Entity } from "@cubby/schemas/entity";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import type { UserId } from "@cubby/schemas/identifiers";
import { shortcodeSchema } from "@cubby/schemas/identifiers";
import {
  buildPaginatedResponse,
  createPaginatedResponseSchemaWithContext,
  createSortPaginationFields,
  normalizeSorts,
  type PaginationParams,
  type SortParams,
  sortPaginationFields,
} from "@cubby/schemas/pagination";
import type { SearchableEntity } from "@cubby/schemas/search";
import { type ZodSchema, z } from "zod";
import type { UPCLookupClient } from "~/server/clients/upc-lookup";
import type { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import type { AvailabilityService } from "~/server/services/availability.service";
import type { LocationValuationService } from "~/server/services/location-valuation.service";
import { runMutationSideEffects } from "~/server/services/mutation-side-effects";
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
    availability: AvailabilityService;
    recipeCosting: RecipeCostingService;
    locationValuation: LocationValuationService;
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
  deleteFn: (
    ctx: ProtectedCrudServices,
    ids: TId[],
  ) => Promise<BackgroundBatchRef[] | undefined>,
  idSchema?: z.ZodType<unknown>,
) =>
  protectedProcedure
    .input(z.object({ ids: z.array(idSchema ?? z.string()).max(500) }))
    .output(z.object({ sideEffects: mutationSideEffectsSchema }))
    .mutation(async ({ ctx, input }) => {
      const ids = input.ids.map((id) =>
        idSchema ? (idSchema.parse(id) as TId) : (id as TId),
      );
      const backgroundBatches = (await deleteFn(ctx, ids)) ?? [];
      return { sideEffects: { backgroundBatches } };
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

/**
 * Fetch by PUBLIC id. Every entity detail route enters through one of these.
 *
 * The input schema is the entity's own `shortcodeSchema`, not a loose string, so
 * a code with the wrong prefix (`LOC-4K7M` sent to `product.getByShortcode`) is
 * rejected by zod at the boundary — before any query runs and before it could
 * resolve to a uuid of the wrong type. The output is nullable because a URL is
 * user-supplied: an unknown code is a 404 for the route to render, not a throw.
 */
export const createGetByShortcodeProcedure = <T>(
  entity: ShortcodeEntity,
  outputSchema: ZodSchema<T>,
  getByShortcodeFn: (
    ctx: ProtectedCrudServices,
    shortcode: string,
  ) => Promise<T | null>,
) =>
  protectedProcedure
    .input(z.object({ shortcode: shortcodeSchema(entity) }))
    .output(outputSchema.nullable())
    .query(({ ctx, input }) => getByShortcodeFn(ctx, input.shortcode));

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
    sort?: {
      sortableFields: readonly [string, ...string[]];
      defaultSort: string;
      groupableFields?: readonly [string, ...string[]];
    };
  };
  repository: {
    list: (
      ctx: ProtectedCrudServices,
      filters: TFilters,
      /** Normalized (non-empty, deduped, capped) — see normalizeSorts. */
      sorts: SortParams[],
      pagination: PaginationParams,
      groupBy?: string,
    ) => Promise<{
      data: TOutput[];
      count: number;
      /** Optional full-filtered-set column aggregates (footer totals). */
      sums?: Record<string, number>;
    }>;
  };
  /** Entity type for enhanced error messages */
  entityName: Entity;
}) {
  const sortFields = schemas.sort
    ? createSortPaginationFields({
        sortableFields: schemas.sort.sortableFields,
        defaultSort: schemas.sort.defaultSort,
        groupableFields: schemas.sort.groupableFields,
      })
    : sortPaginationFields;

  const list = protectedProcedure
    .input(
      z.object({
        filters: schemas.filters,
        ...sortFields,
      }),
    )
    .output(
      createPaginatedResponseSchemaWithContext(schemas.output, entityName),
    )
    .query(async ({ ctx, input }) => {
      const { data, count, sums } = await repository.list(
        ctx,
        input.filters,
        normalizeSorts(input.sort),
        input.pagination,
        input.groupBy,
      );
      return buildPaginatedResponse(input.pagination, data, count, sums);
    });

  return { list };
}

// Factory for getByID, create, update operations (without list)
export function createEntityCrudWithoutListProcedures<
  SCreate extends ZodSchema,
  SUpdate extends ZodSchema,
  TDetailOutput,
  TCreateOutput = TDetailOutput,
  TUpdateOutput = TDetailOutput,
  TId extends string = string,
>({
  entityName,
  schemas,
  repository,
}: {
  /** Drives the prefix the public `getByShortcode` input accepts. */
  entityName: ShortcodeEntity;
  schemas: {
    createInput: SCreate;
    updateInput: SUpdate;
    /** Default output for get/create/update. */
    output: ZodSchema<TDetailOutput>;
    /** Override when getByID carries a different shape than mutations. */
    detailOutput?: ZodSchema<TDetailOutput>;
    /** Override when create returns a different shape than detail. */
    createOutput?: ZodSchema<TCreateOutput>;
    /** Override when update returns a different shape than detail/create. */
    updateOutput?: ZodSchema<TUpdateOutput>;
    idSchema?: z.ZodType<unknown>;
  };
  repository: {
    getByID: (ctx: ProtectedCrudServices, id: TId) => Promise<TDetailOutput>;
    /** Public-id read — `null` for an unknown code, which the route 404s on. */
    getByShortcode: (
      ctx: ProtectedCrudServices,
      shortcode: string,
    ) => Promise<TDetailOutput | null>;
    create: (
      ctx: ProtectedCrudServices,
      data: z.infer<SCreate>,
    ) => Promise<TCreateOutput>;
    update: (
      ctx: ProtectedCrudServices,
      id: TId,
      data: z.infer<SUpdate>,
    ) => Promise<TUpdateOutput>;
  };
}) {
  const detailOutput = schemas.detailOutput ?? schemas.output;
  const createOutput = (schemas.createOutput ??
    schemas.output) as ZodSchema<TCreateOutput>;
  const updateOutput = (schemas.updateOutput ??
    schemas.output) as ZodSchema<TUpdateOutput>;

  return {
    getByID: createGetByIdProcedure(
      detailOutput,
      repository.getByID,
      schemas.idSchema,
    ),
    getByShortcode: createGetByShortcodeProcedure(
      entityName,
      detailOutput,
      repository.getByShortcode,
    ),
    create: createCreateProcedure(
      schemas.createInput,
      createOutput,
      repository.create,
    ),
    update: createUpdateProcedure(
      schemas.updateInput,
      updateOutput,
      repository.update,
      schemas.idSchema,
    ),
  };
}

// Generic CRUD procedures factory for entities. Every current entity router
// goes through the searchable wrapper below; this base stays internal.
function createEntityCrudProcedures<
  SCreate extends ZodSchema,
  SUpdate extends ZodSchema,
  TDetailOutput,
  TFilters,
  TListOutput = TDetailOutput,
  TCreateOutput = TDetailOutput,
  TUpdateOutput = TDetailOutput,
  TId extends string = string,
>({
  schemas,
  repository,
  entityName,
}: {
  schemas: {
    createInput: SCreate;
    updateInput: SUpdate;
    /** Default output for every operation unless an operation-specific schema is supplied. */
    output: ZodSchema<TDetailOutput>;
    listOutput?: ZodSchema<TListOutput>;
    detailOutput?: ZodSchema<TDetailOutput>;
    createOutput?: ZodSchema<TCreateOutput>;
    updateOutput?: ZodSchema<TUpdateOutput>;
    filters: ZodSchema<TFilters>;
    sort?: {
      sortableFields: readonly [string, ...string[]];
      defaultSort: string;
      groupableFields?: readonly [string, ...string[]];
    };
    idSchema?: z.ZodType<unknown>;
  };
  repository: {
    getByID: (ctx: ProtectedCrudServices, id: TId) => Promise<TDetailOutput>;
    /** Public-id read — `null` for an unknown code, which the route 404s on. */
    getByShortcode: (
      ctx: ProtectedCrudServices,
      shortcode: string,
    ) => Promise<TDetailOutput | null>;
    list: (
      ctx: ProtectedCrudServices,
      filters: TFilters,
      /** Normalized (non-empty, deduped, capped) — see normalizeSorts. */
      sorts: SortParams[],
      pagination: PaginationParams,
      groupBy?: string,
    ) => Promise<{ data: TListOutput[]; count: number }>;
    create: (
      ctx: ProtectedCrudServices,
      data: z.infer<SCreate>,
    ) => Promise<TCreateOutput>;
    update: (
      ctx: ProtectedCrudServices,
      id: TId,
      data: z.infer<SUpdate>,
    ) => Promise<TUpdateOutput>;
  };
  /** Drives the prefix the public `getByShortcode` input accepts. */
  entityName: ShortcodeEntity;
}) {
  const { list } = createEntityListProcedure<TListOutput, TFilters>({
    schemas: {
      output: (schemas.listOutput ?? schemas.output) as ZodSchema<TListOutput>,
      filters: schemas.filters,
      sort: schemas.sort,
    },
    repository: {
      list: repository.list,
    },
    entityName,
  });

  const { getByID, getByShortcode, create, update } =
    createEntityCrudWithoutListProcedures({
      entityName,
      schemas: {
        createInput: schemas.createInput,
        updateInput: schemas.updateInput,
        output: schemas.output,
        detailOutput: schemas.detailOutput,
        createOutput: schemas.createOutput,
        updateOutput: schemas.updateOutput,
        idSchema: schemas.idSchema,
      },
      repository: {
        getByID: repository.getByID,
        getByShortcode: repository.getByShortcode,
        create: repository.create,
        update: repository.update,
      },
    });

  return {
    getByID,
    getByShortcode,
    list,
    create,
    update,
  };
}

/**
 * Standard CRUD for searchable entities whose create/update mutations refresh
 * embeddings.
 *
 * `TId` is the PUBLIC id the router accepts (a uuid for entities not yet cut
 * over to shortcodes, a shortcode for ones that are — see `idSchema`); `TEntityId`
 * is the INTERNAL uuid `runMutationSideEffects`/`EntityEmbedding` require,
 * which is a DB implementation detail and never equal to `TId` once an
 * entity's public id is a shortcode. Because `TOutput` (the shape returned to
 * the client) therefore can't carry `TEntityId` — that would put a uuid back
 * on the wire, the exact thing the shortcode cutover exists to prevent —
 * `repository.create`/`update` return `{ output, entityId }`: `output` is
 * what the procedure returns, `entityId` is what only the side-effect
 * dispatch below ever sees.
 */
export function createSearchableEntityCrudProcedures<
  SCreate extends ZodSchema,
  SUpdate extends ZodSchema,
  TEntity extends SearchableEntity,
  TEntityId extends Extract<
    Parameters<typeof runMutationSideEffects>[1]["entity"],
    { entityType: TEntity }
  >["entityId"],
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
    sort?: {
      sortableFields: readonly [string, ...string[]];
      defaultSort: string;
      groupableFields?: readonly [string, ...string[]];
    };
    idSchema: z.ZodType<unknown>;
  };
  repository: {
    getByID: (ctx: ProtectedCrudServices, id: TId) => Promise<TOutput>;
    /** Public-id read — `null` for an unknown code, which the route 404s on. */
    getByShortcode: (
      ctx: ProtectedCrudServices,
      shortcode: string,
    ) => Promise<TOutput | null>;
    list: (
      ctx: ProtectedCrudServices,
      filters: TFilters,
      sorts: SortParams[],
      pagination: PaginationParams,
      groupBy?: string,
    ) => Promise<{ data: TOutput[]; count: number }>;
    create: (
      ctx: ProtectedCrudServices,
      data: z.infer<SCreate>,
    ) => Promise<{ output: TOutput; entityId: TEntityId }>;
    update: (
      ctx: ProtectedCrudServices,
      id: TId,
      data: z.infer<SUpdate>,
    ) => Promise<{ output: TOutput; entityId: TEntityId }>;
    delete: (
      ctx: ProtectedCrudServices,
      ids: TId[],
    ) => Promise<BackgroundBatchRef[] | undefined>;
  };
  entityName: TEntity;
}) {
  const entityRef = (entityId: TEntityId) =>
    ({ entityType: entityName, entityId }) as Extract<
      Parameters<typeof runMutationSideEffects>[1]["entity"],
      { entityType: TEntity }
    >;
  const procedures = createEntityCrudProcedures({
    schemas,
    repository: {
      getByID: repository.getByID,
      getByShortcode: repository.getByShortcode,
      list: repository.list,
      create: async (ctx, data) => {
        const { output, entityId } = await repository.create(ctx, data);
        await runMutationSideEffects(ctx.db, {
          action: "created",
          entity: entityRef(entityId),
          source: `${entityName}.create`,
        });
        return output;
      },
      update: async (ctx, id: TId, data) => {
        const { output, entityId } = await repository.update(ctx, id, data);
        await runMutationSideEffects(ctx.db, {
          action: "updated",
          entity: entityRef(entityId),
          source: `${entityName}.update`,
        });
        return output;
      },
    },
    entityName,
  });

  return {
    ...procedures,
    delete: createDeleteProcedure(repository.delete, schemas.idSchema),
  };
}

/**
 * Creates a standalone delete procedure
 * Use this when you need delete functionality but want to keep it separate from CRUD
 */
export { createDeleteProcedure };
