import type { z } from "zod";

import { entityListContract } from "~/contracts/entity-list.contract";
import { entityListInputSchema } from "~/entity/model/list-contracts";
import { loadEntityListSchemas } from "~/entity/model/read-schemas/loaders";
import { resolveFilterTokens } from "~/server/entity-kernel/filter-tokens";
import { listOperations } from "~/server/entity-kernel/list-operations";
import { executeEntitySelectionIds } from "~/server/entity-kernel/selection-ids";
import {
  entityActionReadFields,
  withEntityActionStates,
} from "~/server/generic/actions/entity-action-states";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

/**
 * The client declares type-only `z.custom` schemas for the generic entity
 * operations; the server owns runtime validation via `input`/`output`
 * overrides, and the output schema depends on the parsed input's entity.
 */
export const entityListHandlers = implementOperationDomain(entityListContract, {
  selectionIds: (context, input) => executeEntitySelectionIds(context, input),
  facetCounts: async (context, input) =>
    (await listOperations(input.entity)).facets(context, input),
  viewCounts: async (context, input) =>
    (await listOperations(input.entity)).viewCounts(context, input),
  list: {
    input: entityListInputSchema,
    run: async (context, input) => {
      const schemas = await loadEntityListSchemas(input.entity);
      const parsed = schemas.listInput.parse(input);
      const resolved = await resolveFilterTokens(
        context,
        schemas.listInput,
        parsed,
      );
      if (input.fields !== undefined) {
        const result = await (
          await listOperations(input.entity)
        ).listFields(context, resolved, [
          ...new Set([
            ...input.fields,
            ...entityActionReadFields(input.entity),
          ]),
        ]);
        // SAFETY: the envelope builder validated each row against its selected
        // schema; re-parsing the page here only repeated that work. Only the
        // server-computed action states are added.
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- selected rows are validated but typed as generic records.
        return {
          items: withEntityActionStates(input.entity, [...result.items]),
          meta: result.meta,
          selectedFields: input.fields,
        } as unknown as z.output<typeof schemas.selectedListOutput>;
      }
      const { executeEntityAs } = await import("~/server/entity-kernel");
      const result = await executeEntityAs(context, "list", resolved);
      // SAFETY: as above, the kernel list returns validated public envelopes.
      return {
        items: withEntityActionStates(input.entity, [...result.items]),
        meta: result.meta,
      } as z.output<typeof schemas.listOutput>;
    },
  },
});
