import type { HttpRouteHandlers } from "~/lib/http-route-handler";
import { externalCalendarFeedStateFor } from "~/server/domains/calendar/repo/client";
import { createCalendarFeedHandler } from "~/server/domains/calendar/service/feed";

/**
 * Published iCalendar feed: /api/calendar/<token>/<feed>.ics
 *
 * The `.ics` suffix needs no `[.]` escape in the filename: a dynamic segment
 * captures the dot, so `$feed` arrives as the literal "meals.ics".
 */

const handler = createCalendarFeedHandler((origin) =>
  externalCalendarFeedStateFor(origin),
);

export const handlers: HttpRouteHandlers<
  { token: string; feed: string },
  "GET" | "HEAD"
> = { GET: handler, HEAD: handler };
