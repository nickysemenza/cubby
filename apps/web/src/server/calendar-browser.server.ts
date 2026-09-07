import { calendar } from "~/app/calendar/calendar.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  getCalendarCredentialWorkflow,
  getCalendarFeedWorkflow,
  getCalendarRangeWorkflow,
  inspectCalendarFeedWorkflow,
  revokeCalendarCredentialWorkflow,
  rotateCalendarCredentialWorkflow,
  rotateCalendarFeedWorkflow,
} from "~/server/workflows/calendar.server";

export const calendarHandlers = implementOperationDomain(calendar, {
  range: (context, input) => getCalendarRangeWorkflow(context.db, input),
  getFeed: (context) =>
    getCalendarFeedWorkflow(context.db, calendarOrigin(context.headers)),
  getCredential: (context) =>
    getCalendarCredentialWorkflow(
      calendarOrigin(context.headers),
      context.actorContext.userId,
    ),
  inspectFeed: (context) =>
    inspectCalendarFeedWorkflow(calendarOrigin(context.headers)),
  rotateFeed: (context) =>
    rotateCalendarFeedWorkflow(context.db, calendarOrigin(context.headers)),
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
