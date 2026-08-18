type EventCalendarEventId = string;
type CalendarPeriod = "month" | "week";

interface EventCalendarDateRange {
  /** Inclusive instant. */
  start: Date;
  /** Exclusive instant. */
  end: Date;
}

/** The month calendar's one renderable item. */
interface CalendarEvent<TData = unknown> {
  id: EventCalendarEventId;
  title: string;
  start: Date;
  /** Exclusive; must be >= start. */
  end: Date;
  /** All-day values must be display-zone midnights. */
  allDay?: boolean;
  color?: string;
  className?: string;
  readOnly?: boolean;
  draggable?: boolean;
  priority?: number;
  data?: TData;
}

interface EventCalendarOccurrence<TData = unknown> {
  /** Stable per instance: `${event.id}::${startISO}`. */
  key: string;
  eventId: EventCalendarEventId;
  event: CalendarEvent<TData>;
  start: Date;
  end: Date;
  allDay: boolean;
}

interface EventCalendarSegment<TData = unknown> {
  occurrence: EventCalendarOccurrence<TData>;
  day: Date;
  isStart: boolean;
  isEnd: boolean;
  continuesBefore: boolean;
  continuesAfter: boolean;
  /** Month lane index. */
  lane?: number;
  rowIndex?: number;
  colStart?: number;
  colSpan?: number;
}

interface EventCalendarDragState<TData = unknown> {
  kind: "move";
  occurrence: EventCalendarOccurrence<TData>;
  proposedStart: Date;
  proposedEnd: Date;
  proposedAllDay: boolean;
  proposedDayGranular: boolean;
  valid: boolean;
}

interface EventCalendarProposedUpdate<TData = unknown> {
  event: CalendarEvent<TData>;
  occurrence: EventCalendarOccurrence<TData> | null;
  start: Date;
  end: Date;
  allDay: boolean;
  source: "drag" | "api";
}

type EventCalendarUpdateResult =
  | boolean
  | void
  | { start?: Date; end?: Date; allDay?: boolean };

interface EventCalendarSlotInfo {
  date: Date;
  allDay: true;
  period: CalendarPeriod;
}

export type {
  CalendarEvent,
  CalendarPeriod,
  EventCalendarDateRange,
  EventCalendarDragState,
  EventCalendarEventId,
  EventCalendarOccurrence,
  EventCalendarProposedUpdate,
  EventCalendarSegment,
  EventCalendarSlotInfo,
  EventCalendarUpdateResult,
};
