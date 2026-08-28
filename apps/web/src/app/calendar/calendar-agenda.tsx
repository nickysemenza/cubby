import type { CalendarItem } from "@cubby/schemas/calendar";
import { addDays, format, parseISO } from "date-fns";
import { Fragment } from "react";

/**
 * The phone form of the planning calendar.
 *
 * A seven-column month grid at 375px gives each day about 50px of width, which
 * is not a calendar so much as a rumor of one. The agenda trades the shape of
 * the month for legibility: the same items, in date order, as ruled rows —
 * DESIGN.md's "repeated records use bordered or zebra-striped rows", not a
 * stack of padded cards.
 *
 * Built app-side rather than into the month/week event renderers. Every item is
 * a date-only span with no recurrence, so a separate generic agenda engine
 * would earn nothing. Reusing `CalendarItemLink` also means a row can't drift
 * from the one the day drawer draws.
 */

/** Days carry items; empty days collapse into a single line between them. */
type AgendaGroup = { day: string; items: CalendarItem[] };

export const groupItemsByDay = (
  items: readonly CalendarItem[],
  includesDay: (item: CalendarItem, day: string) => boolean,
  range?: { startDate: string; endDateExclusive: string },
  includeEmptyDays = false,
): AgendaGroup[] => {
  const days = new Set<string>();
  if (range && includeEmptyDays) {
    const end = parseISO(range.endDateExclusive);
    for (
      let cursor = parseISO(range.startDate);
      cursor < end;
      cursor = addDays(cursor, 1)
    ) {
      days.add(format(cursor, "yyyy-MM-dd"));
    }
  }
  for (const item of items) {
    // A long-running project can begin years before the month being viewed.
    // The phone agenda is an in-range reading of the current month, not an
    // unbounded chronological history: anchor its first visible row to the
    // first day this item occupies inside the active range.
    if (range) {
      const firstVisible =
        item.startDate < range.startDate ? range.startDate : item.startDate;
      if (
        firstVisible >= range.startDate &&
        firstVisible < range.endDateExclusive &&
        item.endDateExclusive > range.startDate
      ) {
        days.add(firstVisible);
      }
    } else {
      days.add(item.startDate);
    }
  }

  return [...days]
    .sort((a, b) => a.localeCompare(b))
    .map((day) => ({
      day,
      // Not `startDate === day`: a multi-day task or project span belongs to
      // every day it covers, the same rule the month grid paints by.
      items: items.filter((item) => includesDay(item, day)),
    }));
};

export function CalendarAgenda({
  items,
  includesDay,
  range,
  today,
  emptyMessage,
  showAllDays = false,
  onDayClick,
  renderItem,
}: {
  items: readonly CalendarItem[];
  includesDay: (item: CalendarItem, day: string) => boolean;
  /** The currently viewed period. Keeps long-running spans in-range on phone. */
  range?: { startDate: string; endDateExclusive: string };
  today: string;
  emptyMessage: React.ReactNode;
  /** Render the complete period, including empty ruled days. */
  showAllDays?: boolean;
  onDayClick?: (day: string) => void;
  renderItem: (item: CalendarItem) => React.ReactNode;
}) {
  const groups = groupItemsByDay(items, includesDay, range, showAllDays);

  if (groups.length === 0) {
    return <div className="border p-4">{emptyMessage}</div>;
  }

  return (
    // A plain bordered container: the sections are ruled and adjacent, so
    // there is no gap for a layout primitive to own.
    <div data-slot="calendar-agenda" className="border">
      {groups.map((group) => (
        <section key={group.day} data-day={group.day}>
          {/* Sticky so the day you're scrolling through stays named. Mono
              uppercase matches the month view's own weekday header. */}
          <h3 className="sticky top-0 z-10 border-b bg-muted font-mono text-2xs tracking-wider uppercase">
            <button
              type="button"
              className="flex min-h-11 w-full items-center gap-2 px-2 py-1 text-left outline-none hover:bg-muted-foreground/5 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
              onClick={() => onDayClick?.(group.day)}
            >
              <span
                className={group.day === today ? "text-primary" : undefined}
              >
                {group.day === today
                  ? "Today"
                  : format(parseISO(group.day), "EEE MMM d")}
              </span>
              <span className="ml-auto text-slate tabular-nums">
                {group.items.length}
              </span>
            </button>
          </h3>
          <div className="px-2">
            {group.items.length === 0 ? (
              <div className="py-4 text-xs text-muted-foreground">
                Nothing planned.
              </div>
            ) : (
              group.items.map((item) => (
                <Fragment key={`${item.kind}:${item.id}`}>
                  {renderItem(item)}
                </Fragment>
              ))
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
