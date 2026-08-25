import type { BackgroundBatchRef } from "@cubby/schemas/background-jobs";
import type { ActorContext } from "@cubby/schemas/context";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import type { output as ZodOutput, ZodSchema } from "zod";
import type { UPCLookupClient } from "~/server/clients/upc-lookup";
import type { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import { ENTITY_BINDINGS } from "~/server/entity-bindings";
import type { LocationValuationService } from "~/server/services/location-valuation.service";
import type { RecipeCostingService } from "~/server/services/recipe-costing.service";
import type { USDAService } from "~/server/services/usda.service";
import type { EntityKernelEntity } from "./contracts";

export interface EntityKernelContext {
  /** Authoritative adapter for details, mutations, and side effects. */
  db: Database;
  /** Request-selected adapter for explicitly bounded-stale list/search reads. */
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

export interface EntityKernelDeleteResult {
  deleted: number;
  detachedImageKeys?: string[];
  backgroundBatches?: BackgroundBatchRef[];
  affectedEdges?: Array<{
    edge: string;
    effect: OperationDisposition["effect"];
    changed: number;
  }>;
}

export interface EntityKernelBinding {
  entity: EntityKernelEntity;
  sideEffects: boolean;
  schemas: {
    id: ZodSchema;
    create?: ZodSchema;
    update?: ZodSchema;
    output: ZodSchema;
    detail: ZodSchema;
    list: ZodSchema;
    filters: ZodSchema;
  };
  sort: {
    fields: readonly [string, ...string[]];
    default: string;
    groupable?: readonly [string, ...string[]];
  };
  lifecycle: {
    delete: Record<string, OperationDisposition>;
    merge?: Record<string, OperationDisposition>;
  };
  repository: {
    get: (ctx: EntityKernelContext, id: unknown) => Promise<unknown | null>;
    list: (
      ctx: EntityKernelContext,
      filters: unknown,
      sorts: SortParams[],
      pagination: PaginationParams,
      groupBy?: string,
    ) => Promise<{
      data: unknown[];
      count: number;
      sums?: Record<string, number>;
    }>;
    create?: (
      ctx: EntityKernelContext,
      data: unknown,
    ) => Promise<{
      output: unknown;
      entityId: unknown;
      detachedImageKeys?: string[];
      backgroundBatches?: BackgroundBatchRef[];
    }>;
    update?: (
      ctx: EntityKernelContext,
      id: unknown,
      data: unknown,
    ) => Promise<{
      output: unknown;
      entityId: unknown;
      detachedImageKeys?: string[];
      backgroundBatches?: BackgroundBatchRef[];
    }>;
    delete: (
      ctx: EntityKernelContext,
      ids: unknown[],
    ) => Promise<EntityKernelDeleteResult>;
  };
  merge?: {
    input: ZodSchema;
    output: ZodSchema;
    item: (output: unknown) => unknown;
    summary: (output: unknown) => unknown;
    execute: (
      ctx: EntityKernelContext,
      input: unknown,
    ) => Promise<{
      output: unknown;
      entityId: unknown | null;
      detachedImageKeys: string[];
      backgroundBatches?: BackgroundBatchRef[];
    }>;
  };
}

type CrudFor<E extends EntityKernelEntity> = NonNullable<
  (typeof ENTITY_BINDINGS)[E]["crud"]
>;

export function defineEntityAdapter<
  const E extends EntityKernelEntity,
  SFilters extends ZodSchema,
>(config: {
  entity: E;
  sideEffects?: boolean;
  filters: SFilters;
  listOutput?: ZodSchema;
  detailOutput?: ZodSchema;
  sort: EntityKernelBinding["sort"];
  lifecycle: EntityKernelBinding["lifecycle"];
  repository: {
    get: (
      ctx: EntityKernelContext,
      id: ZodOutput<CrudFor<E>["idSchema"]>,
    ) => Promise<ZodOutput<CrudFor<E>["output"]> | null>;
    list: (
      ctx: EntityKernelContext,
      filters: ZodOutput<SFilters>,
      sorts: SortParams[],
      pagination: PaginationParams,
      groupBy?: string,
    ) => Promise<{
      data: unknown[];
      count: number;
      sums?: Record<string, number>;
    }>;
    create: (
      ctx: EntityKernelContext,
      data: ZodOutput<CrudFor<E>["createInput"]>,
    ) => Promise<{
      output: ZodOutput<CrudFor<E>["output"]>;
      entityId: unknown;
      detachedImageKeys?: string[];
      backgroundBatches?: BackgroundBatchRef[];
    }>;
    update: (
      ctx: EntityKernelContext,
      id: ZodOutput<CrudFor<E>["idSchema"]>,
      data: ZodOutput<CrudFor<E>["updateInput"]>,
    ) => Promise<{
      output: ZodOutput<CrudFor<E>["output"]>;
      entityId: unknown;
      detachedImageKeys?: string[];
      backgroundBatches?: BackgroundBatchRef[];
    }>;
    delete: (
      ctx: EntityKernelContext,
      ids: ZodOutput<CrudFor<E>["idSchema"]>[],
    ) => Promise<EntityKernelDeleteResult>;
  };
  merge?: EntityKernelBinding["merge"];
}) {
  const crud = ENTITY_BINDINGS[config.entity].crud as CrudFor<E>;
  return {
    ...config,
    sideEffects: config.sideEffects ?? true,
    schemas: {
      id: crud.idSchema,
      create: crud.createInput,
      update: crud.updateInput,
      output: crud.output,
      detail: config.detailOutput ?? crud.output,
      list: config.listOutput ?? crud.output,
      filters: config.filters,
    },
  };
}
