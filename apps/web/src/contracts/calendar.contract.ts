import {
  calendarCredentialOut,
  clearCalendarUncertainWriteInput,
  calendarFeedOut,
  calendarFeedInspectionOut,
  calendarRangeInput,
  calendarRangeOut,
  calendarScheduleOut,
  calendarRevokeCredentialOut,
  calendarRotateCredentialOut,
  calendarRotateFeedOut,
} from "@cubby/schemas/calendar";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

export const calendarContract = defineContract("calendar", {
  range: query({
    native: "Meal calendar",
    input: calendarRangeInput,
    output: calendarRangeOut,
  }),
  schedule: query({
    input: calendarRangeInput,
    output: calendarScheduleOut,
    cache: { tags: [["calendar", "range"]] },
  }),
  getFeed: query({
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
    readPolicy: "strong",
    input: z.undefined(),
    output: calendarFeedInspectionOut,
    cache: { tags: [["calendar", "feed"]], profile: "live-status" },
  }),
  clearUncertainWrite: mutation({
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
});
