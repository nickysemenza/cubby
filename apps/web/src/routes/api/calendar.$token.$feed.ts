import { createFileRoute } from "@tanstack/react-router";

import { createCalendarFeedHandler } from "~/server/calendar/feed";
import { boundedStaleDb, db } from "~/server/db";
import { getCalendarRange } from "~/server/repo/calendar";
import { findUserByCalendarFeedToken } from "~/server/repo/calendar-feed";

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

const handler = createCalendarFeedHandler({
  authorizationDb: db,
  contentDb: boundedStaleDb,
  findUserByToken: findUserByCalendarFeedToken,
  getRange: getCalendarRange,
  now: () => new Date(),
});

export const Route = createFileRoute("/api/calendar/$token/$feed")({
  server: { handlers: { GET: handler } },
});
