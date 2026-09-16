import type { EntityTimelineOut } from "@cubby/schemas/entity-timeline";

import type {
  ParsedEntityTimelineInputByEntity,
  TimelineEntity,
} from "~/entities/generated/entity-timelines.gen";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";

/**
 * A custom `resources.<entity>.timeline` implementation, bound through
 * `extensions.ports.timeline` (`ENTITY_TIMELINE_BINDINGS`). Default-timeline
 * entities are served by the shared implementation instead.
 */
export type EntityTimelineImplementation<
  E extends TimelineEntity = TimelineEntity,
> = (
  context: EntityKernelContext,
  input: ParsedEntityTimelineInputByEntity[E],
) => Promise<EntityTimelineOut>;
