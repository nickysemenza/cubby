import {
  calendarCredentialOut,
  clearCalendarUncertainWriteInput,
  calendarFeedOut,
  calendarFeedInspectionOut,
  calendarRangeInput,
  calendarRangeOut,
  calendarRevokeCredentialOut,
  calendarRotateCredentialOut,
  calendarRotateFeedOut,
} from "@cubby/schemas/calendar";
import { z } from "zod";

import { ripple } from "~/integrations/tanstack-query/cache-tags";
import {
  defineOperationDomain,
  mutation,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const calendar = defineOperationDomain("calendar", {
  range: query({
    input: calendarRangeInput,
    output: calendarRangeOut,
    tags: [["calendar", "range"]],
  }),
  getFeed: query({
    input: z.undefined(),
    output: calendarFeedOut,
    tags: [["calendar", "feed"]],
  }),
  getCredential: query({
    input: z.undefined(),
    output: calendarCredentialOut,
    tags: [["calendar", "credential"]],
    cache: "live-status",
  }),
  inspectFeed: query({
    input: z.undefined(),
    output: calendarFeedInspectionOut,
    tags: [["calendar", "feed"]],
    cache: "live-status",
  }),
  clearUncertainWrite: mutation({
    input: clearCalendarUncertainWriteInput,
    output: z.object({ cleared: z.boolean() }),
    invalidates: ripple.calendarFeed,
  }),
  rotateFeed: mutation({
    input: z.undefined(),
    output: calendarRotateFeedOut,
    invalidates: ripple.calendarFeed,
  }),
  rotateCredential: mutation({
    input: z.undefined(),
    output: calendarRotateCredentialOut,
    invalidates: ripple.calendarCredential,
  }),
  revokeCredential: mutation({
    input: z.undefined(),
    output: calendarRevokeCredentialOut,
    invalidates: ripple.calendarCredential,
  }),
});
