import type { CalendarItem } from "@cubby/schemas/calendar";
import { format, parseISO } from "date-fns";
import { CalendarItemLink } from "./calendar-item-row";

/**
 * The phone form of the planning calendar.
 *
 * A seven-column month grid at 375px gives each day about 50px of width, which
 * is not a calendar so much as a rumor of one. The agenda trades the shape of
 * the month for legibility: the same items, in date order, as ruled rows —
 * DESIGN.md's "repeated records use bordered or zebra-striped rows", not a
 * stack of padded cards.
 *
 * Built app-side rather than on the vendored calendar's agenda view, which
 * does not exist: only the month view was vendored, and every item here is a
 * single all-day span with no recurrence, so the library's segmentation engine
 * would earn nothing. Reusing `CalendarItemLink` also means a row can't drift
 * from the one the month view's day drawer draws.
 */

/** Days carry items; empty days collapse into a single line between them. */
type AgendaGroup = { day: string; items: CalendarItem[] };

export const groupItemsByDay = (
  items: readonly CalendarItem[],
  includesDay: (item: CalendarItem, day: string) => boolean,
): AgendaGroup[] => {
  const days = new Set<string>();
  for (const item of items) days.add(item.startDate);

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
  today,
  emptyMessage,
}: {
  items: readonly CalendarItem[];
  includesDay: (item: CalendarItem, day: string) => boolean;
  today: string;
  emptyMessage: React.ReactNode;
}) {
  const groups = groupItemsByDay(items, includesDay);

  if (groups.length === 0) {
    return <div className="border p-4">{emptyMessage}</div>;
  }

  return (
    // A plain bordered container: the sections are ruled and adjacent, so
    // there is no gap for a layout primitive to own.
    <div className="border">
      {groups.map((group) => (
        <section key={group.day}>
          {/* Sticky so the day you're scrolling through stays named. Mono
              uppercase matches the month view's own weekday header. */}
          <h3 className="sticky top-0 z-10 flex items-baseline gap-2 border-b bg-muted px-2 py-1 font-mono text-2xs uppercase tracking-wider">
            <span className={group.day === today ? "text-primary" : undefined}>
              {group.day === today
                ? "Today"
                : format(parseISO(group.day), "EEE MMM d")}
            </span>
            <span className="ml-auto text-slate tabular-nums">
              {group.items.length}
            </span>
          </h3>
          <div className="px-2">
            {group.items.map((item) => (
              <CalendarItemLink key={`${item.kind}:${item.id}`} item={item} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
