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
import type { TRPCUnsetMarker } from "@trpc/server";
import { type ZodSchema, z } from "zod";
import type { UPCLookupClient } from "~/server/clients/upc-lookup";
import type { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import { resolveAllPresent } from "~/server/repo/shortcode-resolver";
import type { AvailabilityService } from "~/server/services/availability.service";
import type { LocationValuationService } from "~/server/services/location-valuation.service";
import {
  mutationSideEffectEventSchema,
  runMutationSideEffects,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import type { RecipeCostingService } from "~/server/services/recipe-costing.service";
import { protectedProcedure, strictOutput } from "./trpc";

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

/**
 * Widen a resolver's value past tRPC's internal `DefaultValue<TOutputIn, $Output>`.
 *
 * `.output(strictOutput(schema))` sets tRPC's `TOutputIn` to the schema's
 * PARSED type, and a resolver is then checked against
 * `TOutputIn extends UnsetMarker ? $Output : TOutputIn`. TypeScript reduces
 * that conditional only when the check type is concrete enough for permissive
 * instantiation to prove it is not `UnsetMarker` — true at the router call
 * sites, and true for the paginated envelope below (an object-literal type),
 * but never for an output type that is still a generic parameter of this
 * factory. Restating the same conditional on the source side makes the two
 * relate, which is all this does: `UnsetMarker` is a tRPC-private brand no Zod
 * output can inhabit, so the true branch is unreachable, and `never` would be
 * the correct value there if it weren't.
 *
 * The brand check `strictOutput` exists to perform is unaffected — it happens
 * one line up, on the repository callback's declared `z.output<TSchema>`
 * return type, which is where a UUID-for-shortcode mix-up would actually
 * originate.
 */
const asResolvedOutput = <T>(value: T): T extends TRPCUnsetMarker ? never : T =>
  value as T extends TRPCUnsetMarker ? never : T;

/**
 * One committed bulk write followed by one embedding/derived-data wave.
 *
 * Deliberately narrow: every migrated operation changes one searchable entity
 * kind and returns rows with public ids. Mixed actions, deletes, and operations
 * with conditional side effects remain explicit at their call sites.
 */
export function createBulkUpdatedMutation<
  SInput extends ZodSchema,
  SItem extends ZodSchema,
  TEntity extends SearchableEntity & ShortcodeEntity,
>({
  input,
  itemOutput,
  entity,
  source,
  mutate,
  entityShortcodes,
}: {
  input: SInput;
  itemOutput: SItem;
  source: string;
  entity: TEntity;
  mutate: (
    ctx: ProtectedCrudServices,
    input: z.output<SInput>,
  ) => Promise<z.output<SItem>[]>;
  entityShortcodes: (
    items: z.output<SItem>[],
    input: z.output<SInput>,
  ) => string[];
}) {
  const output = z.object({
    items: z.array(itemOutput),
    sideEffects: mutationSideEffectsSchema,
  });
  return protectedProcedure
    .input(input)
    .output(strictOutput(output))
    .mutation(async ({ ctx, input: values }) => {
      const typedValues = values as z.output<SInput>;
      const items = await mutate(ctx, typedValues);
      const ids = await resolveAllPresent(
        ctx.db,
        entity,
        entityShortcodes(items, typedValues),
      );
      const backgroundBatches = await runMutationSideEffectsForEntities(
        ctx.db,
        ids.map((entityId) =>
          mutationSideEffectEventSchema.parse({
            action: "updated",
            entity: { entityType: entity, entityId },
            source,
          }),
        ),
      );
      return asResolvedOutput({
        items,
        sideEffects: { backgroundBatches },
      });
    });
}

/**
 * What a delete adapter reports back to {@link createDeleteProcedure}.
 *
 * `deleted` must be MEASURED — read off whatever the repo delete actually
 * removed (`removeEntity`'s own `deleted`, or a repo function that forwards
 * it), never assumed from the caller's `ids.length`. `deleteTasks`'s
 * one-level subtask cascade is the case that makes the distinction real: it
 * removes more rows than were requested, so an input-length count would
 * silently undercount there while looking correct everywhere else.
 * `backgroundBatches` is unrelated and optional, same as before.
 */
export type DeleteResult = {
  deleted: number;
  backgroundBatches?: BackgroundBatchRef[];
};

// Reusable procedure builders
const createDeleteProcedure = <TId extends string = string>(
  deleteFn: (ctx: ProtectedCrudServices, ids: TId[]) => Promise<DeleteResult>,
  idSchema?: z.ZodType<unknown>,
) =>
  protectedProcedure
    .input(
      z.object({
        ids: z
          .array(idSchema ?? z.string())
          .min(1)
          .max(500),
      }),
    )
    .output(
      strictOutput(
        z.object({
          sideEffects: mutationSideEffectsSchema,
          deleted: z.number(),
        }),
      ),
    )
    .mutation(async ({ ctx, input }) => {
      const ids = input.ids.map((id) =>
        idSchema ? (idSchema.parse(id) as TId) : (id as TId),
      );
      const { deleted, backgroundBatches = [] } = await deleteFn(ctx, ids);
      return { sideEffects: { backgroundBatches }, deleted };
    });

// FIXED (was: the four builders here could not take `strictOutput`). The old
// signature was `<T>(outputSchema: ZodSchema<T>, fn: () => Promise<T>)`, which
// left `T` a naked unresolved generic; `strictOutput` then made tRPC check the
// resolver against `DefaultValue<T, T>`, a conditional TypeScript reduces for
// no generic T at all (reproducible with zero zod/trpc code:
// `function f<T>(x: T): (T extends Marker ? T : T) { return x }` fails on its
// own — a TS conditional-type limitation, not a brand mismatch; see PR #623).
//
// The fix is two-part. Parameterizing over the SCHEMA (`TSchema extends
// ZodSchema`) rather than its output type makes the repository callback's
// contract literally `z.output<TSchema>` — the parsed, brand-carrying type —
// instead of an inferred `T`, so that is now a stated contract rather than a
// property of how `ZodSchema<T>` happens to infer. `asResolvedOutput` then
// restates tRPC's own conditional on the resolver's side so the two relate.
// See the comment on `asResolvedOutput` for why that is sound.
const createGetByIdProcedure = <
  TSchema extends ZodSchema,
  TId extends string = string,
>(
  outputSchema: TSchema,
  getByIdFn: (
    ctx: ProtectedCrudServices,
    id: TId,
  ) => Promise<z.output<TSchema>>,
  idSchema?: z.ZodType<unknown>,
) =>
  protectedProcedure
    .input(idSchema ? z.object({ id: idSchema }) : IDInput)
    .output(strictOutput(outputSchema))
    .query(async ({ ctx, input }) => {
      const id = idSchema
        ? (idSchema.parse(input.id) as TId)
        : (input.id as TId);
      return asResolvedOutput(await getByIdFn(ctx, id));
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
const createGetByShortcodeProcedure = <TSchema extends ZodSchema>(
  entity: ShortcodeEntity,
  outputSchema: TSchema,
  getByShortcodeFn: (
    ctx: ProtectedCrudServices,
    shortcode: string,
  ) => Promise<z.output<TSchema> | null>,
) =>
  protectedProcedure
    .input(z.object({ shortcode: shortcodeSchema(entity) }))
    .output(strictOutput(outputSchema.nullable()))
    .query(async ({ ctx, input }) =>
      asResolvedOutput(await getByShortcodeFn(ctx, input.shortcode)),
    );

// `inputSchema: S` (not `ZodSchema<TInput>`): annotating the param as
// ZodSchema<T> erases the schema's *input* type to `unknown` (Zod 4's ZodType
// input param defaults to unknown), which tRPC then exposes as the client
// mutation arg type — defeating compile-time checking of the payload. Keeping
// the concrete schema type `S` preserves `z.input<S>` end-to-end.
const createCreateProcedure = <
  S extends ZodSchema,
  TOutputSchema extends ZodSchema,
>(
  inputSchema: S,
  outputSchema: TOutputSchema,
  createFn: (
    ctx: ProtectedCrudServices,
    data: z.infer<S>,
  ) => Promise<z.output<TOutputSchema>>,
) =>
  protectedProcedure
    .input(inputSchema)
    .output(strictOutput(outputSchema))
    // `input` is cast back to `z.infer<S>` because tRPC can't resolve the parsed
    // type from the still-generic `S` inside this builder; the cast is local and
    // doesn't affect the procedure's public (concrete) input type at call sites.
    .mutation(async ({ ctx, input }) =>
      asResolvedOutput(await createFn(ctx, input as z.infer<S>)),
    );

const createUpdateProcedure = <
  S extends ZodSchema,
  TOutputSchema extends ZodSchema,
  TId extends string = string,
>(
  inputSchema: S,
  outputSchema: TOutputSchema,
  updateFn: (
    ctx: ProtectedCrudServices,
    id: TId,
    data: z.infer<S>,
  ) => Promise<z.output<TOutputSchema>>,
  idSchema?: z.ZodType<unknown>,
) =>
  protectedProcedure
    .input(
      idSchema
        ? z.object({ id: idSchema, data: inputSchema })
        : updateInputSchema(inputSchema),
    )
    .output(strictOutput(outputSchema))
    .mutation(async ({ ctx, input }) => {
      // Cast back to the concrete shape: tRPC can't resolve the parsed type from
      // the generic `S` here (the public input type stays concrete at call sites).
      const { id: rawId, data } = input as { id: unknown; data: z.infer<S> };
      const id = idSchema ? (idSchema.parse(rawId) as TId) : (rawId as TId);
      return asResolvedOutput(await updateFn(ctx, id, data));
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
      strictOutput(
        createPaginatedResponseSchemaWithContext(schemas.output, entityName),
      ),
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

/**
 * Just the two detail reads — for a router whose create AND update are both
 * hand-rolled.
 *
 * Predates the conditional `repository` below: when both mutations were
 * required keys, a reads-only router had to hand the factory callbacks it
 * would then discard, plus the `createInput`/`updateInput` schemas to type
 * them. #603 found exactly that in `product.ts` and `ingredient.ts`, where a
 * plausible-looking discarded `update` was missing the dependent-recipe
 * recompute the real one performs — a fix applied there would have silently
 * not shipped. `createEntityCrudWithoutListProcedures` now omits whichever
 * mutation the repository omits, so this entry point is the degenerate
 * "neither" case; the full factory is built on it, so the two can't drift.
 */
export function createEntityDetailReadProcedures<
  TDetailOutput,
  TId extends string = string,
>({
  entityName,
  schemas,
  repository,
}: {
  entityName: ShortcodeEntity;
  schemas: {
    output: ZodSchema<TDetailOutput>;
    idSchema?: z.ZodType<unknown>;
  };
  repository: {
    getByID: (ctx: ProtectedCrudServices, id: TId) => Promise<TDetailOutput>;
    /** Public-id read — `null` for an unknown code, which the route 404s on. */
    getByShortcode: (
      ctx: ProtectedCrudServices,
      shortcode: string,
    ) => Promise<TDetailOutput | null>;
  };
}) {
  return {
    getByID: createGetByIdProcedure(
      schemas.output,
      repository.getByID,
      schemas.idSchema,
    ),
    getByShortcode: createGetByShortcodeProcedure(
      entityName,
      schemas.output,
      repository.getByShortcode,
    ),
  };
}

/**
 * Present exactly when the paired input schema was supplied.
 *
 * The pairing is keyed on the input SCHEMA rather than on the callback because
 * TypeScript cannot infer a naked type parameter from a context-sensitive
 * argument: with `create?: TCreate`, every `async (services, data) => …` in the
 * routers is context-sensitive, so `TCreate` is fixed to its default before the
 * callback is ever contextually typed, and the callback's parameters collapse
 * to `any`. A Zod schema is a plain value, so `SCreate`/`SUpdate` infer
 * normally — and the schema and its callback are 1:1 anyway, which is the point
 * (a `createInput` with no `create` is exactly the dead config #603 found).
 */
type WhenSchemaGiven<S, TPresent, TAbsent = object> = [S] extends [undefined]
  ? TAbsent
  : TPresent;

/**
 * Factory for getByID/getByShortcode plus whichever mutations the caller
 * actually declares.
 *
 * `create` and `update` are conditionally present, NOT blanket-optional. A
 * router that declares both destructures both with no narrowing (inventory,
 * location, recipe do); a router that declares only `create` — ingredient,
 * whose update dispatches a dependent-recipe recompute the factory's contract
 * can't express — has nowhere to put the discarded placeholder #603 warned
 * about, and no `updateInput` left to imply one exists.
 */
export function createEntityCrudWithoutListProcedures<
  TDetailOutput,
  SCreate extends ZodSchema | undefined = undefined,
  SUpdate extends ZodSchema | undefined = undefined,
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
    /** Supply exactly when `repository.create` is supplied. */
    createInput?: SCreate;
    /** Supply exactly when `repository.update` is supplied. */
    updateInput?: SUpdate;
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
  } & WhenSchemaGiven<
    SCreate,
    {
      create: (
        ctx: ProtectedCrudServices,
        data: z.infer<Extract<SCreate, ZodSchema>>,
      ) => Promise<TCreateOutput>;
    },
    { create?: undefined }
  > &
    WhenSchemaGiven<
      SUpdate,
      {
        update: (
          ctx: ProtectedCrudServices,
          id: TId,
          data: z.infer<Extract<SUpdate, ZodSchema>>,
        ) => Promise<TUpdateOutput>;
      },
      { update?: undefined }
    >;
}): ReturnType<typeof createEntityDetailReadProcedures<TDetailOutput, TId>> &
  WhenSchemaGiven<
    SCreate,
    {
      create: ReturnType<
        typeof createCreateProcedure<
          Extract<SCreate, ZodSchema>,
          ZodSchema<TCreateOutput>
        >
      >;
    }
  > &
  WhenSchemaGiven<
    SUpdate,
    {
      update: ReturnType<
        typeof createUpdateProcedure<
          Extract<SUpdate, ZodSchema>,
          ZodSchema<TUpdateOutput>,
          TId
        >
      >;
    }
  > {
  const detailOutput = schemas.detailOutput ?? schemas.output;
  const createOutput = (schemas.createOutput ??
    schemas.output) as ZodSchema<TCreateOutput>;
  const updateOutput = (schemas.updateOutput ??
    schemas.output) as ZodSchema<TUpdateOutput>;
  const { create, update } = repository;

  // A value-level `if (create)` can't recover the type-level fact the return
  // annotation states, so the assembly is cast to it once, here.
  return {
    ...createEntityDetailReadProcedures({
      entityName,
      schemas: { output: detailOutput, idSchema: schemas.idSchema },
      repository: {
        getByID: repository.getByID,
        getByShortcode: repository.getByShortcode,
      },
    }),
    ...(create
      ? {
          create: createCreateProcedure(
            schemas.createInput as Extract<SCreate, ZodSchema>,
            createOutput,
            create,
          ),
        }
      : {}),
    ...(update
      ? {
          update: createUpdateProcedure(
            schemas.updateInput as Extract<SUpdate, ZodSchema>,
            updateOutput,
            update,
            schemas.idSchema,
          ),
        }
      : {}),
  } as ReturnType<typeof createEntityDetailReadProcedures<TDetailOutput, TId>> &
    WhenSchemaGiven<
      SCreate,
      {
        create: ReturnType<
          typeof createCreateProcedure<
            Extract<SCreate, ZodSchema>,
            ZodSchema<TCreateOutput>
          >
        >;
      }
    > &
    WhenSchemaGiven<
      SUpdate,
      {
        update: ReturnType<
          typeof createUpdateProcedure<
            Extract<SUpdate, ZodSchema>,
            ZodSchema<TUpdateOutput>,
            TId
          >
        >;
      }
    >;
}

// Generic CRUD procedures factory. Public wrappers below add either search
// side effects or plain delete handling; this assembly stays internal.
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
    ) => Promise<{
      data: TListOutput[];
      count: number;
      sums?: Record<string, number>;
    }>;
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

  // Composed from the same three builders rather than from
  // `createEntityCrudWithoutListProcedures`: its create/update presence is
  // keyed on `SCreate`/`SUpdate`, and here those are still generic parameters,
  // so the conditional would stay unreduced and both keys unreachable. Every
  // entity reaching this path has both mutations by construction.
  const { getByID, getByShortcode } = createEntityDetailReadProcedures({
    entityName,
    schemas: {
      output: schemas.detailOutput ?? schemas.output,
      idSchema: schemas.idSchema,
    },
    repository: {
      getByID: repository.getByID,
      getByShortcode: repository.getByShortcode,
    },
  });
  const create = createCreateProcedure(
    schemas.createInput,
    (schemas.createOutput ?? schemas.output) as ZodSchema<TCreateOutput>,
    repository.create,
  );
  const update = createUpdateProcedure(
    schemas.updateInput,
    (schemas.updateOutput ?? schemas.output) as ZodSchema<TUpdateOutput>,
    repository.update,
    schemas.idSchema,
  );

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
    delete: (ctx: ProtectedCrudServices, ids: TId[]) => Promise<DeleteResult>;
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
