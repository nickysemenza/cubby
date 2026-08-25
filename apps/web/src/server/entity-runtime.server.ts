import {
  type IntegrityCatalog,
  integrityCatalogSchema,
} from "@cubby/schemas/entity-integrity";
import {
  type FilterOptionsInput,
  type FilterOptionsOut,
  filterOptionsInput,
  filterOptionsOut,
} from "@cubby/schemas/filter-options";
import type { SearchableEntity } from "@cubby/schemas/search";
import * as drizzle from "drizzle-orm";
import { z } from "zod";
import type { EntityInspectorHealth } from "~/entities/entity-inspector-health.functions";
import type {
  EntityDetailByEntity,
  EntityDetailInputByEntity,
} from "~/entities/generated/entity-details.gen";
import {
  entityDetailInputSchema,
  getEntityDetailOutputSchema,
} from "~/entities/generated/entity-details.gen";
import type {
  EntityListInputByEntity,
  EntityListResultByEntity,
  ListEntity,
} from "~/entities/generated/entity-lists.gen";
import {
  entityListInputSchema,
  getEntityListOutputSchema,
} from "~/entities/generated/entity-lists.gen";
import { executeEntity } from "~/server/entity-kernel";
import {
  type EntityBrowserMutationInput,
  type EntityBrowserMutationResult,
  entityBrowserMutationCommandSchema,
  entityBrowserMutationResultSchema,
} from "~/server/entity-kernel/contracts";
import { getEntityCounts } from "~/server/repo/dashboard";
import { getFilterOptions } from "~/server/repo/filter-options";
import { executeSearchDocumentSql } from "~/server/repo/search-document";
import { buildIntegrityCatalog } from "~/server/services/entity-integrity.service";
import type { StartOperationResult } from "~/server/start-operation.contract";
import {
  runStartOperation,
  type StartOperationRequest,
  throwIfStartOperationAborted,
} from "~/server/start-operation.server";

export function getEntityList<E extends ListEntity>(options: {
  data: EntityListInputByEntity[E];
  request: StartOperationRequest;
}): Promise<StartOperationResult<EntityListResultByEntity[E]>>;
export async function getEntityList(options: {
  data: EntityListInputByEntity[ListEntity];
  request: StartOperationRequest;
}): Promise<StartOperationResult<EntityListResultByEntity[ListEntity]>> {
  return await runStartOperation({
    operation: "entity.list",
    type: "query",
    input: options.data,
    inputSchema: entityListInputSchema,
    outputSchema: (input) => getEntityListOutputSchema(input.entity),
    request: options.request,
    run: async (context, input) => {
      const result = await executeEntity(context, {
        action: "list",
        ...input,
      });
      if (result.action !== "list") {
        throw new Error("Entity kernel returned the wrong action");
      }
      return { items: result.items, meta: result.meta };
    },
  });
}

export async function getEntityDetail(options: {
  data: EntityDetailInputByEntity[keyof EntityDetailByEntity];
  request: StartOperationRequest;
}): Promise<
  StartOperationResult<EntityDetailByEntity[keyof EntityDetailByEntity] | null>
> {
  return await runStartOperation({
    operation: "entity.detail",
    type: "query",
    input: options.data,
    inputSchema: entityDetailInputSchema,
    outputSchema: (input) =>
      getEntityDetailOutputSchema(input.entity).nullable(),
    request: options.request,
    readPolicy: "strong",
    run: async (context, input) => {
      const result = await executeEntity(context, {
        action: "get",
        entity: input.entity,
        id: input.shortcode,
        missing: "null",
      });
      if (result.action !== "get") {
        throw new Error("Entity kernel returned the wrong action");
      }
      return result.item;
    },
  });
}

export async function getEntityFilterOptions(options: {
  data: FilterOptionsInput;
  request: StartOperationRequest;
}): Promise<StartOperationResult<FilterOptionsOut>> {
  return await runStartOperation({
    operation: "entity.filterOptions",
    type: "query",
    input: options.data,
    inputSchema: filterOptionsInput,
    outputSchema: filterOptionsOut,
    request: options.request,
    run: async (context, input) =>
      await getFilterOptions(context.readDb, input),
  });
}

export async function executeEntityMutation(options: {
  data: EntityBrowserMutationInput;
  request: StartOperationRequest;
}): Promise<StartOperationResult<EntityBrowserMutationResult>> {
  return await runStartOperation({
    operation: "entity.mutate",
    type: "mutation",
    input: options.data,
    inputSchema: entityBrowserMutationCommandSchema,
    outputSchema: entityBrowserMutationResultSchema,
    request: options.request,
    run: async (context, command) => await executeEntity(context, command),
  });
}

const entityInspectorHealthSchema = z.object({
  counts: z.record(z.string(), z.number().int().nonnegative()),
  search: z.record(
    z.string(),
    z.object({
      documents: z.number().int().nonnegative(),
      embeddings: z.number().int().nonnegative(),
    }),
  ),
});

export async function getEntityInspectorHealth(options: {
  request: StartOperationRequest;
}): Promise<StartOperationResult<EntityInspectorHealth>> {
  return await runStartOperation({
    operation: "entity.inspectorHealth",
    type: "query",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: entityInspectorHealthSchema,
    request: options.request,
    readPolicy: "strong",
    run: async (context) => {
      const [counts, rows] = await Promise.all([
        getEntityCounts(context.db),
        executeSearchDocumentSql<{
          entityType: SearchableEntity;
          documents: number;
          embeddings: number;
        }>(
          context.db,
          drizzle.sql`
            SELECT
              sd."entityType" AS "entityType",
              count(DISTINCT sd."entityId")::int AS documents,
              count(DISTINCT ee."entityId")::int AS embeddings
            FROM "SearchDocument" sd
            LEFT JOIN "EntityEmbedding" ee
              ON ee."entityType" = sd."entityType"
              AND ee."entityId" = sd."entityId"
              AND ee."deletedAt" IS NULL
            WHERE sd."deletedAt" IS NULL
            GROUP BY sd."entityType"
          `,
        ),
      ]);
      throwIfStartOperationAborted(options.request.signal);
      return {
        counts,
        search: Object.fromEntries(
          rows.map((row) => [
            row.entityType,
            { documents: row.documents, embeddings: row.embeddings },
          ]),
        ),
      };
    },
  });
}

export async function getEntityIntegrityCatalog(options: {
  request: StartOperationRequest;
}): Promise<StartOperationResult<IntegrityCatalog>> {
  return await runStartOperation({
    operation: "entityIntegrity.catalog",
    type: "query",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: integrityCatalogSchema,
    request: options.request,
    run: async () => buildIntegrityCatalog(),
  });
}
