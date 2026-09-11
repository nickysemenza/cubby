import type { CalendarItem } from "@cubby/schemas/calendar";
import {
  MEAL_KIND_LABELS,
  MEAL_SLOT_DURATION_MINUTES,
  MEAL_TYPE_START_MINUTES,
} from "@cubby/schemas/meal-classification";
import { hasKnownEstimate } from "@cubby/schemas/nutrition";
import ICAL from "ical.js";

import { householdDateTime } from "~/lib/household-date";
import { formatEstimate } from "~/lib/nutrition-format";

/**
 * RFC 5545 serializer for the published calendar feed.
 *
 * `ical.js` owns RFC property escaping and component serialization. Cubby keeps
 * the tiny final UTF-8 folding pass because ical.js intentionally does not
 * impose a transport line-length policy.
 *
 * The one exception is a meal with a slot: it is placed at that slot's time of
 * day (see `CalendarKindSpec.timing`). Those events are emitted as UTC
 * DATE-TIMEs rather than `TZID=` plus a VTIMEZONE component — the household
 * timezone is a fixed constant, so resolving the wall time to an instant here
 * is unambiguous and spares the document a hand-written DST ruleset.
 *
 * Pure: no DB, no ambient clock — `now` and `origin` are caller-supplied. The
 * origin comes from the request so a preview deploy links back to *itself*
 * rather than to production. Note that this applies to `URL:` only, never to
 * UIDs — see UID_DOMAIN.
 */

/** RFC 5545 §3.1: content lines are delimited by CRLF, not LF. */
const CRLF = "\r\n";

/** RFC 5545 §3.1: lines are folded at 75 *octets*, excluding the CRLF. */
const MAX_LINE_OCTETS = 75;

/**
 * Fixed UID namespace — deliberately NOT the serving origin.
 *
 * A UID identifies an event for the lifetime of a subscription, so it has to be
 * the same string no matter which host served the feed. Deriving it from the
 * request origin meant subscribing via localhost or a preview deploy and later
 * switching to production changed every UID, and Calendar.app treats a changed
 * UID as a brand-new event — so every meal and task would silently duplicate
 * instead of updating in place.
 */
const UID_DOMAIN = "cubby.nickysemenza.com";

export type IcsFeed = "meals" | "tasks" | "all";

/** Nonempty by construction — `calendarRangeInput.kinds` rejects an empty list,
 * since "no kinds" would silently mean "no events" rather than "everything". */
type FeedKinds = readonly [CalendarItem["kind"], ...CalendarItem["kind"][]];

const FEED_KINDS = {
  meals: ["meal"],
  tasks: ["task"],
  all: ["meal", "task"],
} as const satisfies Record<IcsFeed, FeedKinds>;

type PublishableKind = (typeof FEED_KINDS)[IcsFeed][number];
type PublishableCalendarItem = Extract<CalendarItem, { kind: PublishableKind }>;

const FEED_NAMES = {
  meals: "Cubby Meals",
  tasks: "Cubby Tasks",
  all: "Cubby",
} satisfies Record<IcsFeed, string>;

/** Which calendar kinds a given feed publishes. */
export const kindsForFeed = (feed: IcsFeed): FeedKinds => FEED_KINDS[feed];

/**
 * Fold one content line to {@link MAX_LINE_OCTETS} octets, continuing with a
 * leading space. Counted in UTF-8 octets, not characters, and never split
 * inside a multi-byte sequence — a recipe name with an emoji or an accent would
 * otherwise fold into invalid UTF-8 and take the whole event down with it.
 */
function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= MAX_LINE_OCTETS) return line;

  const out: string[] = [];
  let current = "";
  let currentOctets = 0;
  // A continuation line's leading space counts toward its own 75.
  let limit = MAX_LINE_OCTETS;

  for (const char of line) {
    // for...of keeps surrogate pairs together. Count UTF-8 bytes without
    // allocating a Uint8Array per character in large calendar documents.
    const code = char.charCodeAt(0);
    let size = 3;
    if (code <= 0x7f) size = 1;
    else if (code <= 0x7ff) size = 2;
    else if (char.length === 2) size = 4;
    if (currentOctets + size > limit) {
      out.push(current);
      current = "";
      currentOctets = 0;
      limit = MAX_LINE_OCTETS - 1;
    }
    current += char;
    currentOctets += size;
  }
  if (current) out.push(current);

  return out.join(`${CRLF} `);
}

/** Serialize an ical.js component with Cubby's RFC 5545 UTF-8 wire folding. */
export function serializeCalendarComponent(component: ICAL.Component): string {
  const lines = component
    .toString()
    .replace(/\r?\n[ \t]/g, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter(Boolean);
  return `${lines.map(foldLine).join(CRLF)}${CRLF}`;
}

const icalDateTime = (at: Date) => `${at.toISOString().slice(0, 19)}Z`;

const MILLISECONDS_PER_MINUTE = 60_000;

type ItemOfKind<K extends PublishableKind> = Extract<
  PublishableCalendarItem,
  { kind: K }
>;

/**
 * How one calendar kind becomes an event.
 *
 * The whole per-kind surface lives here, so adding a kind to a feed is this
 * entry plus a `FEED_KINDS` membership — not an edit to five separate `kind ===`
 * branches scattered through the serializer, which is what this replaced.
 *
 * Note what is deliberately NOT here: which date columns an entity contributes,
 * and how they are read. Those stay in repo/calendar.ts, because they do not
 * generalize — a meal has one date, a task a two-column range, and a project's
 * window is derived from its subtree rather than stored at all.
 */
interface CalendarKindSpec<K extends PublishableKind> {
  /**
   * Detail-route prefix; the item's shortcode is appended. Shortcodes are the
   * public id (`CalendarItem.id` is a shortcode brand), so no uuid reaches a URL.
   */
  detailBase: string;
  /**
   * Per-item filter *within* a kind — not feed membership, which `FEED_KINDS`
   * owns. This is where "a done task is noise on a calendar" lives.
   */
  includes: (item: ItemOfKind<K>) => boolean;
  summary: (item: ItemOfKind<K>) => string;
  description: (item: ItemOfKind<K>) => string | null;
  /**
   * Where in the day the item sits, or `null`/absent for a full-day event.
   * Minutes are household-local wall clock; `toEvent` resolves them to an
   * instant. Omit the property entirely for a kind that is never timed.
   */
  timing?: (
    item: ItemOfKind<K>,
  ) => { startMinutes: number; durationMinutes: number } | null;
}

const KIND_SPECS = {
  meal: {
    detailBase: "/meals",
    includes: (_item: ItemOfKind<"meal">) => true,
    summary: (item) => item.title,
    // An unslotted meal has no time of day to claim, so it stays the full-day
    // banner it has always been rather than being parked at an invented hour.
    timing: (item) =>
      item.mealType
        ? {
            startMinutes: MEAL_TYPE_START_MINUTES[item.mealType],
            durationMinutes: MEAL_SLOT_DURATION_MINUTES,
          }
        : null,
    description: (item) => {
      const parts = [...item.recipeNames];
      // An eating-out meal carries no recipes and no cost, so without this it
      // produced an empty DESCRIPTION and the subscriber saw a bare title with
      // no hint of why nothing was planned.
      if (item.mealKind !== "cooked") {
        parts.push(MEAL_KIND_LABELS[item.mealKind]);
      }
      const stats: string[] = [];
      const kcal = item.mealTotals.nutrition.kcal;
      if (hasKnownEstimate(kcal))
        stats.push(
          formatEstimate(kcal, (value) => `${Math.round(value)} kcal`),
        );
      if (hasKnownEstimate(item.mealTotals.cost))
        stats.push(
          formatEstimate(
            item.mealTotals.cost,
            (value) => `$${value.toFixed(2)}`,
          ),
        );
      if (kcal.status === "pending") stats.push("nutrition pending");
      if (stats.length > 0) parts.push(stats.join(" · "));
      return parts.length > 0 ? parts.join("\n") : null;
    },
  },
  task: {
    detailBase: "/tasks",
    // The feed is a plan, not a log.
    includes: (item) => item.status !== "done",
    // No `timing`: a task is due on a day, not at an hour.
    summary: (item) =>
      item.projectName ? `${item.projectName}: ${item.title}` : item.title,
    description: (item) => {
      const parts = [`Status: ${item.status.replace(/_/g, " ")}`];
      if (item.trade) parts.push(`Trade: ${item.trade}`);
      if (item.projectName) parts.push(`Project: ${item.projectName}`);
      return parts.join("\n");
    },
  },
} satisfies {
  [K in PublishableKind]: CalendarKindSpec<K>;
};

/** Whether this feed publishes the item: kind membership, then the kind's own filter. */
function isPublishable(
  item: CalendarItem,
  feed: IcsFeed,
): item is PublishableCalendarItem {
  const kinds: readonly CalendarItem["kind"][] = FEED_KINDS[feed];
  if (!kinds.includes(item.kind)) return false;
  if (item.kind === "meal") return KIND_SPECS.meal.includes(item);
  if (item.kind === "task") return KIND_SPECS.task.includes(item);
  return false;
}

export function calendarItemCount(
  items: CalendarItem[],
  feed: IcsFeed,
): number {
  return items.filter((item) => isPublishable(item, feed)).length;
}

/**
 * DTSTART/DTEND for one item — DATE-valued for a full-day event, UTC DATE-TIME
 * for a timed one.
 *
 * A timed event ignores `endDateExclusive` entirely: its end is its own
 * duration past its start, not the day after it.
 */
function addBoundaries<K extends PublishableKind>(
  event: ICAL.Component,
  item: ItemOfKind<K>,
  spec: CalendarKindSpec<K>,
): void {
  const timing = spec.timing?.(item) ?? null;
  if (!timing) {
    event.addPropertyWithValue(
      "dtstart",
      ICAL.Time.fromDateString(item.startDate),
    );
    event.addPropertyWithValue(
      "dtend",
      ICAL.Time.fromDateString(item.endDateExclusive),
    );
    return;
  }
  const start = householdDateTime(item.startDate, timing.startMinutes);
  const end = new Date(
    start.getTime() + timing.durationMinutes * MILLISECONDS_PER_MINUTE,
  );
  event.addPropertyWithValue("dtstart", icalDateTime(start));
  event.addPropertyWithValue("dtend", icalDateTime(end));
}

function toEventFor<K extends PublishableKind>(
  item: ItemOfKind<K>,
  spec: CalendarKindSpec<K>,
  opts: IcsOptions,
): ICAL.Component {
  // UID must be stable across polls so an edit updates the event in place
  // rather than duplicating it. Shortcodes are permanent and never reassigned
  // (not even on merge), which is exactly the guarantee a UID needs.
  const event = new ICAL.Component("vevent");
  event.addPropertyWithValue("uid", `${item.id}@${UID_DOMAIN}`);
  event.addPropertyWithValue("dtstamp", icalDateTime(opts.now));
  addBoundaries(event, item, spec);
  event.addPropertyWithValue("summary", spec.summary(item));
  event.addPropertyWithValue(
    "url",
    `${opts.origin}${spec.detailBase}/${item.id}`,
  );
  event.addPropertyWithValue("transp", "TRANSPARENT");
  const description = spec.description(item);
  if (description) event.addPropertyWithValue("description", description);
  return event;
}

function toEvent(
  item: PublishableCalendarItem,
  opts: IcsOptions,
): ICAL.Component {
  return item.kind === "meal"
    ? toEventFor(item, KIND_SPECS.meal, opts)
    : toEventFor(item, KIND_SPECS.task, opts);
}

/**
 * Render `items` as an iCalendar document.
 *
 * Tasks are emitted as VEVENTs, not VTODOs. That looks wrong on paper, but
 * Calendar.app does not reliably surface VTODOs from a *subscribed* calendar
 * and never routes them to Reminders, so a VTODO feed renders as an empty
 * calendar. Don't "fix" this without testing against the real client.
 */
export interface IcsOptions {
  feed: IcsFeed;
  now: Date;
  /** Absolute origin this feed is served from, e.g. `https://cubby.example.com`. */
  origin: string;
}

export function renderIcs(items: CalendarItem[], opts: IcsOptions): string {
  const calendar = new ICAL.Component("vcalendar");
  calendar.addPropertyWithValue("version", "2.0");
  calendar.addPropertyWithValue("prodid", "-//Cubby//Calendar Feed//EN");
  calendar.addPropertyWithValue("calscale", "GREGORIAN");
  calendar.addPropertyWithValue("method", "PUBLISH");
  calendar.addPropertyWithValue("x-wr-calname", FEED_NAMES[opts.feed]);
  const properties = [
    // Both spellings: REFRESH-INTERVAL is the RFC 7986 property, X-PUBLISHED-TTL
    // is what Apple and Outlook actually read.
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const property of properties)
    calendar.addProperty(ICAL.Property.fromString(property));

  for (const item of items) {
    if (!isPublishable(item, opts.feed)) continue;
    calendar.addSubcomponent(toEvent(item, opts));
  }
  return serializeCalendarComponent(calendar);
}
