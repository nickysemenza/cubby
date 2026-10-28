import {
  connectedRecordsInputSchema,
  connectedRecordsOutputSchema,
  connectedRecordsPreviewInputSchema,
  connectedRecordsPreviewOutputSchema,
} from "@cubby/schemas/connected-records";
import {
  connectionDiscoveryOut,
  entityConnectionsInput,
  entityConnectionsOut,
} from "@cubby/schemas/entity-connections";
import {
  monthlyExpenseSpendInputSchema,
  monthlyExpenseSpendOutputSchema,
  detailActivityInputSchema,
  detailActivityOutputSchema,
} from "@cubby/schemas/entity-detail-data";
import {
  entityGraphExploreInputSchema,
  entityGraphExploreOutputSchema,
  entityGraphInputSchema,
  entityGraphOutputSchema,
  entityGraphRootSchema,
  entityGraphPathsInputSchema,
  entityGraphPathsOutputSchema,
} from "@cubby/schemas/entity-graph";
import { allEntities } from "@cubby/schemas/entity-roster";
import { z } from "zod";

import { ENTITY_ROOT_TAGS } from "~/contracts/cache-policy";
import { defineContract, mutation, query } from "~/contracts/define";
import {
  generatedEntityRelationListInputSchema,
  generatedEntityRelationListOutputSchema,
} from "~/entity/generated/entity-relation-lists.gen";

import {
  entityRecordsInputSchema,
  entityRecordsOutputSchema,
} from "./entity-records.schema";

export const entityGraphContract = defineContract(
  "entity",
  {
    monthlyExpenseSpend: query({
      input: monthlyExpenseSpendInputSchema,
      output: monthlyExpenseSpendOutputSchema,
      cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
    }),
    detailActivity: query({
      input: detailActivityInputSchema,
      output: detailActivityOutputSchema,
      cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
    }),
    records: query({
      note: "Agents read relations through entity_graph_read.relation and entity_graph_read.connections",
      input: entityRecordsInputSchema,
      output: entityRecordsOutputSchema,
      cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
    }),
    connectedRecords: query({
      input: connectedRecordsInputSchema,
      output: connectedRecordsOutputSchema,
      cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
    }),
    connectedRecordsPreview: query({
      input: connectedRecordsPreviewInputSchema,
      output: connectedRecordsPreviewOutputSchema,
      cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
    }),
    explore: query({
      input: entityGraphExploreInputSchema,
      output: entityGraphExploreOutputSchema,
      cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
    }),
    graph: query({
      input: entityGraphInputSchema,
      output: entityGraphOutputSchema,
      cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
    }),
    graphPaths: query({
      input: entityGraphPathsInputSchema,
      output: entityGraphPathsOutputSchema,
      cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
    }),
    relation: query({
      exposure: "capability",
      description:
        'A counted page of declared relation rows (`offset`, `limit`, optional `targetIds`). Purchase products and inverse product purchases union live Expense evidence with explicit links. Movement kinds describe actual Expenses and acquisition confirmations; hasPlanned marks future Expenses. Only explicit links can be unlinked. `purchase` `products`: the Products one Purchase names; `source` says why a row is there: "expense" when one of the order\'s own live Expenses names the product, "link" for an explicit purchaseProduct link (goods bought through allocation-basis installment Expenses, which never carry a productId), "both" when each exists. This is provenance, not money — no amount or quantity, nothing summed into spend; `linkAttachedAt` is null on an "expense" row, so only rows with it set have a link to unlink. `product` `components`: what one kit or multi-pack Product is made of, one row per distinct component with its quantity; each row\'s `price` is the component\'s effective price, which already blends its quantity-weighted share of every kit it is in — do not add a kit share on top. `project` `resources`: the reusable tools and software explicitly used on one exact project; tools carry lifetime purchase/use economics, software the non-additive household spend charged during the project\'s window. Sub-project uses are separate.',
      input: generatedEntityRelationListInputSchema,
      output: generatedEntityRelationListOutputSchema,
      cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
    }),
    connections: query({
      exposure: "capability",
      description:
        'One-hop physical connections of any entity: what points at it (`incoming`) and what it points at (`outgoing`), grouped by edge with a count and the first linked records. A merged-away code is refused with the survivor\'s code. Pass `operation: "delete"` or `"merge"` to see each incoming group\'s declared disposition (block, detach, repoint, ...) before running it; advisory, since the mutation re-validates.',
      input: entityConnectionsInput,
      output: entityConnectionsOut,
      cache: { tags: [["relatedData"], ...ENTITY_ROOT_TAGS] },
    }),
  },
  { exposure: "view", mcpToolGroup: "entity_graph" },
);

export const connectionContract = defineContract(
  "connection",
  {
    read: query({
      note: "Native view read; agents use scoped suggestions_read.list",
      input: entityGraphRootSchema,
      output: connectionDiscoveryOut,
      cache: {
        tags: [
          ["connections"],
          ...allEntities.map((entity) => [entity] as const),
        ],
      },
    }),
    readBatch: query({
      input: z.object({ sources: z.array(entityGraphRootSchema).max(250) }),
      output: z.array(connectionDiscoveryOut),
      cache: {
        tags: [
          ["connections"],
          ...allEntities.map((entity) => [entity] as const),
        ],
      },
    }),
    discover: mutation({
      exposure: "capability",
      description:
        "Discover proposed relationships for an existing record using bounded typed matchers. Publishes Assessments, without accepting new links. Repeated purchases remain eligible. Review the exact proposed effect before acceptance.",
      modelBacked: true,
      input: entityGraphRootSchema,
      output: connectionDiscoveryOut,
      invalidates: ["connections"],
    }),
  },
  { exposure: "view", mcpToolGroup: "entity_graph" },
);
