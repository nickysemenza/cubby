import { createFileRoute } from "@tanstack/react-router";

import { externalCalendarFeedStateFor } from "~/server/calendar/client";
import { createCalendarFeedHandler } from "~/server/calendar/feed";

/**
 * Published iCalendar feed: /api/calendar/<token>/<feed>.ics
 *
 * The `.ics` suffix needs no `[.]` escape in the filename: a dynamic segment
 * captures the dot, so `$feed` arrives as the literal "meals.ics".
 */

const handler = createCalendarFeedHandler((origin) =>
  externalCalendarFeedStateFor(origin),
);

export const Route = createFileRoute("/api/calendar/$token/$feed")({
  server: { handlers: { GET: handler, HEAD: handler } },
});
