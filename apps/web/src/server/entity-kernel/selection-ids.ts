import { z } from "zod";

import {
  entitySelectionIdsInputSchema,
  entitySelectionIdsOutputSchema,
} from "~/contracts/entity-list.contract";
import { ENTITY_KERNEL_BINDINGS } from "~/server/generated/entity-kernel-bindings.gen";
import { listFacetCounter } from "~/server/generic/list/repo/list";

import type { EntityKernelContext } from "./adapter";
import { resolveFilterTokens } from "./filter-tokens";
import { parseNesting } from "./list-input";

/** Explicit public IDs for bulk action preparation; never hydrates canonical records. */
export async function executeEntitySelectionIds(
  context: EntityKernelContext,
  value: z.input<typeof entitySelectionIdsInputSchema>,
) {
  const input = entitySelectionIdsInputSchema.parse(value);
  const binding = ENTITY_KERNEL_BINDINGS[input.entity];
  const { ids, ...rest } = z
    .object({ ids: z.array(z.string()).max(500).optional() })
    .passthrough()
    .parse(input.filters);
  for (const id of ids ?? []) binding.schemas.id.parse(id);
  const filters = await resolveFilterTokens(
    context,
    binding.schemas.filters,
    binding.schemas.filters.parse(rest),
  );
  const scaffold = listFacetCounter(input.entity);
  if (scaffold === null)
    throw new Error(
      `${input.entity} has no canonical selection identity reader`,
    );
  return entitySelectionIdsOutputSchema.parse(
    await scaffold.selectionIds(
      context.db,
      {
        ...filters,
        ...(ids === undefined ? {} : { ids }),
        nesting: parseNesting(binding, input.nesting),
      },
      input,
    ),
  );
}
