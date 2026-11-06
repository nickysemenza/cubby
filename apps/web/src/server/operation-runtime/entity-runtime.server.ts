import { entityDetailContract } from "~/contracts/entity-detail.contract";
import { entityFilterOptionsContract } from "~/contracts/entity-filter-options.contract";
import { entityGraphContract } from "~/contracts/entity-graph.contract";
import { entityMutationContract } from "~/contracts/entity-mutation.contract";
import { entityTimelineContract } from "~/contracts/entity-timeline.contract";
import { generatedEntityRelationListCommandSchema } from "~/entity/generated/entity-relation-lists.gen";
import {
  entityTimelineInputSchema,
  getEntityTimelineOutputSchema,
} from "~/entity/generated/entity-timelines.gen";
import { entityDetailInputSchema } from "~/entity/model/detail-contracts";
import { loadEntityDetailSchemas } from "~/entity/model/read-schemas/loaders";
import { executeEntity, executeEntityAs } from "~/server/entity-kernel";
import {
  entityBrowserMutationCommandSchema,
  entityBrowserMutationResultSchema,
} from "~/server/entity-kernel/contracts";
import { listEntityRecords } from "~/server/entity-kernel/repo/entity-records";
import { kernelScaffold } from "~/server/entity-kernel/scaffolds";
import {
  getDetailActivity,
  getMonthlyExpenseSpend,
} from "~/server/generic/entity-detail/repo/detail-data";
import { getEntityGraph } from "~/server/generic/entity-graph/repo/entity-graph";
import { getEntityGraphExplore } from "~/server/generic/entity-graph/repo/entity-graph-explore";
import { withGraphPreviews } from "~/server/generic/entity-graph/service/graph-preview";
import {
  getConnectedRecords,
  getConnectedRecordsPreview,
} from "~/server/generic/entity-links/repo/connected-records";
import { getEntityConnections } from "~/server/generic/entity-links/repo/entity-edge-source";
import { runEntityTimeline } from "~/server/generic/entity-timeline/service/entity-timeline.ts";
import { getFilterOptions } from "~/server/generic/list/repo/filter-options";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const entityDetailHandlers = implementOperationDomain(
  entityDetailContract,
  {
    detail: {
      // Query-default "context" policy: browser detail reads may ride the
      // bounded-stale handle; other contexts stay authoritative.
      input: entityDetailInputSchema,
      run: async (context, input) => {
        const schemas = await loadEntityDetailSchemas(input.entity);
        const result = await executeEntityAs(context, "get", {
          entity: input.entity,
          id: input.shortcode,
          missing: "null",
        });
        return result.item === null
          ? null
          : schemas.detailOutput.parse(result.item);
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
    filterOptions: (context, input) => getFilterOptions(context.db, input),
  },
);

export const entityGraphHandlers = implementOperationDomain(
  entityGraphContract,
  {
    monthlyExpenseSpend: (context, input) =>
      getMonthlyExpenseSpend(context.db, input),
    detailActivity: (context, input) => getDetailActivity(context.db, input),
    records: (context, input) => listEntityRecords(context.db, input),
    connectedRecords: (context, input) =>
      getConnectedRecords(context.db, input),
    connectedRecordsPreview: (context, input) =>
      getConnectedRecordsPreview(context.db, input),
    explore: async (context, input) =>
      withGraphPreviews(
        context,
        await getEntityGraphExplore(context.db, input),
      ),
    graph: async (context, input) =>
      withGraphPreviews(context, await getEntityGraph(context.db, input)),
    connections: (context, input) =>
      getEntityConnections(context.db, input, kernelScaffold),
    relation: async (context, input) => {
      // The parse brands the ids; the input's entity is a union, so the
      // parsed command (not the raw input) is what executeEntityAs accepts.
      const result = await executeEntityAs(
        context,
        "listRelation",
        generatedEntityRelationListCommandSchema.parse({
          action: "listRelation",
          ...input,
        }),
      );
      const { action: _, ...list } = result;
      return list;
    },
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
