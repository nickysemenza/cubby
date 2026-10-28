import { sha256Hex } from "@cubby/shared/sha256";
import { uniq } from "es-toolkit";

import { householdDaysAgo, householdDaysFromNow } from "~/lib/household-date";
import type { Database } from "~/server/db";
import { visitCalendarFeedItems } from "~/server/domains/calendar/repo/calendar";

import type {
  CalendarRefreshResult,
  StoredCalendarDocument,
} from "../repo/contracts";
import { createIcsDocument, type IcsFeed, kindsForFeed } from "./ics";

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
  return `"${await sha256Hex(body)}"`;
}

export async function buildCalendarSnapshot(
  db: Database,
  options: { origin: string; now: Date; revision: number },
  visitItems: typeof visitCalendarFeedItems = visitCalendarFeedItems,
): Promise<CalendarSnapshot> {
  const startDate = householdDaysAgo(PAST_DAYS, options.now);
  const endDateExclusive = householdDaysFromNow(FUTURE_DAYS, options.now);
  const documentOptions = {
    now: options.now,
    origin: options.origin,
    maxBytes: MAX_CALENDAR_DOCUMENT_BYTES,
  };
  const builders = {
    meals: createIcsDocument({ ...documentOptions, feed: "meals" }),
    tasks: createIcsDocument({ ...documentOptions, feed: "tasks" }),
    all: createIcsDocument({ ...documentOptions, feed: "all" }),
    garden: createIcsDocument({ ...documentOptions, feed: "garden" }),
  };
  // One read covers the union of kinds published by every feed.
  await visitItems(
    db,
    {
      startDate,
      endDateExclusive,
      kinds: uniq([...kindsForFeed("all"), ...kindsForFeed("garden")]),
    },
    async (items) => {
      for (const builder of Object.values(builders)) builder.append(items);
    },
  );
  const generatedAt = options.now.toISOString();
  const renderDocument = async (
    feed: IcsFeed,
  ): Promise<StoredCalendarDocument> => {
    const builder = builders[feed];
    const body = builder.finish();
    return {
      body,
      etag: await etagFor(body),
      generatedAt,
      revision: options.revision,
      itemCount: builder.itemCount,
    };
  };
  const meals = await renderDocument("meals");
  const tasks = await renderDocument("tasks");
  const all = await renderDocument("all");
  const garden = await renderDocument("garden");
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
