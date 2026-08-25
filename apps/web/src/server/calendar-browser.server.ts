import { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import {
  calendarFeedOut,
  calendarRangeInput,
  calendarRangeOut,
  calendarRotateFeedOut,
  getCalendarFeedWorkflow,
  getCalendarRangeWorkflow,
  rotateCalendarFeedWorkflow,
} from "~/server/workflows/calendar.server";

export const getCalendarRangeForBrowser = async (options: {
  data: z.input<typeof calendarRangeInput>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "calendar.range",
    type: "query",
    input: options.data,
    inputSchema: calendarRangeInput,
    outputSchema: calendarRangeOut,
    request: options.request,
    run: (context, input) => getCalendarRangeWorkflow(context.db, input),
  });

export const getCalendarFeedForBrowser = async (options: {
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "calendar.getFeed",
    type: "query",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: calendarFeedOut,
    request: options.request,
    run: (context) =>
      getCalendarFeedWorkflow(context.db, context.actorContext.userId),
  });

export const rotateCalendarFeedForBrowser = async (options: {
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "calendar.rotateFeed",
    type: "mutation",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: calendarRotateFeedOut,
    request: options.request,
    run: (context) =>
      rotateCalendarFeedWorkflow(context.db, context.actorContext.userId),
  });
