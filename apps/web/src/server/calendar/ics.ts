import type { CalendarItem } from "@cubby/schemas/calendar";
import {
  MEAL_KIND_LABELS,
  MEAL_SLOT_DURATION_MINUTES,
  MEAL_TYPE_START_MINUTES,
} from "@cubby/schemas/meal-classification";
import { householdDateTime } from "~/lib/household-date";

/**
 * RFC 5545 serializer for the published calendar feed.
 *
 * Hand-rolled rather than pulling a dependency: most of a {@link CalendarItem}
 * is an all-day event, and `endDateExclusive` is already the exclusive end date
 * `DTEND;VALUE=DATE` wants, so the mapping is direct. The fiddly parts are the
 * wire format (CRLF, octet folding, TEXT escaping), which is what most of this
 * file is.
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

const FEED_NAMES: Record<IcsFeed, string> = {
  meals: "Cubby Meals",
  tasks: "Cubby Tasks",
  all: "Cubby",
};

/** Which calendar kinds a given feed publishes. */
export const kindsForFeed = (feed: IcsFeed): FeedKinds => FEED_KINDS[feed];

/**
 * Escape a TEXT value per RFC 5545 §3.3.11. Order matters: the backslash rule
 * must run first, or it would double-escape the separators added after it.
 */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

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
    const size = encoder.encode(char).length;
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

/** `YYYY-MM-DD` → `YYYYMMDD`, the DATE value form. */
const icsDate = (plain: string) => plain.replace(/-/g, "");

/** UTC timestamp in the DATE-TIME form DTSTAMP and a timed DTSTART require. */
const icsTimestamp = (at: Date) =>
  `${at.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;

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

const KIND_SPECS: {
  [K in PublishableKind]: CalendarKindSpec<K>;
} = {
  meal: {
    detailBase: "/meals",
    includes: () => true,
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
      if (item.calories > 0) stats.push(`${Math.round(item.calories)} kcal`);
      if (item.cost > 0) stats.push(`$${item.cost.toFixed(2)}`);
      if (item.nutritionPending) stats.push("nutrition pending");
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

/**
 * DTSTART/DTEND for one item — DATE-valued for a full-day event, UTC DATE-TIME
 * for a timed one.
 *
 * A timed event ignores `endDateExclusive` entirely: its end is its own
 * duration past its start, not the day after it.
 */
function boundaryLines<K extends PublishableKind>(
  item: ItemOfKind<K>,
  spec: CalendarKindSpec<K>,
): string[] {
  const timing = spec.timing?.(item) ?? null;
  if (!timing) {
    return [
      `DTSTART;VALUE=DATE:${icsDate(item.startDate)}`,
      `DTEND;VALUE=DATE:${icsDate(item.endDateExclusive)}`,
    ];
  }
  const start = householdDateTime(item.startDate, timing.startMinutes);
  const end = new Date(
    start.getTime() + timing.durationMinutes * MILLISECONDS_PER_MINUTE,
  );
  return [`DTSTART:${icsTimestamp(start)}`, `DTEND:${icsTimestamp(end)}`];
}

function toEventFor<K extends PublishableKind>(
  item: ItemOfKind<K>,
  spec: CalendarKindSpec<K>,
  opts: IcsOptions,
): string[] {
  // UID must be stable across polls so an edit updates the event in place
  // rather than duplicating it. Shortcodes are permanent and never reassigned
  // (not even on merge), which is exactly the guarantee a UID needs.
  const lines = [
    "BEGIN:VEVENT",
    `UID:${item.id}@${UID_DOMAIN}`,
    `DTSTAMP:${icsTimestamp(opts.now)}`,
    ...boundaryLines(item, spec),
    `SUMMARY:${escapeText(spec.summary(item))}`,
    `URL:${opts.origin}${spec.detailBase}/${item.id}`,
    "TRANSP:TRANSPARENT",
  ];
  const description = spec.description(item);
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
  lines.push("END:VEVENT");
  return lines;
}

function toEvent(item: PublishableCalendarItem, opts: IcsOptions): string[] {
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
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Cubby//Calendar Feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(FEED_NAMES[opts.feed])}`,
    // Both spellings: REFRESH-INTERVAL is the RFC 7986 property, X-PUBLISHED-TTL
    // is what Apple and Outlook actually read.
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];

  for (const item of items) {
    if (!isPublishable(item, opts.feed)) continue;
    lines.push(...toEvent(item, opts));
  }

  lines.push("END:VCALENDAR");
  // Trailing CRLF: the document ends with a complete content line.
  return `${lines.map(foldLine).join(CRLF)}${CRLF}`;
}
