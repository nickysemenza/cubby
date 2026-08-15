import { createFileRoute } from "@tanstack/react-router";
import { addDays } from "date-fns";
import { formatPlainDate } from "~/lib/plain-date";
import { type IcsFeed, kindsForFeed, renderIcs } from "~/server/calendar/ics";
import { db } from "~/server/db";
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

/** Days of history to publish. Enough for "what did we eat last month?". */
const PAST_DAYS = 60;
/**
 * Days of future to publish. PAST_DAYS + FUTURE_DAYS must stay under
 * MAX_CALENDAR_RANGE_DAYS (366) — getCalendarRange's input refuses a wider span.
 */
const FUTURE_DAYS = 305;

const FEEDS: Record<string, IcsFeed> = {
  "meals.ics": "meals",
  "tasks.ics": "tasks",
  "all.ics": "all",
};

const notFound = () =>
  new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });

/** `/api/calendar/<token>/<feed>` — read off the URL rather than the router's
 * params, so the handler doesn't depend on the server-handler context shape. */
const PATH = /^\/api\/calendar\/([^/]+)\/([^/]+)\/?$/;

async function handler({ request }: { request: Request }) {
  const url = new URL(request.url);
  const match = PATH.exec(url.pathname);
  if (!match) return notFound();
  const [, rawToken, rawFeed] = match;

  const feed = rawFeed ? FEEDS[rawFeed] : undefined;
  if (!feed || !rawToken) return notFound();

  let token: string;
  try {
    token = decodeURIComponent(rawToken);
  } catch {
    // decodeURIComponent throws URIError on a malformed %-sequence (`%ZZ`).
    // Unguarded that escapes as a 5xx, and any status other than 404 tells a
    // prober the route parsed this far. Note this is runtime-dependent: the
    // Node dev server rejects such a URL at the HTTP layer before the handler
    // runs, so it only reaches here on workerd. Same hazard `safeDecode` guards
    // in lib/sentry-scrub.ts.
    return notFound();
  }

  // A miss is a 404, not a 401: a 401 would confirm to anyone probing that this
  // URL shape is real and that only the token is wrong.
  const userId = await findUserByCalendarFeedToken(db, token);
  if (!userId) return notFound();

  const now = new Date();
  const startDate = formatPlainDate(addDays(now, -PAST_DAYS));
  const endDateExclusive = formatPlainDate(addDays(now, FUTURE_DAYS));

  const { items } = await getCalendarRange(db, {
    startDate,
    endDateExclusive,
    kinds: [...kindsForFeed(feed)],
  });

  return new Response(renderIcs(items, { feed, now, origin: url.origin }), {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `inline; filename="cubby-${feed}.ics"`,
      // `private` so no shared cache ever stores a response keyed by a URL that
      // carries a bearer credential.
      "Cache-Control": "private, max-age=900",
    },
  });
}

export const Route = createFileRoute("/api/calendar/$token/$feed")({
  server: { handlers: { GET: handler } },
});
