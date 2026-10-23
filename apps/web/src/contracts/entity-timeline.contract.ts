import type { EntityTimelineOut } from "@cubby/schemas/entity-timeline";
import { z } from "zod";

import { defineContract, query } from "~/contracts/define";
import { kernelTimelineWire } from "~/contracts/entity-kernel-wire";
import {
  type EntityTimelineInputByEntity,
  type TimelineEntity,
  timelineEntities,
} from "~/entity/generated/entity-timelines.gen";

export const entityTimelineContract = defineContract(
  "entity",
  {
    timeline: query({
      note: "Agents read change history through activity_read.list",
      input: z.custom<EntityTimelineInputByEntity[TimelineEntity]>(),
      output: z.custom<EntityTimelineOut>(),
      nativeModels: { input: "json" },
      operationWire: kernelTimelineWire,
      observability: { entities: timelineEntities },
    }),
  },
  { exposure: "view" },
);
