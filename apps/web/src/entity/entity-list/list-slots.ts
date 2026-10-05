import type { Entity } from "@cubby/schemas/entity";
import type { ListSlotId } from "@cubby/schemas/entity-manifest";
import { lazy } from "react";

import {
  implemented,
  type PresentationCoverage,
} from "~/entity/presentation-coverage";

import type { ListSlotComponent } from "./list-slot-types";

/**
 * Binds one entity's slot module to its slot ids. Each fill is lazy so the
 * generic list route's chunk carries no slot view — the meal calendar,
 * project dashboards and task board load only when their view is selected.
 */
const slotsFrom =
  <Id extends string>(
    load: () => Promise<Readonly<Record<Id, ListSlotComponent>>>,
  ) =>
  (id: Id): PresentationCoverage<ListSlotComponent> =>
    implemented(
      lazy<ListSlotComponent>(() =>
        load().then((slots) => ({ default: slots[id] })),
      ),
    );

const expense = slotsFrom(() =>
  import("~/app/expenses/list-slots").then((m) => m.expenseListSlots),
);
const location = slotsFrom(() =>
  import("~/app/locations/list-slots").then((m) => m.locationListSlots),
);
const meal = slotsFrom(() =>
  import("~/app/meals/list-slots").then((m) => m.mealListSlots),
);
const planting = slotsFrom(() =>
  import("~/app/plantings/list-slots").then((m) => m.plantingListSlots),
);
const productCategory = slotsFrom(() =>
  import("~/app/product-categories/list-slots").then(
    (m) => m.productCategoryListSlots,
  ),
);
const project = slotsFrom(() =>
  import("~/app/projects/list-slots").then((m) => m.projectListSlots),
);
const run = slotsFrom(() =>
  import("~/app/runs/list-slots").then((m) => m.runListSlots),
);
const task = slotsFrom(() =>
  import("~/app/tasks/list-slots").then((m) => m.taskListSlots),
);

/**
 * The web fills for every `kind: "slot"` list view the manifest declares.
 * Typed by `ListSlotId<E>`, so an entry for an undeclared slot (or a declared
 * slot spelled differently) fails to compile, as does a declaration with no
 * explicit platform disposition.
 */
export const listSlotCoverage = {
  expense: { analytics: expense("analytics") },
  location: {
    gallery: location("gallery"),
    visualizations: location("visualizations"),
  },
  meal: { calendar: meal("calendar"), nutrition: meal("nutrition") },
  planting: { schedule: planting("schedule") },
  productCategory: { hierarchy: productCategory("hierarchy") },
  project: {
    overview: project("overview"),
    schedule: project("schedule"),
    analytics: project("analytics"),
  },
  run: { history: run("history") },
  task: { agenda: task("agenda"), board: task("board") },
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
