import {
  calendarFeedOut,
  calendarFeedInspectionOut,
  calendarRangeInput,
  calendarRangeOut,
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
  inspectFeed: query({
    input: z.undefined(),
    output: calendarFeedInspectionOut,
    tags: [["calendar", "feed"]],
    cache: "live-status",
  }),
  rotateFeed: mutation({
    input: z.undefined(),
    output: calendarRotateFeedOut,
    invalidates: ripple.calendarFeed,
  }),
});
