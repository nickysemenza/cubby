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
    mcp: {
      omit: "client_view",
      note: "Agents read meals and tasks by date through entity_read.list",
    },
    native: "Meal calendar",
    input: calendarRangeInput,
    output: calendarRangeOut,
  }),
  schedule: query({
    mcp: { omit: "client_view" },
    input: calendarRangeInput,
    output: calendarScheduleOut,
    cache: { tags: [["calendar", "range"]] },
  }),
  getFeed: query({
    mcp: { omit: "auth_connection", note: "Subscribable calendar feed URL" },
    readPolicy: "strong",
    input: z.undefined(),
    output: calendarFeedOut,
    cache: { tags: [["calendar", "feed"]] },
  }),
  // Credentials and live operational state.
  getCredential: query({
    mcp: { omit: "auth_connection" },
    readPolicy: "strong",
    input: z.undefined(),
    output: calendarCredentialOut,
    cache: { tags: [["calendar", "credential"]], profile: "live-status" },
  }),
  inspectFeed: query({
    mcp: { omit: "operator_maintenance", note: "Feed delivery diagnostics" },
    readPolicy: "strong",
    input: z.undefined(),
    output: calendarFeedInspectionOut,
    cache: { tags: [["calendar", "feed"]], profile: "live-status" },
  }),
  clearUncertainWrite: mutation({
    mcp: { omit: "operator_maintenance" },
    input: clearCalendarUncertainWriteInput,
    output: z.object({ cleared: z.boolean() }),
    invalidates: ["calendarFeed"],
  }),
  rotateFeed: mutation({
    mcp: { omit: "auth_connection" },
    input: z.undefined(),
    output: calendarRotateFeedOut,
    invalidates: ["calendarFeed"],
  }),
  rotateCredential: mutation({
    mcp: { omit: "auth_connection" },
    input: z.undefined(),
    output: calendarRotateCredentialOut,
    invalidates: ["calendarCredential"],
  }),
  revokeCredential: mutation({
    mcp: { omit: "auth_connection" },
    input: z.undefined(),
    output: calendarRevokeCredentialOut,
    invalidates: ["calendarCredential"],
  }),
});
