import { calendarContract } from "~/contracts/calendar.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const calendar = defineOperationDomain(calendarContract, {
  range: { tags: [["calendar", "range"]] },
  schedule: { tags: [["calendar", "range"]] },
  getFeed: { tags: [["calendar", "feed"]] },
  getCredential: { tags: [["calendar", "credential"]], cache: "live-status" },
  inspectFeed: { tags: [["calendar", "feed"]], cache: "live-status" },
  clearUncertainWrite: { invalidates: ripple.calendarFeed },
  rotateFeed: { invalidates: ripple.calendarFeed },
  rotateCredential: { invalidates: ripple.calendarCredential },
  revokeCredential: { invalidates: ripple.calendarCredential },
});
