import type { EntityTimelineOut } from "@cubby/schemas/entity-timeline";
import { z } from "zod";

import { defineContract, query } from "~/contracts/define";
import { kernelTimelineWire } from "~/contracts/entity-kernel-wire";
import {
  type EntityTimelineInputByEntity,
  type TimelineEntity,
  timelineEntities,
} from "~/entity/generated/entity-timelines.gen";

export const entityTimelineContract = defineContract("entity", {
  timeline: query({
    mcp: {
      omit: "client_view",
      note: "Agents read change history through activity.recent",
    },
    // Type-only carriers: the per-entity runtime schemas live in the generated
    // timeline bindings and are applied by the browser `parse` policy and the
    // server handler; HTTP carries the loose kernel wire.
    input: z.custom<EntityTimelineInputByEntity[TimelineEntity]>(),
    output: z.custom<EntityTimelineOut>(),
    httpWire: kernelTimelineWire,
    native: "Entity timelines",
    observability: { entities: timelineEntities },
  }),
});
