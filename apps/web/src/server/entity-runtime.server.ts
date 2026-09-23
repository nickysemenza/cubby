import { searchableEntitySchema } from "@cubby/schemas/search";
import * as drizzle from "drizzle-orm";
import { z } from "zod";

import { entityDetailContract } from "~/contracts/entity-detail.contract";
import { entityFilterOptionsContract } from "~/contracts/entity-filter-options.contract";
import { entityGraphContract } from "~/contracts/entity-graph.contract";
import { entityInspectorHealthContract } from "~/contracts/entity-inspector-health.contract";
import { entityIntegrityContract } from "~/contracts/entity-integrity.contract";
import { entityListContract } from "~/contracts/entity-list.contract";
import { entityMutationContract } from "~/contracts/entity-mutation.contract";
import { entityTimelineContract } from "~/contracts/entity-timeline.contract";
import {
  entityDetailInputSchema,
  getEntityDetailOutputSchema,
} from "~/entities/generated/entity-details.gen";
import {
  entityListInputSchema,
  getEntityListOutputSchema,
} from "~/entities/generated/entity-lists.gen";
import {
  entityTimelineInputSchema,
  getEntityTimelineOutputSchema,
} from "~/entities/generated/entity-timelines.gen";
import { executeEntity } from "~/server/entity-kernel";
import {
  entityBrowserMutationCommandSchema,
  entityBrowserMutationResultSchema,
} from "~/server/entity-kernel/contracts";
import { runEntityTimeline } from "~/server/entity-timeline";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { getConnectedRecords } from "~/server/repo/connected-records";
import { getEntityCounts } from "~/server/repo/dashboard";
import { getEntityConnections } from "~/server/repo/entity-edge-source";
import { getEntityGraph } from "~/server/repo/entity-graph";
import { getEntityGraphExplore } from "~/server/repo/entity-graph-explore";
import { getEntityGraphPaths } from "~/server/repo/entity-graph-paths";
import { getFilterOptions } from "~/server/repo/filter-options";
import { executeSearchDocumentSql } from "~/server/repo/search-document";
import { buildIntegrityCatalog } from "~/server/services/entity-integrity.service";
import { throwIfStartOperationAborted } from "~/server/start-operation.server";

const searchDocumentCountRowSchema = z.object({
  entityType: searchableEntitySchema,
  documents: z.number().int().nonnegative(),
  embeddings: z.number().int().nonnegative(),
});

/**
 * The client declares type-only `z.custom` schemas for the generic entity
 * operations; the server owns runtime validation via `input`/`output`
 * overrides, and the output schema depends on the parsed input's entity.
 */
export const entityListHandlers = implementOperationDomain(entityListContract, {
  list: {
    input: entityListInputSchema,
    output: (input) => getEntityListOutputSchema(input.entity),
    run: async (context, input) => {
      const result = await executeEntity(context, {
        action: "list",
        ...input,
      });
      if (result.action !== "list") {
        throw new Error("Entity kernel returned the wrong action");
      }
      return getEntityListOutputSchema(input.entity).parse({
        items: result.items,
        meta: result.meta,
      });
    },
  },
});

export const entityDetailHandlers = implementOperationDomain(
  entityDetailContract,
  {
    detail: {
      // Query-default "context" policy: browser detail reads may ride the
      // bounded-stale handle; other contexts stay authoritative.
      input: entityDetailInputSchema,
      output: (input) => getEntityDetailOutputSchema(input.entity).nullable(),
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
        return result.item === null
          ? null
          : getEntityDetailOutputSchema(input.entity).parse(result.item);
      },
    },
  },
);

export const entityTimelineHandlers = implementOperationDomain(
  entityTimelineContract,
  {
    timeline: {
      input: entityTimelineInputSchema,
      output: (input) => getEntityTimelineOutputSchema(input.entity),
      run: async (context, input) =>
        getEntityTimelineOutputSchema(input.entity).parse(
          await runEntityTimeline(
            context,
            entityTimelineInputSchema.parse(input),
          ),
        ),
    },
  },
);

export const entityFilterOptionsHandlers = implementOperationDomain(
  entityFilterOptionsContract,
  {
    filterOptions: (context, input) => getFilterOptions(context.readDb, input),
  },
);

export const entityGraphHandlers = implementOperationDomain(
  entityGraphContract,
  {
    connectedRecords: (context, input) =>
      getConnectedRecords(context.readDb, input),
    explore: (context, input) => getEntityGraphExplore(context.readDb, input),
    graph: (context, input) => getEntityGraph(context.readDb, input),
    graphPaths: (context, input) => getEntityGraphPaths(context.readDb, input),
    connections: (context, input) =>
      getEntityConnections(context.readDb, input),
  },
);

export const entityMutationHandlers = implementOperationDomain(
  entityMutationContract,
  {
    mutate: {
      input: entityBrowserMutationCommandSchema,
      output: entityBrowserMutationResultSchema,
      run: async (context, input) => {
        const command = entityBrowserMutationCommandSchema.parse(input);
        return entityBrowserMutationResultSchema.parse(
          await executeEntity(context, command),
        );
      },
    },
  },
);

export const entityInspectorHealthHandlers = implementOperationDomain(
  entityInspectorHealthContract,
  {
    inspectorHealth: {
      run: async (context) => {
        const [counts, rows] = await Promise.all([
          getEntityCounts(context.db),
          executeSearchDocumentSql(
            context.db,
            searchDocumentCountRowSchema,
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
        throwIfStartOperationAborted(context.signal);
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
    },
  },
);

export const entityIntegrityHandlers = implementOperationDomain(
  entityIntegrityContract,
  {
    catalog: async () => buildIntegrityCatalog(),
  },
);
