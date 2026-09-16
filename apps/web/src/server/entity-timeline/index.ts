import type { EntityTimelineOut } from "@cubby/schemas/entity-timeline";

import {
  entityTimelineModes,
  type ParsedEntityTimelineInputByEntity,
  type TimelineEntity,
} from "~/entities/generated/entity-timelines.gen";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { ENTITY_TIMELINE_BINDINGS } from "~/server/generated/entity-kernel-bindings.gen";

import type { EntityTimelineImplementation } from "./contracts";
import { defaultTimeline } from "./default-timeline";

const customTimelineFor = <E extends TimelineEntity>(
  entity: E,
): EntityTimelineImplementation<E> | undefined => {
  // SAFETY: the generator emits one binding per `capabilities.timeline:
  // "custom"` entity, keyed by that entity, so the lookup is typed per key.
  const bindings = ENTITY_TIMELINE_BINDINGS as {
    [K in TimelineEntity]?: EntityTimelineImplementation<K>;
  };
  return bindings[entity];
};

/** `resources.<entity>.timeline`: the bound custom implementation, else the shared default. */
export async function runEntityTimeline<E extends TimelineEntity>(
  context: EntityKernelContext,
  input: ParsedEntityTimelineInputByEntity[E],
): Promise<EntityTimelineOut> {
  const entity: E = input.entity;
  if (entityTimelineModes[entity] === "custom") {
    const custom = customTimelineFor(entity);
    if (!custom)
      throw new Error(`${entity} declares a custom timeline without a binding`);
    return custom(context, input);
  }
  return defaultTimeline(context, input);
}
