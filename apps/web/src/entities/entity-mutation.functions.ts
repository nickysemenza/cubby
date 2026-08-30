import type { MutationSideEffects } from "@cubby/schemas/background-jobs";
import { hasFdcLink } from "@cubby/schemas/product";
import { z } from "zod";

import {
  entityRipple,
  ripple,
  type InvalidationTagSet,
} from "~/integrations/tanstack-query/cache-tags";
import {
  defineOperationDomain,
  mutation,
} from "~/integrations/tanstack-query/operation-catalog";
import type {
  EntityBrowserMutationInput,
  EntityBrowserMutationResult,
} from "~/server/entity-kernel/contracts";

import type { EntityEditResultFor } from "./editing/intent-types";
import type { EditableEntity } from "./editing/types";
import {
  entityMutationOutputEntities,
  parseEntityMutationOutput,
} from "./generated/entity-mutation-results.gen";

const entityMutationResultInputSchema = z.unknown();
type EntityMutationResultInput = z.input<
  typeof entityMutationResultInputSchema
>;

/**
 * A product create/update whose payload names an ingredient link (and,
 * optionally, an explicit USDA food link) moves more than a plain product
 * write does: the linked ingredient's own queries, and the linked usda-food
 * detail query, both go stale otherwise. Widening `ripple.product`
 * unconditionally would cost every product write in the app a refetch of
 * ingredient/usda-food queries it never touches — so this
 * widens only when the mutation's own input says the link is really there.
 * Named callers today: `usda-food-actions.tsx`'s "link to an ingredient"
 * flow and the ingredient-enrichment create paths
 * (`enrich-ingredient-dialog.tsx`, `enrichment-editor.tsx`).
 */
function productWriteTags(
  input: EntityBrowserMutationInput,
): InvalidationTagSet {
  if (
    input.entity !== "product" ||
    (input.action !== "create" && input.action !== "update")
  ) {
    return entityRipple("product");
  }
  const ingredientId = input.data.ingredientId;
  if (!ingredientId) return entityRipple("product");
  return hasFdcLink(input.data.fdc_id)
    ? ripple.ingredientProductUsdaFood
    : ripple.ingredientProduct;
}

/** @lintignore Discovered by the operation registry generator. */
export const entityMutation = defineOperationDomain("entity", {
  mutate: mutation({
    input: z.custom<EntityBrowserMutationInput>(),
    output: z.custom<EntityBrowserMutationResult>(),
    observability: {
      entities: [
        ...entityMutationOutputEntities,
        "ledgerParty",
        "ledgerTransfer",
        "image",
      ],
    },
    /**
     * Keyed on `entity` alone. `["entity"]` must NEVER appear here: `entity.list`
     * is tagged `[["entity","list"]]` and `entity.detail` `[["entity","detail"]]`,
     * both entity-AGNOSTIC, so the bare root would nuke every list and detail
     * query for every entity on every write. The fan-out is action-independent
     * for create/update/delete — those move the same surfaces — so an
     * `(entity, action)` table would be rows of identical values. Two
     * exceptions widen dynamically off the input rather than off
     * component-local state: `product`, whose OWN input can carry an
     * ingredient/usda-food link (see `productWriteTags`), and a `location`
     * bulk reparent, which moves inventory and problem views too.
     */
    invalidates: (input) =>
      input.entity === "product"
        ? productWriteTags(input)
        : // A location reparent moves inventory, product and problem views
          // too — the wide fan-out `location.bulkUpdateParent` declares.
          // `entityRipple("location")` is the narrow one.
          input.entity === "location" && input.action === "bulkUpdate"
          ? ripple.locationReparent
          : entityRipple(input.entity),
  }),
});

/** Recover the entity-specific output through the same schema that backs the kernel. */
export function parseEntityMutationResultFor<E extends EditableEntity>(
  entity: E,
  value: EntityMutationResultInput,
): EntityEditResultFor<E>;
export function parseEntityMutationResultFor(
  entity: EditableEntity,
  value: EntityMutationResultInput,
) {
  return parseEntityMutationOutput(entity, value);
}

export function parseEntityWriteResult<E extends EditableEntity>(
  entity: E,
  action: "create" | "update",
  result: EntityBrowserMutationResult,
): EntityEditResultFor<E> & { sideEffects: MutationSideEffects } {
  if (
    result.entity !== entity ||
    result.action !== action ||
    !("item" in result)
  )
    throw new Error("Entity mutation result did not match its command");
  return {
    ...parseEntityMutationResultFor(entity, result.item),
    sideEffects: result.sideEffects,
  };
}

export function countPrimaryDeletedReferences(
  result: Extract<EntityBrowserMutationResult, { action: "delete" }>,
) {
  return result.deletedReferences.filter(
    (reference) => reference.entity === result.entity,
  ).length;
}
