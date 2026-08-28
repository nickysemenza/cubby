import { addDays } from "date-fns";

import { formatPlainDate } from "~/lib/plain-date";
import type { Database } from "~/server/db";
import { getCalendarRange } from "~/server/repo/calendar";
import { findUserByCalendarFeedToken } from "~/server/repo/calendar-feed";

import { type IcsFeed, kindsForFeed, renderIcs } from "./ics";

const PAST_DAYS = 60;
/** PAST_DAYS + FUTURE_DAYS must stay within the range schema's 366-day cap. */
const FUTURE_DAYS = 305;

const FEEDS = new Map<string, IcsFeed>([
  ["meals.ics", "meals"],
  ["tasks.ics", "tasks"],
  ["all.ics", "all"],
]);

const PATH = /^\/api\/calendar\/([^/]+)\/([^/]+)\/?$/;

const notFound = () =>
  new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });

interface CalendarFeedDependencies {
  authorizationDb: Database;
  contentDb: Database;
  findUserByToken: typeof findUserByCalendarFeedToken;
  getRange: typeof getCalendarRange;
  now: () => Date;
}

export const createCalendarFeedHandler =
  (dependencies: CalendarFeedDependencies) =>
  async ({ request }: { request: Request }) => {
    const url = new URL(request.url);
    const match = PATH.exec(url.pathname);
    if (!match) return notFound();
    const [, rawToken, rawFeed] = match;

    const feed = rawFeed ? FEEDS.get(rawFeed) : undefined;
    if (!feed || !rawToken) return notFound();

    let token: string;
    try {
      token = decodeURIComponent(rawToken);
    } catch {
      // Malformed percent escapes reach this handler on workerd even though
      // Node's dev HTTP layer rejects them first. Keep that parse difference a
      // 404 instead of leaking a route-shaped 5xx.
      return notFound();
    }

    // A token miss is deliberately indistinguishable from an unknown route;
    // 401 would confirm that a probed bearer-credential URL is otherwise valid.
    const userId = await dependencies.findUserByToken(
      dependencies.authorizationDb,
      token,
    );
    if (!userId) return notFound();

    const now = dependencies.now();
    const startDate = formatPlainDate(addDays(now, -PAST_DAYS));
    const endDateExclusive = formatPlainDate(addDays(now, FUTURE_DAYS));
    const { items } = await dependencies.getRange(dependencies.contentDb, {
      startDate,
      endDateExclusive,
      kinds: [...kindsForFeed(feed)],
    });

    return new Response(renderIcs(items, { feed, now, origin: url.origin }), {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `inline; filename="cubby-${feed}.ics"`,
        // The bearer credential lives in the URL, so a shared cache must never
        // retain the response even though clients may privately reuse it.
        "Cache-Control": "private, max-age=900",
      },
    });
  };
