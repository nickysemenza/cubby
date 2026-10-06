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
    mcp: {
      omit: "client_view",
      note: "Work-history screen; agents read runs through entity_read and imports_read.purchase_status",
    },
    native: "Activity runs",
    input: activityListInput,
    output: activityListOutput,
    cache: { tags: [["image"], ["purchase"]] },
  }),
  groups: query({
    mcp: { omit: "client_view" },
    native: "Grouped work history",
    input: activityListInput,
    output: activityGroupsOutput,
    cache: { tags: [["image"], ["purchase"]] },
  }),
  groupChildren: query({
    mcp: { omit: "client_view" },
    native: "Work history group children",
    input: activityGroupChildrenInput,
    output: activityListOutput,
    cache: { tags: [["image"], ["purchase"]] },
  }),
  detail: query({
    mcp: { omit: "client_view" },
    native: "Activity run details",
    input: activityAttemptInput,
    output: activityDetailOutput,
    cache: { tags: [["image"], ["purchase"]] },
  }),
  events: query({
    mcp: { omit: "client_view" },
    native: "Activity run events",
    input: activityAttemptInput,
    output: activityEventsOutput,
    cache: { tags: [["image"], ["purchase"]] },
  }),
  devices: query({
    mcp: { omit: "client_view" },
    native: "Activity execution devices",
    input: z.object({}),
    output: activityDevicesOutput,
    cache: { tags: [["image"], ["purchase"]] },
  }),
  submission: query({
    mcp: { omit: "client_view" },
    native: "Image processing submission",
    input: activitySubmissionInput,
    output: activitySubmissionOutput,
    cache: { tags: [["image"], ["purchase"]] },
  }),
});
