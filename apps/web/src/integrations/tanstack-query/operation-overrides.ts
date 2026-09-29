import { hasFdcLink } from "@cubby/schemas/product";

import type { entityDetailContract } from "~/contracts/entity-detail.contract";
import type { entityListContract } from "~/contracts/entity-list.contract";
import type { entityMutationContract } from "~/contracts/entity-mutation.contract";
import type { entityTimelineContract } from "~/contracts/entity-timeline.contract";
import {
  type DetailEntity,
  getEntityDetailOutputSchema,
} from "~/entities/generated/entity-details.gen";
import {
  getEntityListOutputSchema,
  type ListEntity,
} from "~/entities/generated/entity-lists.gen";
import { getEntityTimelineOutputSchema } from "~/entities/generated/entity-timelines.gen";
import type { EntityBrowserMutationInput } from "~/server/entity-kernel/contracts";

import { entityRipple, type InvalidationTagSet, ripple } from "./cache-tags";
import type { OperationPolicies } from "./operation-catalog";

/**
 * Browser policy that cannot be contract data because it is a function of the
 * call's input: the output schema an entity-keyed operation parses with, a
 * cache profile chosen per entity, an invalidation fan-out chosen from the
 * write's payload. Everything static lives on the contract member instead
 * (`cache` / `invalidates`, see `contracts/cache-policy.ts`).
 *
 * The generated catalog spreads `operationOverrides.<domain>.<member>` onto
 * that member's resolved policy, so an override wins over contract data. Keyed
 * by domain export name (the contract's, without `Contract`). This module is
 * loaded by the browser and by the generator: no server runtime imports.
 */

const persistedDetailEntities = new Set<DetailEntity>([
  "product",
  "location",
  "recipe",
  "ingredient",
  "inventory",
]);

const stableIndexEntities = new Set<ListEntity>([
  "product",
  "location",
  "recipe",
  "ingredient",
]);

export type RelationCommand = Extract<
  EntityBrowserMutationInput,
  { action: "attach" | "detach" }
>;

/** A relation write moves both ends' views and the shared relationship surface. */
type RelationKey<C> = C extends { entity: string; relation: string }
  ? `${C["entity"]}:${C["relation"]}`
  : never;

const RELATION_RIPPLE = {
  "product:components": ripple.productComponent,
  "project:resources": ripple.projectResource,
  "purchase:products": ripple.purchaseProduct,
} satisfies Record<RelationKey<RelationCommand>, InvalidationTagSet>;

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

export const operationOverrides = {
  entityList: {
    listBase: {
      cache: (input) =>
        stableIndexEntities.has(input.entity) ? "browse" : undefined,
    },
    list: {
      parse: (result, input) =>
        getEntityListOutputSchema(input.entity).parse(result),
      cache: (input) =>
        stableIndexEntities.has(input.entity) ? "browse" : undefined,
    },
  } satisfies OperationPolicies<(typeof entityListContract)["ops"]>,
  entityDetail: {
    detail: {
      parse: (result, input) =>
        result === null
          ? null
          : getEntityDetailOutputSchema(input.entity).parse(result),
      cache: (input) =>
        persistedDetailEntities.has(input.entity)
          ? "persisted-detail"
          : undefined,
    },
  } satisfies OperationPolicies<(typeof entityDetailContract)["ops"]>,
  entityTimeline: {
    timeline: {
      parse: (result, input) =>
        getEntityTimelineOutputSchema(input.entity).parse(result),
    },
  } satisfies OperationPolicies<(typeof entityTimelineContract)["ops"]>,
  entityMutation: {
    mutate: {
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
      invalidates: (input) => {
        if (input.action === "attach" || input.action === "detach")
          return RELATION_RIPPLE[
            // SAFETY: the command schema only admits declared entity/relation
            // pairs; TS cannot correlate the two fields across the union.
            `${input.entity}:${input.relation}` as RelationKey<RelationCommand>
          ];
        // A product merge re-parents inventory, expenses and project uses and
        // recomputes dependent recipe costs, none of which a product write does.
        if (input.action === "merge")
          return input.entity === "product"
            ? ripple.productMerge
            : entityRipple(input.entity);
        return input.entity === "product"
          ? productWriteTags(input)
          : // A location reparent moves inventory, product and problem views
            // too — the wide fan-out `location.bulkUpdateParent` declares.
            // `entityRipple("location")` is the narrow one.
            input.entity === "location" && input.action === "bulkUpdate"
            ? ripple.locationReparent
            : entityRipple(input.entity);
      },
    },
  } satisfies OperationPolicies<(typeof entityMutationContract)["ops"]>,
};
