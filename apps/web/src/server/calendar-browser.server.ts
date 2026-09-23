import { calendarContract } from "~/contracts/calendar.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  clearCalendarUncertainWriteWorkflow,
  getCalendarCredentialWorkflow,
  getCalendarFeedWorkflow,
  getCalendarRangeWorkflow,
  getCalendarScheduleWorkflow,
  inspectCalendarFeedWorkflow,
  revokeCalendarCredentialWorkflow,
  rotateCalendarCredentialWorkflow,
  rotateCalendarFeedWorkflow,
} from "~/server/workflows/calendar.server";

export const calendarHandlers = implementOperationDomain(calendarContract, {
  range: (context, input) => getCalendarRangeWorkflow(context.db, input),
  schedule: (context, input) => getCalendarScheduleWorkflow(context.db, input),
  getFeed: (context) =>
    getCalendarFeedWorkflow(calendarOrigin(context.headers)),
  getCredential: (context) =>
    getCalendarCredentialWorkflow(
      calendarOrigin(context.headers),
      context.actorContext.userId,
    ),
  inspectFeed: (context) =>
    inspectCalendarFeedWorkflow(calendarOrigin(context.headers)),
  clearUncertainWrite: (context, input) =>
    clearCalendarUncertainWriteWorkflow(calendarOrigin(context.headers), input),
  rotateFeed: (context) =>
    rotateCalendarFeedWorkflow(calendarOrigin(context.headers)),
  rotateCredential: (context) =>
    rotateCalendarCredentialWorkflow(
      calendarOrigin(context.headers),
      context.actorContext.userId,
    ),
  revokeCredential: (context) =>
    revokeCalendarCredentialWorkflow(
      calendarOrigin(context.headers),
      context.actorContext.userId,
    ),
});

function calendarOrigin(headers: Headers): string {
  const origin = headers.get("origin");
  if (origin) return new URL(origin).origin;
  const host = headers.get("host") ?? "localhost:3000";
  const protocol =
    headers.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  return `${protocol}://${host}`;
}
