import {
  calendarCredentialOut,
  clearCalendarUncertainWriteInput,
  calendarFeedOut,
  calendarFeedInspectionOut,
  calendarRangeInput,
  calendarWindowInput,
  calendarRangeOut,
  calendarScheduleOut,
  calendarRevokeCredentialOut,
  calendarRotateCredentialOut,
  calendarRotateFeedOut,
} from "@cubby/schemas/calendar";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

export const calendarContract = defineContract(
  "calendar",
  {
    range: query({
      exposure: "view",
      note: "Agents read meals and tasks by date through entity_read.list",
      native: "Meal calendar",
      // Native applies list filters through the meal list, so its typed range
      // request does not need every calendar source's filter model.
      httpWire: { input: calendarWindowInput, output: calendarRangeOut },
      input: calendarRangeInput,
      output: calendarRangeOut,
    }),
    schedule: query({
      exposure: "view",
      input: calendarRangeInput,
      output: calendarScheduleOut,
      cache: { tags: [["calendar", "range"]] },
    }),
    getFeed: query({
      note: "Subscribable calendar feed URL",
      readPolicy: "strong",
      input: z.undefined(),
      output: calendarFeedOut,
      cache: { tags: [["calendar", "feed"]] },
    }),
    // Credentials and live operational state.
    getCredential: query({
      readPolicy: "strong",
      input: z.undefined(),
      output: calendarCredentialOut,
      cache: { tags: [["calendar", "credential"]], profile: "live-status" },
    }),
    inspectFeed: query({
      exposure: "capability",
      note: "Feed delivery diagnostics",
      description:
        "Inspect one calendar feed’s delivery diagnostics, including the last uncertain write. Use this before clearing uncertainty; it does not retry or change the feed.",
      readPolicy: "strong",
      input: z.undefined(),
      output: calendarFeedInspectionOut,
      cache: { tags: [["calendar", "feed"]], profile: "live-status" },
    }),
    clearUncertainWrite: mutation({
      exposure: "capability",
      description:
        "Clear the uncertain-write marker for a calendar feed so delivery can proceed. Inspect the feed first; clearing the marker does not replay the write.",
      input: clearCalendarUncertainWriteInput,
      output: z.object({ cleared: z.boolean() }),
      invalidates: ["calendarFeed"],
    }),
    rotateFeed: mutation({
      input: z.undefined(),
      output: calendarRotateFeedOut,
      invalidates: ["calendarFeed"],
    }),
    rotateCredential: mutation({
      input: z.undefined(),
      output: calendarRotateCredentialOut,
      invalidates: ["calendarCredential"],
    }),
    revokeCredential: mutation({
      input: z.undefined(),
      output: calendarRevokeCredentialOut,
      invalidates: ["calendarCredential"],
    }),
  },
  { exposure: "internal", mcpToolGroup: "maintenance" },
);
