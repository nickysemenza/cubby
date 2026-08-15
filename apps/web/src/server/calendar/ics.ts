import type { CalendarItem } from "@cubby/schemas/calendar";

/**
 * RFC 5545 serializer for the published calendar feed.
 *
 * Hand-rolled rather than pulling a dependency: every {@link CalendarItem} is
 * already an all-day event, and `endDateExclusive` is already the exclusive end
 * date `DTEND;VALUE=DATE` wants, so the mapping is direct. The fiddly parts are
 * the wire format (CRLF, octet folding, TEXT escaping), which is what most of
 * this file is.
 *
 * Pure: no DB, no ambient clock, no origin constant — `now` and `origin` are
 * caller-supplied. The origin comes from the request rather than APP_ORIGIN so a
 * preview deploy emits links back to *itself* instead of to production.
 */

/** RFC 5545 §3.1: content lines are delimited by CRLF, not LF. */
const CRLF = "\r\n";

/** RFC 5545 §3.1: lines are folded at 75 *octets*, excluding the CRLF. */
const MAX_LINE_OCTETS = 75;

export type IcsFeed = "meals" | "tasks" | "all";

/** Nonempty by construction — `calendarRangeInput.kinds` rejects an empty list,
 * since "no kinds" would silently mean "no events" rather than "everything". */
type FeedKinds = readonly [CalendarItem["kind"], ...CalendarItem["kind"][]];

const FEED_KINDS: Record<IcsFeed, FeedKinds> = {
  meals: ["meal"],
  tasks: ["task"],
  all: ["meal", "task"],
};

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

/** UTC timestamp in the DATE-TIME form DTSTAMP requires. */
const icsTimestamp = (at: Date) =>
  `${at.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;

function detailPath(item: CalendarItem): string {
  // `CalendarItem.id` is a shortcode brand (`mealShortcode` / `taskShortcode`,
  // see packages/schemas/src/calendar.ts), never a uuid — shortcodes are the
  // public id, so these paths are safe by construction.
  const shortcode = item.id;
  return item.kind === "meal" ? `/meals/${shortcode}` : `/tasks/${shortcode}`;
}

function describe(item: CalendarItem): string | null {
  if (item.kind === "meal") {
    const parts = [...item.recipeNames];
    const stats: string[] = [];
    if (item.calories > 0) stats.push(`${Math.round(item.calories)} kcal`);
    if (item.cost > 0) stats.push(`$${item.cost.toFixed(2)}`);
    if (item.nutritionPending) stats.push("nutrition pending");
    if (stats.length > 0) parts.push(stats.join(" · "));
    return parts.length > 0 ? parts.join("\n") : null;
  }
  if (item.kind === "task") {
    const parts = [`Status: ${item.status.replace(/_/g, " ")}`];
    if (item.trade) parts.push(`Trade: ${item.trade}`);
    if (item.projectName) parts.push(`Project: ${item.projectName}`);
    return parts.join("\n");
  }
  return null;
}

function summarize(item: CalendarItem): string {
  if (item.kind === "task" && item.projectName) {
    return `${item.projectName}: ${item.title}`;
  }
  return item.title;
}

/**
 * Whether an item belongs in the feed at all.
 *
 * Only meals and tasks are published today; expenses and projects are dropped
 * here as a second line of defence behind the `kinds` filter on the query.
 * Completed tasks are omitted — a done task on a calendar is noise, and the
 * feed is a plan, not a log.
 */
function isPublishable(item: CalendarItem): boolean {
  if (item.kind === "meal") return true;
  if (item.kind === "task") return item.status !== "done";
  return false;
}

function toEvent(item: CalendarItem, opts: IcsOptions): string[] {
  // UID must be stable across polls so an edit updates the event in place
  // rather than duplicating it. Shortcodes are permanent and never reassigned
  // (not even on merge), which is exactly the guarantee a UID needs.
  const lines = [
    "BEGIN:VEVENT",
    `UID:${item.id}@${new URL(opts.origin).host}`,
    `DTSTAMP:${icsTimestamp(opts.now)}`,
    `DTSTART;VALUE=DATE:${icsDate(item.startDate)}`,
    `DTEND;VALUE=DATE:${icsDate(item.endDateExclusive)}`,
    `SUMMARY:${escapeText(summarize(item))}`,
    `URL:${opts.origin}${detailPath(item)}`,
    "TRANSP:TRANSPARENT",
  ];
  const description = describe(item);
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
  lines.push("END:VEVENT");
  return lines;
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
    if (!isPublishable(item)) continue;
    lines.push(...toEvent(item, opts));
  }

  lines.push("END:VCALENDAR");
  // Trailing CRLF: the document ends with a complete content line.
  return `${lines.map(foldLine).join(CRLF)}${CRLF}`;
}
