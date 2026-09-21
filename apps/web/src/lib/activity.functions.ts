import { activityContract } from "~/contracts/activity.contract";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";
export const activity = defineOperationDomain(activityContract, {
  list: { tags: [["image"], ["purchase"]] },
  detail: { tags: [["image"], ["purchase"]] },
  events: { tags: [["image"], ["purchase"]] },
  devices: { tags: [["image"], ["purchase"]] },
  submission: { tags: [["image"], ["purchase"]] },
});
