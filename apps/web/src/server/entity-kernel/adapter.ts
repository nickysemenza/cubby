import type { BackgroundBatchRef } from "@cubby/schemas/background-jobs";
import type { ActorContext } from "@cubby/schemas/context";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type { EntityId } from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { type output as ZodOutput, type ZodSchema, z } from "zod";

import type { UPCLookupClient } from "~/server/clients/upc-lookup";
import type { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import {
  ENTITY_SCHEMA_BINDINGS,
  type EntitySchemaBindingEntity,
  type EntitySchemaBindingMap,
} from "~/server/generated/entity-bindings.gen";
import type { LocationValuationService } from "~/server/services/location-valuation.service";
import type { RecipeCostingService } from "~/server/services/recipe-costing.service";
import type { USDAService } from "~/server/services/usda.service";

export interface EntityKernelContext {
  /** Authoritative adapter for strong reads, mutations, and side effects. */
  db: Database;
  /** Request-selected adapter for eligible bounded-stale entity reads. */
  readDb: Database;
  actorContext: ActorContext;
  usdaClient: USDAClient;
  /** Optional service facade for specialized MCP reads outside the kernel. */
  usdaService?: USDAService;
  upcLookupClient: UPCLookupClient;
  services: {
    recipeCosting: RecipeCostingService;
    locationValuation: LocationValuationService;
  };
}

const isEntityKernelContext = (value: unknown): value is EntityKernelContext =>
  typeof value === "object" &&
  value !== null &&
  "db" in value &&
  "readDb" in value &&
  "actorContext" in value &&
  "usdaClient" in value &&
  "upcLookupClient" in value &&
  "services" in value;

/** Validate the explicitly injected MCP capability at the auth boundary. */
export const entityKernelContextSchema = z.custom<EntityKernelContext>(
  isEntityKernelContext,
  "expected an entity-kernel request context",
);

interface EntityKernelDeleteResult {
  deleted: number;
  detachedImageKeys?: string[];
  backgroundBatches?: BackgroundBatchRef[];
  affectedEdges?: Array<{
    edge: string;
    effect: OperationDisposition["effect"];
    changed: number;
  }>;
}

/**
 * A bulk patch is one repository call, not N kernel updates: the repository
 * owns the transaction and the per-entity side-effect fan-out, exactly as
 * `delete` does.
 */
interface EntityKernelBulkUpdateResult {
  updated: number;
  detachedImageKeys?: string[];
  backgroundBatches?: BackgroundBatchRef[];
}

type SchemaOutput<S> = S extends ZodSchema ? ZodOutput<S> : never;
type SchemasFor<E extends EntitySchemaBindingEntity> =
  EntitySchemaBindingMap[E];
export interface EntityBindingSchemas {
  id: ZodSchema;
  filters: ZodSchema;
  createInput: ZodSchema | null;
  updateInput: ZodSchema | null;
  bulkUpdateInput: ZodSchema | null;
  output: ZodSchema;
  detail: ZodSchema;
  list: ZodSchema;
}

export type EntityCreateInput<E extends EntitySchemaBindingEntity> =
  SchemaOutput<SchemasFor<E>["createInput"]>;
export type EntityPublicOutput<E extends EntitySchemaBindingEntity> =
  SchemaOutput<SchemasFor<E>["output"]>;

export type EntityInternalId<E extends EntitySchemaBindingEntity> = EntityId<E>;

export interface EntitySortContract {
  fields: readonly [string, ...string[]];
  default: string;
  groupable?: readonly [string, ...string[]];
}

export interface EntityLifecycleContract {
  delete: Record<string, OperationDisposition>;
  merge?: Record<string, OperationDisposition>;
}

interface EntityRepositoryWriteResult<
  E extends EntitySchemaBindingEntity,
  S extends EntityBindingSchemas,
> {
  output: ZodOutput<S["output"]>;
  entityId: EntityInternalId<E>;
  detachedImageKeys?: string[];
  backgroundBatches?: BackgroundBatchRef[];
}

type PresentSchemaOutput<S> = ZodOutput<Extract<S, ZodSchema>>;

type EntityCreateRepository<
  E extends EntitySchemaBindingEntity,
  S extends EntityBindingSchemas,
> =
  SchemaOutput<S["createInput"]> extends never
    ? { create?: never }
    : {
        create(
          ctx: EntityKernelContext,
          data: PresentSchemaOutput<S["createInput"]>,
        ): Promise<EntityRepositoryWriteResult<E, S>>;
      };

type EntityUpdateRepository<
  E extends EntitySchemaBindingEntity,
  S extends EntityBindingSchemas,
> =
  SchemaOutput<S["updateInput"]> extends never
    ? { update?: never }
    : {
        update(
          ctx: EntityKernelContext,
          id: ZodOutput<S["id"]>,
          data: PresentSchemaOutput<S["updateInput"]>,
        ): Promise<EntityRepositoryWriteResult<E, S>>;
      };

type EntityBulkUpdateRepository<S extends EntityBindingSchemas> =
  SchemaOutput<S["bulkUpdateInput"]> extends never
    ? { bulkUpdate?: never }
    : {
        bulkUpdate(
          ctx: EntityKernelContext,
          ids: ZodOutput<S["id"]>[],
          data: PresentSchemaOutput<S["bulkUpdateInput"]>,
        ): Promise<EntityKernelBulkUpdateResult>;
      };

export type EntityRepository<
  E extends EntitySchemaBindingEntity,
  S extends EntityBindingSchemas = SchemasFor<E>,
> = {
  get(
    ctx: EntityKernelContext,
    id: ZodOutput<S["id"]>,
  ): Promise<ZodOutput<S["detail"]> | null>;
  list(
    ctx: EntityKernelContext,
    filters: ZodOutput<S["filters"]>,
    sorts: SortParams[],
    pagination: PaginationParams,
    groupBy?: string,
  ): Promise<{
    data: ZodOutput<S["list"]>[];
    count: number;
    sums?: Record<string, number>;
  }>;
  delete(
    ctx: EntityKernelContext,
    ids: ZodOutput<S["id"]>[],
  ): Promise<EntityKernelDeleteResult>;
} & EntityCreateRepository<E, S> &
  EntityUpdateRepository<E, S> &
  EntityBulkUpdateRepository<S>;

export interface EntityMergePort<
  E extends EntitySchemaBindingEntity,
  SInput extends ZodSchema,
  SOutput extends ZodSchema,
  TItem,
  TSummary,
> {
  input: SInput;
  output: SOutput;
  item: (output: ZodOutput<SOutput>) => TItem;
  summary: (output: ZodOutput<SOutput>) => TSummary;
  execute: (
    ctx: EntityKernelContext,
    input: ZodOutput<SInput>,
  ) => Promise<{
    output: ZodOutput<SOutput>;
    entityId: EntityInternalId<E> | null;
    detachedImageKeys: string[];
    backgroundBatches?: BackgroundBatchRef[];
  }>;
}

export interface EntityKernelCoreBinding<
  E extends EntitySchemaBindingEntity,
  S extends EntityBindingSchemas = SchemasFor<E>,
> {
  entity: E;
  sideEffects: boolean;
  schemas: S;
  sort: EntitySortContract;
  lifecycle: EntityLifecycleContract;
  repository: EntityRepository<E, S>;
}

export function defineEntityAdapter<
  const E extends EntitySchemaBindingEntity,
  SMergeInput extends ZodSchema = z.ZodNever,
  SMergeOutput extends ZodSchema = z.ZodNever,
  TMergeItem = never,
  TMergeSummary = never,
>(config: {
  entity: E;
  sideEffects?: boolean;
  sort: EntitySortContract;
  lifecycle: EntityLifecycleContract;
  repository: EntityRepository<E>;
  merge?: EntityMergePort<
    E,
    SMergeInput,
    SMergeOutput,
    TMergeItem,
    TMergeSummary
  >;
}) {
  const merge = config.merge;
  const mergeOperation = merge
    ? {
        execute: async <TInput>(ctx: EntityKernelContext, input: TInput) => {
          const result = await merge.execute(ctx, merge.input.parse(input));
          const output = merge.output.parse(result.output);
          return {
            ...result,
            item: merge.item(output),
            mergeSummary: merge.summary(output),
          };
        },
      }
    : null;
  return {
    ...config,
    sideEffects: config.sideEffects ?? true,
    schemas: ENTITY_SCHEMA_BINDINGS[config.entity],
    mergeOperation,
  };
}
