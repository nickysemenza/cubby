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
  }),
  getFeed: query({
    input: z.undefined(),
    output: calendarFeedOut,
  }),
  getCredential: query({
    input: z.undefined(),
    output: calendarCredentialOut,
  }),
  inspectFeed: query({
    input: z.undefined(),
    output: calendarFeedInspectionOut,
  }),
  clearUncertainWrite: mutation({
    input: clearCalendarUncertainWriteInput,
    output: z.object({ cleared: z.boolean() }),
  }),
  rotateFeed: mutation({
    input: z.undefined(),
    output: calendarRotateFeedOut,
  }),
  rotateCredential: mutation({
    input: z.undefined(),
    output: calendarRotateCredentialOut,
  }),
  revokeCredential: mutation({
    input: z.undefined(),
    output: calendarRevokeCredentialOut,
  }),
});
