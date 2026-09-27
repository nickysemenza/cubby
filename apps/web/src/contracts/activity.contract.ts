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
  }),
  groups: query({
    native: "Grouped work history",
    input: activityListInput,
    output: activityGroupsOutput,
  }),
  groupChildren: query({
    native: "Work history group children",
    input: activityGroupChildrenInput,
    output: activityListOutput,
  }),
  detail: query({
    native: "Activity run details",
    input: activityAttemptInput,
    output: activityDetailOutput,
  }),
  events: query({
    native: "Activity run events",
    input: activityAttemptInput,
    output: activityEventsOutput,
  }),
  devices: query({
    native: "Activity execution devices",
    input: z.object({}),
    output: activityDevicesOutput,
  }),
  submission: query({
    native: "Image processing submission",
    input: activitySubmissionInput,
    output: activitySubmissionOutput,
  }),
});
