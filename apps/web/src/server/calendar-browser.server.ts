import { calendar } from "~/app/calendar/calendar.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  getCalendarFeedWorkflow,
  getCalendarRangeWorkflow,
  rotateCalendarFeedWorkflow,
} from "~/server/workflows/calendar.server";

export const calendarHandlers = implementOperationDomain(calendar, {
  range: (context, input) => getCalendarRangeWorkflow(context.db, input),
  getFeed: (context) =>
    getCalendarFeedWorkflow(context.db, context.actorContext.userId),
  rotateFeed: (context) =>
    rotateCalendarFeedWorkflow(context.db, context.actorContext.userId),
});
