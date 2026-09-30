import { entityListContract } from "~/contracts/entity-list.contract";
import {
  entityListInputSchema,
  getEntityListOutputSchema,
  entityListBaseOutputSchema,
  entityListEnrichmentOutputSchema,
  entityListSummaryOutputSchema,
} from "~/entities/generated/entity-lists.gen";
import { ENTITY_LIST_READ_OPERATIONS } from "~/server/generated/entity-list-read-bindings.gen";
import { implementOperationDomain } from "~/server/operation-domain.server";

/**
 * The client declares type-only `z.custom` schemas for the generic entity
 * operations; the server owns runtime validation via `input`/`output`
 * overrides, and the output schema depends on the parsed input's entity.
 */
export const entityListHandlers = implementOperationDomain(entityListContract, {
  listBase: async (context, input) =>
    entityListBaseOutputSchema.parse(
      await ENTITY_LIST_READ_OPERATIONS[input.entity].base(context, input),
    ),
  listEnrichment: async (context, input) =>
    entityListEnrichmentOutputSchema.parse(
      await ENTITY_LIST_READ_OPERATIONS[input.entity].enrich(context, input),
    ),
  listSummary: async (context, input) =>
    entityListSummaryOutputSchema.parse(
      await ENTITY_LIST_READ_OPERATIONS[input.entity].summary(context, input),
    ),
  list: {
    input: entityListInputSchema,
    output: (input) => getEntityListOutputSchema(input.entity),
    run: async (context, input) => {
      const { executeEntity } = await import("~/server/entity-kernel");
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
