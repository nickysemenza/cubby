import { calendarItemKey, type CalendarItem } from "@cubby/schemas/calendar";
import { differenceInCalendarDays } from "date-fns";
import { Fragment, type ReactNode } from "react";

import { parsePlainDate } from "~/lib/plain-date";
import {
  DisclosureBody,
  DisclosureRoot,
  DisclosureTrigger,
} from "~/ui/layout/disclosure";
import { LONG_BAR_DAYS } from "~/ui/reui/event-calendar/event-calendar-lib";

export const isOngoingItem = (item: CalendarItem) =>
  differenceInCalendarDays(
    parsePlainDate(item.endDateExclusive),
    parsePlainDate(item.startDate),
  ) >= LONG_BAR_DAYS;

/**
 * One day's items with the grid's fold rule: two or more items crossing at
 * least LONG_BAR_DAYS go behind one "N ongoing" disclosure after the day's
 * own events.
 */
export function CalendarDayList({
  items,
  renderItem,
}: {
  items: readonly CalendarItem[];
  renderItem: (item: CalendarItem) => ReactNode;
}) {
  const ongoing = items.filter(isOngoingItem);
  const folded = ongoing.length >= 2;
  const own = folded ? items.filter((item) => !isOngoingItem(item)) : items;
  const row = (item: CalendarItem) => (
    <Fragment key={calendarItemKey(item)}>{renderItem(item)}</Fragment>
  );
  return (
    <div className="flex min-w-0 flex-col">
      {own.map(row)}
      {folded && (
        <DisclosureRoot state={{}} className="mt-1 border-t pt-1">
          <DisclosureTrigger className="min-h-11 w-full px-2 text-xs text-muted-foreground md:min-h-7">
            {ongoing.length} ongoing
          </DisclosureTrigger>
          <DisclosureBody className="flex flex-col">
            {ongoing.map(row)}
          </DisclosureBody>
        </DisclosureRoot>
      )}
    </div>
  );
}
