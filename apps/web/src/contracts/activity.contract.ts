import {
  activityListInput,
  activityListOutput,
  activityGroupsOutput,
  activityGroupChildrenInput,
  activityDetailOutput,
  activityAttemptInput,
  activityEventsOutput,
  activityDevicesOutput,
  activitySubmissionInput,
  activitySubmissionOutput,
} from "@cubby/schemas/activity";
import { z } from "zod";

import { defineContract, query } from "~/contracts/define";

export const activityContract = defineContract("activity", {
  list: query({
    native: "Activity runs",
    input: activityListInput,
    output: activityListOutput,
    cache: { tags: [["image"], ["purchase"]] },
  }),
  groups: query({
    native: "Grouped work history",
    input: activityListInput,
    output: activityGroupsOutput,
    cache: { tags: [["image"], ["purchase"]] },
  }),
  groupChildren: query({
    native: "Work history group children",
    input: activityGroupChildrenInput,
    output: activityListOutput,
    cache: { tags: [["image"], ["purchase"]] },
  }),
  detail: query({
    native: "Activity run details",
    input: activityAttemptInput,
    output: activityDetailOutput,
    cache: { tags: [["image"], ["purchase"]] },
  }),
  events: query({
    native: "Activity run events",
    input: activityAttemptInput,
    output: activityEventsOutput,
    cache: { tags: [["image"], ["purchase"]] },
  }),
  devices: query({
    native: "Activity execution devices",
    input: z.object({}),
    output: activityDevicesOutput,
    cache: { tags: [["image"], ["purchase"]] },
  }),
  submission: query({
    native: "Image processing submission",
    input: activitySubmissionInput,
    output: activitySubmissionOutput,
    cache: { tags: [["image"], ["purchase"]] },
  }),
});
