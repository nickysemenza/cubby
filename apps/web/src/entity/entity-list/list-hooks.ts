import type { Entity } from "@cubby/schemas/entity";
import type { ListSlotId } from "@cubby/schemas/entity-manifest";

import type { ListSlotComponent } from "./list-slot-types";

type ListSlotFills<E extends Entity> = [ListSlotId<E>] extends [never]
  ? { slots?: never }
  : { slots: Record<ListSlotId<E>, ListSlotComponent> };

/**
 * One entity's list-page UI, declared in its typed hook module
 * (`entity/clients/<entity>.list.tsx`) and bound by its generated client
 * module. `slots` fills every `kind: "slot"` list view the declaration names,
 * keyed by `ListSlotId<E>`, so an undeclared or misspelled slot fails to
 * compile.
 */
export type ListHooks<E extends Entity> = ListSlotFills<E>;

export const defineListHooks = <E extends Entity>(
  _entity: E,
  hooks: ListHooks<E>,
): ListHooks<E> => hooks;

export interface ListClient<E extends Entity> {
  entity: E;
  slots: Readonly<Partial<Record<string, ListSlotComponent>>>;
}

/** Called by the generated client module (`entity/generated/clients/<entity>.list.gen.ts`). */
export const defineListClient = <E extends Entity>(
  entity: E,
  hooks: ListHooks<E>,
): ListClient<E> => ({ entity, slots: hooks.slots ?? {} });
