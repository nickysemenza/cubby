import type { ActorContext } from "@cubby/schemas/context";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type { EntityId } from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { type output as ZodOutput, type ZodSchema, z } from "zod";

import type { ListReadRow } from "~/entities/list-read-fields";
import type { UPCLookupClient } from "~/server/clients/upc-lookup";
import type { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import {
  ENTITY_SCHEMA_BINDINGS,
  type EntitySchemaBindingEntity,
  type EntitySchemaBindingMap,
} from "~/server/generated/entity-bindings.gen";
import type {
  ListProjection,
  ListReadPage,
} from "~/server/repo/list-projection";
import type { MealMutationHooks } from "~/server/repo/meal/crud";
import type { TaskMutationHooks } from "~/server/repo/task/crud";
import {
  type MutationSideEffectEntity,
  mutationEvents,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import type { RecipeCostingService } from "~/server/services/recipe-costing.service";
import type { USDAService } from "~/server/services/usda.service";
export interface EntityKernelContext {
  /**
   * The operation's single database adapter: authoritative for strong
   * operations, the request-selected one for eligible bounded-stale reads.
   */
  db: Database;
  actorContext: ActorContext;
  usdaClient: USDAClient;
  /** Optional service facade for specialized MCP reads outside the kernel. */
  usdaService?: USDAService;
  upcLookupClient: UPCLookupClient;
  services: {
    recipeCosting: RecipeCostingService;
  };
  /** Internal protocol metadata for a transactional CalDAV stale-write check. */
  caldavHooks?: { meal?: MealMutationHooks; task?: TaskMutationHooks };
}

const isEntityKernelContext = (value: unknown): value is EntityKernelContext =>
  typeof value === "object" &&
  value !== null &&
  "db" in value &&
  "actorContext" in value &&
  "usdaClient" in value &&
  "upcLookupClient" in value &&
  "services" in value;

/** Validate the explicitly injected MCP capability at the auth boundary. */
export const entityKernelContextSchema = z.custom<EntityKernelContext>(
  isEntityKernelContext,
  "expected an entity-kernel request context",
);

export interface EntityMutationReference<
  E extends EntitySchemaBindingEntity = EntitySchemaBindingEntity,
> {
  entity: E;
  id: string;
}

export const entityMutationReferences = <E extends EntitySchemaBindingEntity>(
  entity: E,
  ids: readonly string[],
): EntityMutationReference<E>[] => ids.map((id) => ({ entity, id }));

/**
 * `deletedReferences` for a delete that also detached images: the entity's
 * own ids plus whatever image shortcodes came off it.
 */
export const deletedWithImages = <E extends EntitySchemaBindingEntity>(
  entity: E,
  shortcodes: readonly string[],
  imageShortcodes: readonly string[],
): EntityMutationReference[] => [
  ...entityMutationReferences(entity, shortcodes),
  ...entityMutationReferences("image", imageShortcodes),
];

/** A bulk patch's kernel result, after its one side-effect fan-out. */
export const bulkUpdatedWithSideEffects = async <
  E extends EntitySchemaBindingEntity & MutationSideEffectEntity,
>(
  ctx: EntityKernelContext,
  entity: E,
  result: { updatedIds: EntityId<E>[]; updatedShortcodes: readonly string[] },
) => {
  await runMutationSideEffectsForEntities(
    ctx.db,
    mutationEvents(
      entity,
      "updated",
      result.updatedIds,
      `${entity}.bulkUpdate`,
    ),
  );
  return {
    updatedReferences: entityMutationReferences(
      entity,
      result.updatedShortcodes,
    ),
  };
};

export interface EntityKernelDeleteResult {
  deletedReferences: EntityMutationReference[];
  detachedImageKeys?: string[];
  affectedEdges?: Array<{
    edge: string;
    effect: OperationDisposition["effect"];
    changed: number;
  }>;
}

/**
 * A bulk patch is one repository call, not N kernel updates: the repository
 * owns the per-entity side-effect fan-out, exactly as `delete` does.
 */
export interface EntityKernelBulkUpdateResult<
  E extends EntitySchemaBindingEntity,
> {
  updatedReferences: EntityMutationReference<E>[];
  detachedImageKeys?: string[];
}

type SchemaOutput<S> = S extends ZodSchema ? ZodOutput<S> : never;
type UnparsedEntityOutput = Parameters<ZodSchema["parse"]>[0];
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
  repositoryDetail: ZodSchema;
  repositoryList: ZodSchema;
}

export type EntityCreateInput<E extends EntitySchemaBindingEntity> =
  SchemaOutput<SchemasFor<E>["createInput"]>;
export type EntityPublicOutput<E extends EntitySchemaBindingEntity> =
  SchemaOutput<SchemasFor<E>["output"]>;

/** Parse a public entity output through the schema owned by the same entity. */
export function parseEntityPublicOutput<E extends EntitySchemaBindingEntity>(
  entity: E,
  value: UnparsedEntityOutput,
): EntityPublicOutput<E> {
  const parsed = ENTITY_SCHEMA_BINDINGS[entity].output.parse(value);
  // SAFETY: E selects this exact entry in the generated schema binding map;
  // `.parse` above applies that entry's transformations before restoration.
  return parsed as EntityPublicOutput<E>;
}

export type EntityInternalId<E extends EntitySchemaBindingEntity> = EntityId<E>;

export interface EntitySortContract {
  fields: readonly [string, ...string[]];
  default: string;
  direction: "asc" | "desc";
  groupable?: readonly [string, ...string[]];
}

export interface EntityLifecycleContract {
  delete: Record<string, OperationDisposition>;
  merge?: Record<string, OperationDisposition>;
}

export interface EntityRepositoryWriteResult<
  E extends EntitySchemaBindingEntity,
  S extends EntityBindingSchemas,
> {
  output: ZodOutput<S["output"]>;
  entityId: EntityInternalId<E>;
  detachedImageKeys?: string[];
  /** Best-effort follow-up failures, surfaced as `sideEffects.warnings`. */
  warnings?: readonly string[];
}

type PresentSchemaOutput<S> = ZodOutput<Extract<S, ZodSchema>>;

/**
 * The kernel's view of a repository (`defineRepository` in
 * `repo/repository.ts`). A write method is absent when the declaration does
 * not grant that action; the kernel refuses the command.
 */
export type EntityRepository<
  E extends EntitySchemaBindingEntity,
  S extends EntityBindingSchemas = SchemasFor<E>,
> = {
  listRead?(
    ctx: EntityKernelContext,
    filters: ZodOutput<S["filters"]>,
    sorts: SortParams[],
    pagination: PaginationParams,
    projection: ListProjection,
    groupBy?: string,
  ): Promise<ListReadPage<ListReadRow>>;
  listSummary?(
    ctx: EntityKernelContext,
    filters: ZodOutput<S["filters"]>,
  ): Promise<Record<string, number>>;
  get(
    ctx: EntityKernelContext,
    id: ZodOutput<S["id"]>,
  ): Promise<ZodOutput<S["repositoryDetail"]> | null>;
  list(
    ctx: EntityKernelContext,
    filters: ZodOutput<S["filters"]>,
    sorts: SortParams[],
    pagination: PaginationParams,
    groupBy?: string,
  ): Promise<ListReadPage<ZodOutput<S["repositoryList"]>>>;
  create?(
    ctx: EntityKernelContext,
    data: PresentSchemaOutput<S["createInput"]>,
  ): Promise<EntityRepositoryWriteResult<E, S>>;
  update?(
    ctx: EntityKernelContext,
    id: ZodOutput<S["id"]>,
    data: PresentSchemaOutput<S["updateInput"]>,
  ): Promise<EntityRepositoryWriteResult<E, S>>;
  bulkUpdate?(
    ctx: EntityKernelContext,
    ids: ZodOutput<S["id"]>[],
    data: PresentSchemaOutput<S["bulkUpdateInput"]>,
  ): Promise<EntityKernelBulkUpdateResult<E>>;
  delete?(
    ctx: EntityKernelContext,
    ids: ZodOutput<S["id"]>[],
  ): Promise<EntityKernelDeleteResult>;
};

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
