import type { Entity } from "@cubby/schemas/entity";
import type { ListSlotId } from "@cubby/schemas/entity-manifest";

import { expenseListSlots } from "~/app/expenses/list-slots";
import { locationListSlots } from "~/app/locations/list-slots";
import { mealListSlots } from "~/app/meals/list-slots";
import { plantingListSlots } from "~/app/plantings/list-slots";
import { productCategoryListSlots } from "~/app/product-categories/list-slots";
import { projectListSlots } from "~/app/projects/list-slots";
import { taskListSlots } from "~/app/tasks/list-slots";
import {
  implemented,
  type PresentationCoverage,
} from "~/entities/presentation-coverage";

import type { ListSlotComponent } from "./list-slot-types";

const implementedSlots = <
  T extends Readonly<Record<string, ListSlotComponent>>,
>(
  slots: T,
): { [K in keyof T]: PresentationCoverage<T[K]> } => {
  // SAFETY: Object.entries preserves each own key and value; the transform
  // changes only the value by wrapping it in the coverage discriminant.
  return Object.fromEntries(
    Object.entries(slots).map(([id, component]) => [
      id,
      implemented(component),
    ]),
  ) as { [K in keyof T]: PresentationCoverage<T[K]> };
};

/**
 * The web fills for every `kind: "slot"` list view the manifest declares.
 * Typed by `ListSlotId<E>`, so an entry for an undeclared slot (or a declared
 * slot spelled differently) fails to compile, as does a declaration with no
 * explicit platform disposition.
 */
export const listSlotCoverage = {
  expense: implementedSlots(expenseListSlots),
  location: implementedSlots(locationListSlots),
  meal: implementedSlots(mealListSlots),
  planting: implementedSlots(plantingListSlots),
  productCategory: implementedSlots(productCategoryListSlots),
  project: implementedSlots(projectListSlots),
  task: implementedSlots(taskListSlots),
} satisfies {
  [E in Entity as ListSlotId<E> extends never ? never : E]: Record<
    ListSlotId<E>,
    PresentationCoverage<ListSlotComponent>
  >;
};

const slotRegistries = new Map<Entity, ReadonlyMap<string, ListSlotComponent>>(
  Object.entries(listSlotCoverage).map(([entity, slots]) => [
    // SAFETY: `listSlotCoverage` is keyed by `Entity` (checked by `satisfies`).
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
);

export function listSlotFor(
  entity: Entity,
  id: string,
): ListSlotComponent | undefined {
  return slotRegistries.get(entity)?.get(id);
}
