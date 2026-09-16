import type { EntityTimelineOut } from "@cubby/schemas/entity-timeline";
import { z } from "zod";

import { defineContract, query } from "~/contracts/define";
import {
  type EntityTimelineInputByEntity,
  type TimelineEntity,
  timelineEntities,
} from "~/entities/generated/entity-timelines.gen";

export const entityTimelineContract = defineContract("entity", {
  timeline: query({
    // Type-only carriers: the per-entity runtime schemas live in the generated
    // timeline bindings and are applied by the browser `parse` policy and the
    // server handler; the HTTP router substitutes the real wire schema.
    input: z.custom<EntityTimelineInputByEntity[TimelineEntity]>(),
    output: z.custom<EntityTimelineOut>(),
    // HTTP serves these as `GET /<plural>/timeline` instead.
    http: false,
    observability: { entities: timelineEntities },
  }),
});
