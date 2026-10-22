import type { entityTimelineContract } from "~/contracts/entity-timeline.contract";
import { getEntityTimelineOutputSchema } from "~/entity/generated/entity-timelines.gen";

import type { OperationPolicies } from "../operation-catalog";

export const entityTimelineOverrides = {
  timeline: {
    parse: (result, input) =>
      getEntityTimelineOutputSchema(input.entity).parse(result),
  },
} satisfies OperationPolicies<(typeof entityTimelineContract)["ops"]>;
