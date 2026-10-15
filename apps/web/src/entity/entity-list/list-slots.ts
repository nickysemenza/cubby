import type { Entity } from "@cubby/schemas/entity";
import type { ListSlotId } from "@cubby/schemas/entity-manifest";

import { featureRegistry } from "~/entity/feature-registry";
import type { PresentationCoverage } from "~/entity/presentation-coverage";

import type { ListSlotComponent } from "./list-slot-types";

/**
 * The web fills for every `kind: "slot"` list view the manifest declares.
 * Typed by `ListSlotId<E>`, so an entry for an undeclared slot (or a declared
 * slot spelled differently) fails to compile where `features/registry.tsx`
 * builds it, as does a declaration with no explicit platform disposition.
 * Each fill is lazy so the generic list route's chunk carries no slot view.
 */
export type ListSlotTable = {
  [E in Entity as ListSlotId<E> extends never ? never : E]: Record<
    ListSlotId<E>,
    PresentationCoverage<ListSlotComponent>
  >;
};

let slotRegistries:
  | ReadonlyMap<Entity, ReadonlyMap<string, ListSlotComponent>>
  | undefined;

const registries = () =>
  (slotRegistries ??= new Map(
    Object.entries(featureRegistry().listSlots).map(([entity, slots]) => [
      // SAFETY: `ListSlotTable` is keyed by `Entity`.
      entity as Entity,
      new Map(
        Object.entries(slots).map(([id, disposition]) => {
          if (disposition.kind !== "implemented") {
            throw new Error(`Web list slot ${entity}.${id} is not implemented`);
          }
          return [id, disposition.implementation];
        }),
      ),
    ]),
  ));

export function listSlotFor(
  entity: Entity,
  id: string,
): ListSlotComponent | undefined {
  return registries().get(entity)?.get(id);
}
