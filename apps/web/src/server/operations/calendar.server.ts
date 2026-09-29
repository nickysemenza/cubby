import { calendarContract } from "~/contracts/calendar.contract";
import { calendarFeedStateFor } from "~/server/calendar/client";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { getCalendarRange, getCalendarSchedule } from "~/server/repo/calendar";

function calendarOrigin(headers: Headers): string {
  const origin = headers.get("origin");
  if (origin) return new URL(origin).origin;
  const host = headers.get("host") ?? "localhost:3000";
  const protocol =
    headers.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  return `${protocol}://${host}`;
}

/** The Durable Object retains protocol state and owns each awaited write's
 * commit boundary; every action first resolves that per-origin client. */
const calendarClient = (context: { headers: Headers }) =>
  calendarFeedStateFor(calendarOrigin(context.headers));

export const calendarHandlers = implementOperationDomain(calendarContract, {
  range: (context, input) => getCalendarRange(context.db, input),
  schedule: (context, input) => getCalendarSchedule(context.db, input),
  getFeed: async (context) => ({
    token: await (await calendarClient(context)).getToken(),
  }),
  getCredential: async (context) =>
    (await calendarClient(context)).getCalendarCredential(
      context.actorContext.userId,
    ),
  inspectFeed: async (context) => (await calendarClient(context)).inspect(),
  clearUncertainWrite: async (context, input) => {
    await (
      await calendarClient(context)
    ).clearUncertainWrite(input.collection, input.filename);
    return { cleared: true };
  },
  rotateFeed: async (context) => ({
    token: await (await calendarClient(context)).rotate(),
  }),
  rotateCredential: async (context) =>
    (await calendarClient(context)).rotateCalendarCredential(
      context.actorContext.userId,
    ),
  revokeCredential: async (context) => {
    await (
      await calendarClient(context)
    ).revokeCalendarCredential(context.actorContext.userId);
    return { revoked: true };
  },
});
