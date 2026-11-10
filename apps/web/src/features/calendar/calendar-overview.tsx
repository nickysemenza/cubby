import {
  calendarItemKey,
  type CalendarDaySummary,
  type CalendarItem,
} from "@cubby/schemas/calendar";
import { cn } from "cn";
import { addDays, differenceInCalendarDays, format } from "date-fns";
import { useMemo, useRef, useState } from "react";

import { formatCalendarDay } from "~/lib/date-format";
import { HOUSEHOLD_TIMEZONE } from "~/lib/household-date";
import { formatCompactCurrency, formatCurrency } from "~/lib/number-format";
import { formatPlainDate } from "~/lib/plain-date";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "~/ui/primitives/popover";
import {
  buildEventIndex,
  isLongBar,
  packWeekRowLanes,
} from "~/ui/reui/event-calendar/event-calendar-lib";
import type {
  CalendarEvent,
  EventCalendarSegment,
} from "~/ui/reui/event-calendar/event-calendar-types";

import { CalendarDayList } from "./calendar-day-list";
import {
  calendarDayLineClassName,
  CalendarItemPresentation,
} from "./calendar-item-row";
import { calendarOverviewLayout } from "./calendar-overview-layout";
import { useViewportFill } from "./use-viewport-fill";

export function CalendarOverview({
  start,
  end,
  events,
  summaries,
  aligned,
  today,
  selectedDay,
  onDayChange,
  onInspect,
}: {
  start: Date;
  end: Date;
  events: CalendarEvent<CalendarItem>[];
  summaries: Record<string, CalendarDaySummary>;
  aligned: boolean;
  today: string;
  selectedDay?: string;
  onDayChange: (day?: string) => void;
  onInspect: (item: CalendarItem) => void;
}) {
  const [frame, size] = useViewportFill<HTMLDivElement>();
  const buttons = useRef(new Map<string, HTMLElement>());
  const inspecting = useRef(false);
  const [focusedDay, setFocusedDay] = useState<string>();

  const dayCount = differenceInCalendarDays(end, start);
  const headerHeight = aligned ? 20 : 0;
  const layout = calendarOverviewLayout({
    ...size,
    height: size.height - headerHeight,
    dayCount,
    startWeekday: start.getDay(),
    aligned,
  });
  const { columns, rows, offset, lanes } = layout;
  const compactDates = (size.height - headerHeight) / rows < 36;
  const index = useMemo(
    () =>
      buildEventIndex(
        events,
        { start, end },
        { timeZone: HOUSEHOLD_TIMEZONE, weekStartsOn: 0 },
      ),
    [events, start, end],
  );
  const gridStart = useMemo(() => addDays(start, -offset), [start, offset]);
  const rowData = useMemo(
    () =>
      Array.from({ length: rows }, (_, row) => {
        const rowStart = addDays(gridStart, row * columns);
        const days = Array.from({ length: columns }, (_, col) => {
          const date = addDays(rowStart, col);
          return {
            date,
            key: formatPlainDate(date),
            active: date >= start && date < end,
          };
        });
        const segments = days.flatMap(
          ({ key }) => index.byDay.get(key)?.allDay ?? [],
        );
        const packed = packWeekRowLanes(
          segments,
          row,
          rowStart,
          HOUSEHOLD_TIMEZONE,
          columns,
        );
        // The month's fold rule: two or more long bars share lane 0 as one
        // "N ongoing" line, so the days' own events get the remaining lanes.
        const long = packed.filter(isLongBar);
        const ongoing = long.length >= 2 ? long : [];
        const rest = packed.filter((bar) => !ongoing.includes(bar));
        const restLanes = [...new Set(rest.map((bar) => bar.lane ?? 0))].sort(
          (a, b) => a - b,
        );
        return {
          key: formatPlainDate(rowStart),
          days,
          ongoing,
          bars:
            ongoing.length === 0
              ? rest
              : rest.map((bar) => ({
                  ...bar,
                  lane: restLanes.indexOf(bar.lane ?? 0) + 1,
                })),
        };
      }),
    [columns, rows, gridStart, start, end, index],
  );
  const firstDay = formatPlainDate(start);
  const tabDay =
    focusedDay && focusedDay >= firstDay && focusedDay < formatPlainDate(end)
      ? focusedDay
      : today >= firstDay && today < formatPlainDate(end)
        ? today
        : firstDay;

  return (
    <div
      ref={frame}
      className="hidden min-w-0 flex-col overflow-hidden border-t md:flex"
      style={{ height: size.height }}
      data-testid="calendar-overview"
      data-columns={columns}
    >
      {aligned && (
        <div
          className="grid shrink-0"
          style={{
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            height: headerHeight,
          }}
          aria-hidden="true"
        >
          {Array.from({ length: columns }, (_, column) => (
            <span
              key={column}
              className="border-r text-center text-2xs text-muted-foreground"
            >
              {["S", "M", "T", "W", "T", "F", "S"][column % 7]}
            </span>
          ))}
        </div>
      )}
      <div
        className="grid min-h-0 flex-1"
        style={{ gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
        aria-label="Calendar overview"
      >
        {rowData.map(({ key: rowKey, days, bars, ongoing }) => (
          <div
            key={rowKey}
            className="relative grid min-h-0"
            style={{
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            }}
          >
            {days.map(({ date, key, active }, column) => {
              if (!active)
                return (
                  <div key={key} className="border-r border-b bg-muted/30" />
                );
              const itemIds = new Set(summaries[key]?.itemIds ?? []);
              const dayItems = events.flatMap((event) =>
                event.data && itemIds.has(calendarItemKey(event.data))
                  ? [event.data]
                  : [],
              );
              const covers = (bar: EventCalendarSegment<CalendarItem>) =>
                column >= (bar.colStart ?? 0) &&
                column < (bar.colStart ?? 0) + (bar.colSpan ?? 1);
              const hiddenCount =
                bars.filter((bar) => (bar.lane ?? 0) >= lanes && covers(bar))
                  .length + (lanes === 0 ? ongoing.filter(covers).length : 0);
              const spend = summaries[key]?.actualSpend ?? 0;
              const label = formatCalendarDay(date, "weekdayLongMonthDay");
              return (
                <Popover
                  key={key}
                  open={selectedDay === key}
                  onOpenChange={(open) => {
                    if (open) inspecting.current = false;
                    onDayChange(open ? key : undefined);
                  }}
                >
                  <PopoverTrigger
                    ref={(node) => {
                      if (node) buttons.current.set(key, node);
                      else buttons.current.delete(key);
                    }}
                    tabIndex={key === tabDay ? 0 : -1}
                    onFocus={() => setFocusedDay(key)}
                    onKeyDown={(event) => {
                      const delta =
                        event.key === "ArrowRight"
                          ? 1
                          : event.key === "ArrowLeft"
                            ? -1
                            : event.key === "ArrowDown"
                              ? columns
                              : event.key === "ArrowUp"
                                ? -columns
                                : undefined;
                      if (
                        delta === undefined &&
                        event.key !== "Home" &&
                        event.key !== "End"
                      )
                        return;
                      event.preventDefault();
                      const target =
                        event.key === "Home"
                          ? firstDay
                          : event.key === "End"
                            ? formatPlainDate(addDays(end, -1))
                            : formatPlainDate(addDays(date, delta ?? 0));
                      buttons.current.get(target)?.focus();
                    }}
                    aria-label={`${label}, ${dayItems.length} events`}
                    aria-current={key === today ? "date" : undefined}
                    className={cn(
                      "relative min-h-0 min-w-0 overflow-hidden border-r border-b text-left hover:bg-muted/70 focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                      date.getDate() === 1 && "border-l border-l-foreground/40",
                      key === today && "inset-ring-1 inset-ring-primary",
                    )}
                  >
                    <span
                      className={cn(
                        "absolute inset-x-0 top-0 flex items-center justify-between gap-0.5 truncate px-1 py-0.5 text-2xs tabular-nums",
                        key === today && "font-bold",
                      )}
                    >
                      <span className="min-w-0 truncate">
                        {date.getDate() === 1
                          ? format(date, compactDates ? "MMM" : "MMM d")
                          : format(date, "d")}
                      </span>
                      {compactDates && hiddenCount > 0 ? (
                        <span className="shrink-0 text-muted-foreground">
                          +{hiddenCount}
                        </span>
                      ) : spend !== 0 ? (
                        <span className="min-w-0 truncate font-mono text-muted-foreground">
                          <span className="sr-only">Recorded spend </span>
                          {formatCompactCurrency(spend)}
                        </span>
                      ) : (
                        !aligned && (
                          <span className="text-muted-foreground">
                            {format(date, "EEEEE")}
                          </span>
                        )
                      )}
                    </span>
                    {!compactDates && hiddenCount > 0 && (
                      <span className="absolute inset-x-0 bottom-0 truncate px-1 text-2xs text-muted-foreground">
                        +{hiddenCount}
                      </span>
                    )}
                  </PopoverTrigger>
                  {selectedDay === key && (
                    <PopoverContent
                      align="start"
                      className="max-h-[min(28rem,80dvh)] w-96 overflow-y-auto"
                      finalFocus={() =>
                        inspecting.current
                          ? false
                          : (buttons.current.get(key) ?? false)
                      }
                    >
                      <PopoverHeader>
                        <PopoverTitle>{label}</PopoverTitle>
                        <span className="text-xs text-muted-foreground">
                          {dayItems.length
                            ? [
                                `${dayItems.length} events`,
                                spend
                                  ? `${formatCurrency(spend)} recorded`
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")
                            : "No events on this date."}
                        </span>
                      </PopoverHeader>
                      <CalendarDayList
                        items={dayItems}
                        renderItem={(item) => (
                          <button
                            type="button"
                            className={calendarDayLineClassName(item)}
                            onClick={() => {
                              inspecting.current = true;
                              onDayChange(undefined);
                              onInspect(item);
                            }}
                          >
                            <CalendarItemPresentation
                              item={item}
                              variant="month"
                            />
                          </button>
                        )}
                      />
                    </PopoverContent>
                  )}
                </Popover>
              );
            })}
            <div
              className="pointer-events-none absolute inset-x-0 top-5 grid"
              style={{
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                gridAutoRows: 18,
              }}
              aria-hidden="true"
            >
              {ongoing.length > 0 && lanes > 0 && (
                <div
                  className="mx-px flex min-w-0 gap-1 rounded-xs bg-muted px-1 text-2xs leading-4"
                  style={{
                    gridColumn: `${Math.min(...ongoing.map((bar) => bar.colStart ?? 0)) + 1} / ${
                      Math.max(
                        ...ongoing.map(
                          (bar) => (bar.colStart ?? 0) + (bar.colSpan ?? 1),
                        ),
                      ) + 1
                    }`,
                    gridRow: 1,
                  }}
                >
                  <span className="shrink-0 font-medium">
                    {ongoing.length} ongoing
                  </span>
                  <span className="min-w-0 truncate text-muted-foreground">
                    {ongoing
                      .map((bar) => bar.occurrence.event.title)
                      .join(" · ")}
                  </span>
                </div>
              )}
              {bars
                .filter((bar) => (bar.lane ?? 0) < lanes)
                .map((bar) =>
                  (bar.colSpan ?? 1) > 1 ? (
                    <div
                      key={bar.occurrence.key}
                      className="mx-px min-w-0 truncate rounded-xs px-1 text-2xs leading-4 text-foreground"
                      style={{
                        gridColumn: `${(bar.colStart ?? 0) + 1} / span ${bar.colSpan ?? 1}`,
                        gridRow: (bar.lane ?? 0) + 1,
                        backgroundColor: `color-mix(in srgb, ${bar.occurrence.event.color} 18%, transparent)`,
                      }}
                    >
                      {bar.continuesBefore ? "↤ " : ""}
                      {bar.occurrence.event.title}
                      {bar.continuesAfter ? " ↦" : ""}
                    </div>
                  ) : (
                    // A single-day event reads as a ledger line, as in the month.
                    <div
                      key={bar.occurrence.key}
                      className="flex min-w-0 items-center gap-1 px-1 text-2xs leading-4 text-foreground"
                      style={{
                        gridColumn: (bar.colStart ?? 0) + 1,
                        gridRow: (bar.lane ?? 0) + 1,
                      }}
                    >
                      <span
                        className="size-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: bar.occurrence.event.color }}
                      />
                      <span className="min-w-0 truncate">
                        {bar.occurrence.event.title}
                      </span>
                    </div>
                  ),
                )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
