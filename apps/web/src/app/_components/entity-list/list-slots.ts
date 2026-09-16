import type { Entity } from "@cubby/schemas/entity";
import type { ListSlotId } from "@cubby/schemas/entity-manifest";

import { expenseListSlots } from "~/app/expenses/list-slots";
import { locationListSlots } from "~/app/locations/list-slots";
import { mealListSlots } from "~/app/meals/list-slots";
import { projectListSlots } from "~/app/projects/list-slots";
import { taskListSlots } from "~/app/tasks/list-slots";

import type { ListSlotComponent } from "./list-slot-types";

/**
 * The web fills for every `kind: "slot"` list view the manifest declares.
 * Typed by `ListSlotId<E>`, so an entry for an undeclared slot (or a declared
 * slot spelled differently) fails to compile; a declared slot with no entry
 * renders nothing on this platform.
 */
const listSlots = {
  expense: expenseListSlots,
  location: locationListSlots,
  meal: mealListSlots,
  project: projectListSlots,
  task: taskListSlots,
} satisfies {
  [E in Entity]?: Partial<Record<ListSlotId<E>, ListSlotComponent>>;
};

const slotRegistries = new Map<Entity, ReadonlyMap<string, ListSlotComponent>>(
  Object.entries(listSlots).map(([entity, slots]) => [
    // SAFETY: `listSlots` is keyed by `Entity` (checked by `satisfies`).
    entity as Entity,
    new Map(Object.entries(slots)),
  ]),
);

export function listSlotFor(
  entity: Entity,
  id: string,
): ListSlotComponent | undefined {
  return slotRegistries.get(entity)?.get(id);
}
