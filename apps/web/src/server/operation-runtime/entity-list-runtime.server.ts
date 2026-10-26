import { entityListContract } from "~/contracts/entity-list.contract";
import {
  entityListInputSchema,
  getEntityListOutputSchema,
} from "~/entity/generated/entity-lists.gen";
import { executeEntitySelectionIds } from "~/server/entity-kernel";
import { ENTITY_LIST_READ_OPERATIONS } from "~/server/generated/entity-list-read-bindings.gen";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

/**
 * The client declares type-only `z.custom` schemas for the generic entity
 * operations; the server owns runtime validation via `input`/`output`
 * overrides, and the output schema depends on the parsed input's entity.
 */
export const entityListHandlers = implementOperationDomain(entityListContract, {
  selectionIds: (context, input) => executeEntitySelectionIds(context, input),
  facetCounts: (context, input) =>
    ENTITY_LIST_READ_OPERATIONS[input.entity].facets(context, input),
  viewCounts: (context, input) =>
    ENTITY_LIST_READ_OPERATIONS[input.entity].viewCounts(context, input),
  list: {
    input: entityListInputSchema,
    output: (input) => getEntityListOutputSchema(input.entity),
    run: async (context, input) => {
      const { executeEntityAs } = await import("~/server/entity-kernel");
      const result = await executeEntityAs(context, "list", input);
      return getEntityListOutputSchema(input.entity).parse({
        items: result.items,
        meta: result.meta,
      });
    },
  },
});
