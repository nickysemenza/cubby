import type { SearchableEntity } from "@cubby/schemas/search";
import * as drizzle from "drizzle-orm";
import type { z } from "zod";
import { entityDetail } from "~/entities/entity-detail.functions";
import { entityFilterOptions } from "~/entities/entity-filter-options.functions";
import { entityInspectorHealth } from "~/entities/entity-inspector-health.functions";
import { entityIntegrity } from "~/entities/entity-integrity.functions";
import { entityList } from "~/entities/entity-list.functions";
import { entityMutation } from "~/entities/entity-mutation.functions";
import {
  entityDetailInputSchema,
  getEntityDetailOutputSchema,
} from "~/entities/generated/entity-details.gen";
import {
  entityListInputSchema,
  getEntityListOutputSchema,
} from "~/entities/generated/entity-lists.gen";
import { executeEntity } from "~/server/entity-kernel";
import {
  entityBrowserMutationCommandSchema,
  entityBrowserMutationResultSchema,
} from "~/server/entity-kernel/contracts";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { getEntityCounts } from "~/server/repo/dashboard";
import { getFilterOptions } from "~/server/repo/filter-options";
import { executeSearchDocumentSql } from "~/server/repo/search-document";
import { buildIntegrityCatalog } from "~/server/services/entity-integrity.service";
import { throwIfStartOperationAborted } from "~/server/start-operation.server";

/**
 * The client declares type-only `z.custom` schemas for the generic entity
 * operations; the server owns runtime validation via `input`/`output`
 * overrides, and the output schema depends on the parsed input's entity.
 */
export const entityListHandlers = implementOperationDomain(entityList, {
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
      return { items: result.items, meta: result.meta };
    },
  },
});

export const entityDetailHandlers = implementOperationDomain(entityDetail, {
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
      return result.item;
    },
  },
});

export const entityFilterOptionsHandlers = implementOperationDomain(
  entityFilterOptions,
  {
    filterOptions: (context, input) => getFilterOptions(context.readDb, input),
  },
);

export const entityMutationHandlers = implementOperationDomain(entityMutation, {
  mutate: {
    input: entityBrowserMutationCommandSchema,
    output: entityBrowserMutationResultSchema,
    // The client declares the pre-parse command type; the `input` override
    // above guarantees the runtime value is the schema's parsed output.
    run: (context, command) =>
      executeEntity(
        context,
        command as z.output<typeof entityBrowserMutationCommandSchema>,
      ),
  },
});

export const entityInspectorHealthHandlers = implementOperationDomain(
  entityInspectorHealth,
  {
    inspectorHealth: {
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
  entityIntegrity,
  {
    catalog: async () => buildIntegrityCatalog(),
  },
);
