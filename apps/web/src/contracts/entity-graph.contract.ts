import {
  connectedRecordsInputSchema,
  connectedRecordsOutputSchema,
} from "@cubby/schemas/connected-records";
import {
  entityConnectionsInput,
  entityConnectionsOut,
} from "@cubby/schemas/entity-connections";
import {
  entityGraphExploreInputSchema,
  entityGraphExploreOutputSchema,
  entityGraphInputSchema,
  entityGraphOutputSchema,
  entityGraphPathsInputSchema,
  entityGraphPathsOutputSchema,
} from "@cubby/schemas/entity-graph";

import { defineContract, query } from "~/contracts/define";
import {
  generatedEntityRelationListInputSchema,
  generatedEntityRelationListOutputSchema,
} from "~/entities/generated/entity-relation-lists.gen";

export const entityGraphContract = defineContract("entity", {
  connectedRecords: query({
    native: "Complete connection tables with record path evidence",
    input: connectedRecordsInputSchema,
    output: connectedRecordsOutputSchema,
  }),
  explore: query({
    native: "Native relationship explorer",
    input: entityGraphExploreInputSchema,
    output: entityGraphExploreOutputSchema,
  }),
  graph: query({
    native: "Native relationship branch paging",
    input: entityGraphInputSchema,
    output: entityGraphOutputSchema,
  }),
  graphPaths: query({
    native: "Native relationship path evidence",
    input: entityGraphPathsInputSchema,
    output: entityGraphPathsOutputSchema,
  }),
  relation: query({
    mcp: {
      name: "list_entity_relation",
      description:
        "List the current rows of one attachable relation of one entity — the same relations attach/detach (entity tool) write. " +
        '`purchase` `products`: the Products one Purchase acquired. `source` says why each row is there: "expense" when one of the order\'s own acquiring Expenses names the product, "link" for an explicit PurchaseProduct link (the record for goods bought through allocation-basis installment Expenses, which never carry a productId), "both" when each exists. This is provenance, not money — no amount or quantity, nothing summed into spend; `linkAttachedAt` is null on an "expense" row, so only rows with it set have a link to detach. ' +
        "`product` `components`: what one kit or multi-pack Product is made of, one row per distinct component with its quantity. Each row's `price` is the component Product's effective price, which already blends its quantity-weighted share of every kit it is in — do not add a kit share on top. " +
        "`project` `resources`: the reusable tools and software explicitly used on one exact project; tools carry lifetime purchase/use economics, software the non-additive household spend charged during the project's window. Sub-project uses are separate.",
    },
    input: generatedEntityRelationListInputSchema,
    output: generatedEntityRelationListOutputSchema,
  }),
  connections: query({
    mcp: {
      name: "get_entity_connections",
      description:
        'One-hop physical connections of any entity: what points at it (`incoming`) and what it points at (`outgoing`), grouped by edge with a count and the first linked records. A merged-away code reads its survivor and reports `redirectedFrom`. Pass `operation: "delete"` or `"merge"` to see each incoming group\'s declared disposition (block, detach, repoint, ...) before running it; the preview is advisory and the mutation re-validates.',
      readPolicy: "strong",
    },
    native: "Native one-hop physical connections and delete/merge impact",
    input: entityConnectionsInput,
    output: entityConnectionsOut,
  }),
});
