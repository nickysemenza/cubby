"use client";

import { differenceInCalendarDays, format } from "date-fns";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  useEventCalendar,
  useEventCalendarSelector,
  useEventCalendarSettings,
} from "./event-calendar";
import {
  useEventCalendarDrop,
  wasRecentChipPress,
  wasRecentDrag,
} from "./event-calendar-dnd";
import {
  EVENT_CALENDAR_GHOST,
  EventCalendarDropPlaceholder,
  EventCalendarEvent,
} from "./event-calendar-event";
import {
  captureEventCalendarChipFocus,
  releaseEventCalendarChipFocus,
  restoreEventCalendarChipFocus,
} from "./event-calendar-focus";
import {
  buildWeekLedger,
  getDayKey,
  getRangeKey,
  occupiesFullWeek,
  toZoned,
  zonedStartOfDay,
} from "./event-calendar-lib";
import type {
  EventCalendarDateRange,
  EventCalendarDragState,
  EventCalendarSegment,
} from "./event-calendar-types";
import { cn } from "~/lib/utils";

const LANE_HEIGHT = "1.75rem";

function WeekSpanEvent({ segment }: { segment: EventCalendarSegment }) {
  return (
    <EventCalendarEvent
      segment={segment}
      className="h-full shrink-0"
      onFocus={(event) =>
        captureEventCalendarChipFocus(
          event.currentTarget,
          segment.occurrence.eventId,
        )
      }
      onBlur={(event) => releaseEventCalendarChipFocus(event.currentTarget)}
    />
  );
}

function EventCalendarWeekView() {
  const instance = useEventCalendar();
  const settings = useEventCalendarSettings();
  const events = useEventCalendarSelector((state) => state.events);
  const loading = useEventCalendarSelector((state) => state.loading);
  const visibleRange = useEventCalendarSelector<
    unknown,
    EventCalendarDateRange
  >((state) => state.visibleRange, {
    isEqual: (a, b) => getRangeKey(a) === getRangeKey(b),
  });
  const ledger = useMemo(
    () =>
      buildWeekLedger(
        instance.internals.getIndex(),
        visibleRange.start,
        settings.timeZone,
      ),
    [events, instance, settings.timeZone, visibleRange],
  );
  const laneCount = ledger.spans.reduce(
    (max, segment) => Math.max(max, (segment.lane ?? 0) + 1),
    0,
  );
  const drag = useEventCalendarSelector<unknown, EventCalendarDragState | null>(
    (state) => state.drag,
  );
  const spanGhost = useMemo(() => {
    if (!drag || drag.proposedEnd <= drag.proposedStart) return null;
    const finalCovered = new Date(drag.proposedEnd.getTime() - 1);
    if (
      differenceInCalendarDays(
        toZoned(finalCovered, settings.timeZone),
        toZoned(drag.proposedStart, settings.timeZone),
      ) < 1
    ) {
      return null;
    }
    const startOffset = differenceInCalendarDays(
      toZoned(drag.proposedStart, settings.timeZone),
      toZoned(visibleRange.start, settings.timeZone),
    );
    const endOffset = differenceInCalendarDays(
      toZoned(finalCovered, settings.timeZone),
      toZoned(visibleRange.start, settings.timeZone),
    );
    if (startOffset > 6 || endOffset < 0) return null;
    const colStart = Math.max(0, startOffset);
    const colEnd = Math.min(6, endOffset);
    const segment = {
      occurrence: drag.occurrence,
      day: zonedStartOfDay(drag.proposedStart, settings.timeZone),
      isStart: startOffset >= 0,
      isEnd: endOffset <= 6,
      continuesBefore: startOffset < 0,
      continuesAfter: endOffset > 6,
      colStart,
      colSpan: colEnd - colStart + 1,
      lane: laneCount,
    } satisfies EventCalendarSegment;
    return {
      segment,
      compact: occupiesFullWeek(segment),
      valid: drag.valid,
    };
  }, [drag, laneCount, settings.timeZone, visibleRange.start]);
  const timelineGhost = spanGhost && !spanGhost.compact ? spanGhost : null;
  const compactGhost = spanGhost?.compact ? spanGhost : null;
  const displayLaneCount = laneCount + (timelineGhost ? 1 : 0);
  const spansRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    restoreEventCalendarChipFocus(spansRef.current, [
      ...ledger.compactSpans,
      ...ledger.spans,
    ]);
  });

  return (
    <div
      data-slot="event-calendar-week-view"
      data-view="week"
      data-loading={loading || undefined}
      role="grid"
      aria-label={`Week of ${format(
        toZoned(visibleRange.start, settings.timeZone),
        "MMMM d, yyyy",
        { locale: settings.locale },
      )}`}
      className="min-w-0"
    >
      {(ledger.compactSpans.length > 0 ||
        ledger.spans.length > 0 ||
        spanGhost) && (
        <div
          ref={spansRef}
          data-slot="event-calendar-week-spans"
          className="border-b bg-muted/20 px-1 py-1"
        >
          {(ledger.compactSpans.length > 0 || compactGhost) && (
            <div
              data-slot="event-calendar-week-compact-spans"
              className="grid gap-0.5"
              style={{
                gridTemplateColumns:
                  "repeat(auto-fill, minmax(28rem, 1fr))",
              }}
            >
              {ledger.compactSpans.map((segment) => (
                <div key={segment.occurrence.key} className="h-7 min-w-0">
                  <WeekSpanEvent segment={segment} />
                </div>
              ))}
              {compactGhost && (
                <EventCalendarEvent
                  preview
                  segment={compactGhost.segment}
                  className={cn(
                    "h-7 min-w-0",
                    EVENT_CALENDAR_GHOST.move,
                    !compactGhost.valid && EVENT_CALENDAR_GHOST.invalid,
                  )}
                />
              )}
            </div>
          )}
          {(ledger.spans.length > 0 || timelineGhost) && (
            <div
              data-slot="event-calendar-week-timeline-spans"
              className={cn(
                "relative grid grid-cols-7 gap-y-0.5",
                (ledger.compactSpans.length > 0 || compactGhost) && "mt-0.5",
              )}
              style={{
                gridTemplateRows: `repeat(${displayLaneCount}, ${LANE_HEIGHT})`,
              }}
            >
              {ledger.spans.map((segment) => (
                <div
                  key={segment.occurrence.key}
                  className="min-w-0"
                  style={{
                    gridColumn: `${(segment.colStart ?? 0) + 1} / span ${segment.colSpan ?? 1}`,
                    gridRow: (segment.lane ?? 0) + 1,
                  }}
                >
                  <WeekSpanEvent segment={segment} />
                </div>
              ))}
              {timelineGhost && (
                <div
                  className="min-w-0"
                  style={{
                    gridColumn: `${(timelineGhost.segment.colStart ?? 0) + 1} / span ${timelineGhost.segment.colSpan ?? 1}`,
                    gridRow: displayLaneCount,
                  }}
                >
                  <EventCalendarEvent
                    preview
                    segment={timelineGhost.segment}
                    className={cn(
                      "h-full",
                      EVENT_CALENDAR_GHOST.move,
                      !timelineGhost.valid && EVENT_CALENDAR_GHOST.invalid,
                    )}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-7">
        {ledger.days.map((day, index) => (
          <WeekDayColumn
            key={day.day.toISOString()}
            day={day.day}
            segments={day.segments}
            isLast={index === ledger.days.length - 1}
          />
        ))}
      </div>
    </div>
  );
}

function WeekDayColumn({
  day,
  segments,
  isLast,
}: {
  day: Date;
  segments: EventCalendarSegment[];
  isLast: boolean;
}) {
  const settings = useEventCalendarSettings();
  const dayStart = zonedStartOfDay(day, settings.timeZone);
  const drop = useEventCalendarDrop(dayStart, true);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const registerDay = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node;
      drop.setNodeRef(node);
    },
    [drop.setNodeRef],
  );
  useEffect(() => {
    restoreEventCalendarChipFocus(rootRef.current, segments);
  });
  const isToday =
    format(toZoned(new Date(), settings.timeZone), "yyyy-MM-dd") ===
    format(toZoned(day, settings.timeZone), "yyyy-MM-dd");
  const drag = useEventCalendarSelector<unknown, EventCalendarDragState | null>(
    (state) => state.drag,
  );
  const singleDayDrop = useMemo(() => {
    if (!drag || drag.proposedEnd <= drag.proposedStart) return null;
    const finalCovered = new Date(drag.proposedEnd.getTime() - 1);
    const spansDays =
      differenceInCalendarDays(
        toZoned(finalCovered, settings.timeZone),
        toZoned(drag.proposedStart, settings.timeZone),
      ) > 0;
    if (
      spansDays ||
      getDayKey(drag.proposedStart, settings.timeZone) !==
        getDayKey(day, settings.timeZone)
    ) {
      return null;
    }
    return {
      color: drag.occurrence.event.color,
      valid: drag.valid,
    };
  }, [day, drag, settings.timeZone]);

  return (
    <div
      ref={registerDay}
      role="gridcell"
      data-slot="event-calendar-week-day"
      data-today={isToday || undefined}
      data-drop-target={drop.isOver || undefined}
      data-ec-day={dayStart.getTime()}
      aria-label={format(toZoned(day, settings.timeZone), "EEEE, MMMM d", {
        locale: settings.locale,
      })}
      className={cn(
        "group/week-day min-h-72 min-w-0 px-1 py-2",
        !isLast && "border-e",
        isToday && "bg-primary/3",
      )}
      onClick={(event) => {
        if (wasRecentDrag() || wasRecentChipPress()) return;
        settings.onSlotClick?.(
          { date: day, allDay: true, period: "week" },
          event,
        );
      }}
    >
      <div className="flex flex-col gap-1">
        {singleDayDrop && (
          <EventCalendarDropPlaceholder
            color={singleDayDrop.color}
            valid={singleDayDrop.valid}
            className="h-7"
          />
        )}
        {segments.map((segment) => (
          <EventCalendarEvent
            key={segment.occurrence.key}
            segment={segment}
            className="shrink-0"
            onFocus={(event) =>
              captureEventCalendarChipFocus(
                event.currentTarget,
                segment.occurrence.eventId,
              )
            }
            onBlur={(event) =>
              releaseEventCalendarChipFocus(event.currentTarget)
            }
          />
        ))}
      </div>
    </div>
  );
}

export { EventCalendarWeekView };
