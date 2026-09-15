import { addDays } from "date-fns";
import { uniq } from "es-toolkit";

import { formatPlainDate } from "~/lib/plain-date";
import type { Database } from "~/server/db";
import { getCalendarRange } from "~/server/repo/calendar";

import type {
  CalendarRefreshResult,
  StoredCalendarDocument,
} from "./contracts";
import {
  calendarItemCount,
  type IcsFeed,
  kindsForFeed,
  renderIcs,
} from "./ics";

const PAST_DAYS = 60;
/** PAST_DAYS + FUTURE_DAYS stays within the range schema's 366-day cap. */
const FUTURE_DAYS = 305;
// Leave room below Durable Object storage's per-value ceiling for the document
// metadata stored alongside the rendered body.
export const MAX_CALENDAR_DOCUMENT_BYTES = 2 * 1024 * 1024 - 4 * 1024;

export interface CalendarSnapshot extends CalendarRefreshResult {
  documents: Record<IcsFeed, StoredCalendarDocument>;
}

async function etagFor(body: string): Promise<string> {
  const bytes = new TextEncoder().encode(body);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `"${hex}"`;
}

export async function buildCalendarSnapshot(
  db: Database,
  options: { origin: string; now: Date; revision: number },
  getRange: typeof getCalendarRange = getCalendarRange,
): Promise<CalendarSnapshot> {
  const startDate = formatPlainDate(addDays(options.now, -PAST_DAYS));
  const endDateExclusive = formatPlainDate(addDays(options.now, FUTURE_DAYS));
  // One read covers every published feed: the union of what "all" and
  // "garden" each publish, so a feed-specific render below never needs a
  // kind this range read didn't fetch.
  const { items } = await getRange(db, {
    startDate,
    endDateExclusive,
    kinds: uniq([...kindsForFeed("all"), ...kindsForFeed("garden")]),
  });
  const generatedAt = options.now.toISOString();
  const renderDocument = async (
    feed: IcsFeed,
  ): Promise<StoredCalendarDocument> => {
    const body = renderIcs(items, {
      feed,
      now: options.now,
      origin: options.origin,
    });
    const size = new TextEncoder().encode(body).byteLength;
    if (size > MAX_CALENDAR_DOCUMENT_BYTES) {
      throw new Error(
        `Calendar ${feed} snapshot is ${size} bytes; maximum is ${MAX_CALENDAR_DOCUMENT_BYTES}`,
      );
    }
    return {
      body,
      etag: await etagFor(body),
      generatedAt,
      revision: options.revision,
      itemCount: calendarItemCount(items, feed),
    };
  };
  const [meals, tasks, all, garden] = await Promise.all([
    renderDocument("meals"),
    renderDocument("tasks"),
    renderDocument("all"),
    renderDocument("garden"),
  ]);
  const documents = { meals, tasks, all, garden };
  const counts = {
    meals: meals.itemCount,
    tasks: tasks.itemCount,
    all: all.itemCount,
    garden: garden.itemCount,
  };

  return {
    documents,
    generatedAt,
    revision: options.revision,
    counts,
  };
}
