import { entityListContract } from "~/contracts/entity-list.contract";
import { entityListInputSchema } from "~/entity/generated/entity-lists.gen";
import { loadEntityListSchemas } from "~/entity/model/read-schemas/loaders";
import { executeEntitySelectionIds } from "~/server/entity-kernel";
import { resolveFilterTokens } from "~/server/entity-kernel/filter-tokens";
import { listOperations } from "~/server/entity-kernel/list-operations";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

/**
 * The client declares type-only `z.custom` schemas for the generic entity
 * operations; the server owns runtime validation via `input`/`output`
 * overrides, and the output schema depends on the parsed input's entity.
 */
export const entityListHandlers = implementOperationDomain(entityListContract, {
  selectionIds: (context, input) => executeEntitySelectionIds(context, input),
  facetCounts: (context, input) =>
    listOperations(input.entity).facets(context, input),
  viewCounts: (context, input) =>
    listOperations(input.entity).viewCounts(context, input),
  list: {
    input: entityListInputSchema,
    run: async (context, input) => {
      const { executeEntityAs } = await import("~/server/entity-kernel");
      const schemas = await loadEntityListSchemas(input.entity);
      const parsed = schemas.listInput.parse(input);
      const resolved = await resolveFilterTokens(
        context,
        schemas.listInput,
        parsed,
      );
      if (input.fields !== undefined) {
        const result = await listOperations(input.entity).listFields(
          context,
          resolved,
          input.fields,
        );
        return schemas.selectedListOutput.parse({
          items: result.items,
          meta: result.meta,
          selectedFields: input.fields,
        });
      }
      const result = await executeEntityAs(context, "list", resolved);
      return schemas.listOutput.parse({
        items: result.items,
        meta: result.meta,
      });
    },
  },
});
