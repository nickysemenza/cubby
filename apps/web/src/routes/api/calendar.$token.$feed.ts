import { createFileRoute } from "@tanstack/react-router";

import { calendarFeedStateFor } from "~/server/calendar/client";
import { createCalendarFeedHandler } from "~/server/calendar/feed";

/**
 * Published iCalendar feed: /api/calendar/<token>/<feed>.ics
 *
 * Lives under /api/ deliberately — sw-policy.ts bypasses the service worker only
 * for that prefix, so a feed anywhere else would be cache-first cached as if it
 * were a static asset and go stale.
 *
 * The `.ics` suffix needs no `[.]` escape in the filename: a dynamic segment
 * captures the dot, so `$feed` arrives as the literal "meals.ics".
 */

const handler = createCalendarFeedHandler((origin) =>
  calendarFeedStateFor(origin),
);

export const Route = createFileRoute("/api/calendar/$token/$feed")({
  server: { handlers: { GET: handler } },
});
