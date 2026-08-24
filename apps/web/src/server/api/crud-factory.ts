import { mutationSideEffectsSchema } from "@cubby/schemas/background-jobs";
import type { ActorContext } from "@cubby/schemas/context";
import type { Entity } from "@cubby/schemas/entity";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import type { UserId } from "@cubby/schemas/identifiers";
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
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import type { RecipeCostingService } from "~/server/services/recipe-costing.service";
import { protectedProcedure, strictOutput } from "./trpc";

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
