import { calendarContract } from "~/contracts/calendar.contract";
import {
  getCalendarRange,
  getCalendarSchedule,
} from "~/server/domains/calendar/repo/calendar";
import { calendarFeedStateFor } from "~/server/domains/calendar/repo/client";
import { readPublicEntityRows } from "~/server/generic/derived/service/public-read";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

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
  schedule: async (context, input) => {
    const result = await getCalendarSchedule(context.db, input);
    const [tasks, plantings] = await Promise.all([
      readPublicEntityRows({
        db: context.db,
        entity: "task",
        projection: "detail",
        rows: result.tasks,
      }),
      readPublicEntityRows({
        db: context.db,
        entity: "planting",
        projection: "detail",
        rows: result.plantings,
      }),
    ]);
    return { tasks, plantings };
  },
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
