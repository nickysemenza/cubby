"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { addDays, type Locale } from "date-fns";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type EventCalendarI18nConfig,
  type EventCalendarI18nOverrides,
  mergeEventCalendarI18n,
} from "./event-calendar-i18n";
import {
  buildEventIndex,
  defaultEventOrder,
  getDayKey,
  getRangeKey,
  getViewDateRange,
  toZoned,
  type EventCalendarDayBucket,
  type EventCalendarIndex,
  type WeekStartsOn,
  zonedStartOfDay,
} from "./event-calendar-lib";
import type {
  CalendarEvent,
  CalendarPeriod,
  EventCalendarDateRange,
  EventCalendarDragState,
  EventCalendarOccurrence,
  EventCalendarProposedUpdate,
  EventCalendarSegment,
  EventCalendarSlotInfo,
  EventCalendarUpdateResult,
} from "./event-calendar-types";
import { EventCalendarDndProvider } from "./event-calendar-dnd";
import { EventCalendarMonthView } from "./event-calendar-month-view";
import { EventCalendarWeekView } from "./event-calendar-week-view";
import { cn } from "~/lib/utils";

interface EventCalendarActivationConfig {
  moveDistancePx: number;
  touchDelayMs: number;
  touchTolerancePx: number;
  autoScrollEdgePx: number;
  autoScrollMaxStepPx: number;
}

interface EventCalendarCallbacks<TData> {
  onEventClick?: (occurrence: EventCalendarOccurrence<TData>, segment: EventCalendarSegment<TData>, e: React.MouseEvent) => void;
  onEventUpdate?: (update: EventCalendarProposedUpdate<TData>) => EventCalendarUpdateResult;
  canDropEvent?: (update: EventCalendarProposedUpdate<TData>) => boolean;
  onDragBlocked?: (occurrence: EventCalendarOccurrence<TData>, info: { gesture: "move"; reason: "readOnly" | "disabled" | "interactions-off" }) => void;
  onSlotClick?: (slot: EventCalendarSlotInfo, e: React.MouseEvent) => void;
  onEventsChange?: (events: CalendarEvent<TData>[]) => void;
  onMoreClick?: (day: Date, segments: EventCalendarOccurrence<TData>[], e: React.MouseEvent) => void | false;
}

interface UseEventCalendarStateOptions<TData> extends EventCalendarCallbacks<TData> {
  period: CalendarPeriod;
  events: CalendarEvent<TData>[];
  date: Date;
  loading?: boolean;
  timeZone?: string;
  locale?: Locale;
  weekStartsOn?: WeekStartsOn;
  fixedWeeks?: boolean;
  showOutsideDays?: boolean;
  i18n?: EventCalendarI18nOverrides;
  getEventPriority?: (event: CalendarEvent<TData>) => number;
  eventOrder?: (a: EventCalendarOccurrence<TData>, b: EventCalendarOccurrence<TData>) => number;
  weekendDays?: number[];
  activation?: Partial<EventCalendarActivationConfig>;
}

interface EventCalendarSettings<TData> extends EventCalendarCallbacks<TData> {
  timeZone: string;
  locale?: Locale;
  weekStartsOn: WeekStartsOn;
  fixedWeeks: boolean;
  showOutsideDays: boolean;
  i18n: EventCalendarI18nConfig;
  weekendDays: number[];
  activation?: Partial<EventCalendarActivationConfig>;
  eventOrder: (a: EventCalendarOccurrence<TData>, b: EventCalendarOccurrence<TData>) => number;
}

interface EventCalendarState<TData> {
  period: CalendarPeriod;
  date: Date;
  visibleRange: EventCalendarDateRange;
  activeRange: EventCalendarDateRange;
  events: CalendarEvent<TData>[];
  loading: boolean;
  drag: EventCalendarDragState<TData> | null;
}

interface EventCalendarInternals<TData> {
  getIndex(): EventCalendarIndex<TData>;
  setDrag(drag: EventCalendarDragState<TData> | null): void;
  applyProposedUpdate(update: EventCalendarProposedUpdate<TData>): boolean;
  getSettingsVersion(): number;
  getRootEl(): HTMLElement | null;
  setRootEl(el: HTMLElement | null): void;
}

interface EventCalendarInstance<TData> {
  getState(): EventCalendarState<TData>;
  subscribe(listener: () => void): () => void;
  settings: EventCalendarSettings<TData>;
  internals: EventCalendarInternals<TData>;
}

const DEFAULT_WEEKEND_DAYS = [0, 6];
const priorityOrderCache = new WeakMap<object, unknown>();
function priorityEventOrder<TData>(priority: (event: CalendarEvent<TData>) => number) {
  const cached = priorityOrderCache.get(priority);
  if (cached) return cached as EventCalendarSettings<TData>["eventOrder"];
  const order = (a: EventCalendarOccurrence<TData>, b: EventCalendarOccurrence<TData>) =>
    priority(b.event) - priority(a.event) || defaultEventOrder(a, b);
  priorityOrderCache.set(priority, order);
  return order;
}
function resolveSettings<TData>(options: UseEventCalendarStateOptions<TData>): EventCalendarSettings<TData> {
  const priority = options.getEventPriority ?? ((event: CalendarEvent<TData>) => event.priority ?? 0);
  return {
    timeZone: options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: options.locale,
    weekStartsOn: options.weekStartsOn ?? options.locale?.options?.weekStartsOn ?? 0,
    fixedWeeks: options.fixedWeeks ?? true,
    showOutsideDays: options.showOutsideDays ?? true,
    i18n: mergeEventCalendarI18n(options.i18n),
    weekendDays: options.weekendDays ?? DEFAULT_WEEKEND_DAYS,
    activation: options.activation,
    eventOrder: options.eventOrder ?? priorityEventOrder(priority),
    onEventClick: options.onEventClick,
    onEventUpdate: options.onEventUpdate,
    canDropEvent: options.canDropEvent,
    onDragBlocked: options.onDragBlocked,
    onSlotClick: options.onSlotClick,
    onEventsChange: options.onEventsChange,
    onMoreClick: options.onMoreClick,
  };
}

function createEventCalendarStore<TData>(initial: UseEventCalendarStateOptions<TData>) {
  let options = initial;
  let settings = resolveSettings(options);
  let settingsVersion = 0;
  const internal = { drag: null as EventCalendarDragState<TData> | null };
  let snapshot: EventCalendarState<TData> | null = null;
  let rootEl: HTMLElement | null = null;
  let indexCache: { events: CalendarEvent<TData>[]; rangeKey: string; zone: string; weekStartsOn: WeekStartsOn; order: EventCalendarSettings<TData>["eventOrder"]; value: EventCalendarIndex<TData> } | null = null;
  const listeners = new Set<() => void>();
  const invalidate = () => { snapshot = null; };
  const range = (period: CalendarPeriod, date: Date) => getViewDateRange(period, date, { timeZone: settings.timeZone, weekStartsOn: settings.weekStartsOn, fixedWeeks: settings.fixedWeeks });
  const state = (): EventCalendarState<TData> => {
    if (snapshot) return snapshot;
    const period = options.period;
    const date = options.date;
    const ranges = range(period, date);
    snapshot = { period, date, ...ranges, events: options.events, loading: options.loading ?? false, drag: internal.drag };
    return snapshot;
  };
  const notify = () => { listeners.forEach((listener) => listener()); };
  const setEvents = (events: CalendarEvent<TData>[]) => { settings.onEventsChange?.(events); };
  const getIndex = () => {
    const current = state(); const rangeKey = getRangeKey(current.visibleRange);
    if (indexCache && indexCache.events === current.events && indexCache.rangeKey === rangeKey && indexCache.zone === settings.timeZone && indexCache.weekStartsOn === settings.weekStartsOn && indexCache.order === settings.eventOrder) return indexCache.value;
    const value = buildEventIndex(current.events, current.visibleRange, { timeZone: settings.timeZone, weekStartsOn: settings.weekStartsOn, eventOrder: settings.eventOrder });
    indexCache = { events: current.events, rangeKey, zone: settings.timeZone, weekStartsOn: settings.weekStartsOn, order: settings.eventOrder, value };
    return value;
  };
  const applyProposedUpdate = (update: EventCalendarProposedUpdate<TData>) => {
    const result = settings.onEventUpdate?.(update); if (result === false) return false;
    const adjusted = result && typeof result === "object" ? result : update;
    setEvents(state().events.map((event) => event.id === update.event.id ? { ...event, start: adjusted.start ?? update.start, end: adjusted.end ?? update.end, allDay: adjusted.allDay ?? update.allDay } : event));
    return true;
  };
  const internals: EventCalendarInternals<TData> = { getIndex, setDrag: (drag) => { internal.drag = drag; invalidate(); notify(); }, applyProposedUpdate, getSettingsVersion: () => settingsVersion, getRootEl: () => rootEl, setRootEl: (element) => { rootEl = element; } };
  const instance: EventCalendarInstance<TData> = { getState: state, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }, get settings() { return settings; }, internals };
  return { instance, setOptions(next: UseEventCalendarStateOptions<TData>) { const prev = options; options = next; const changed = ["period", "events", "date", "loading", "timeZone", "locale", "weekStartsOn", "fixedWeeks", "showOutsideDays", "i18n", "eventOrder", "weekendDays", "activation"].some((key) => prev[key as keyof typeof prev] !== next[key as keyof typeof next]); settings = resolveSettings(next); if (changed) { settingsVersion++; invalidate(); } return changed; }, notify };
}

function useEventCalendarState<TData = unknown>(options: UseEventCalendarStateOptions<TData>): EventCalendarInstance<TData> {
  const [store] = useState(() => createEventCalendarStore(options)); const changed = store.setOptions(options); const changedRef = useRef(changed); if (changed) changedRef.current = true;
  useLayoutEffect(() => { if (changedRef.current) { changedRef.current = false; store.notify(); } });
  return store.instance;
}

const EventCalendarContext = createContext<EventCalendarInstance<any> | null>(null);
function useEventCalendar<TData = unknown>() { const instance = useContext(EventCalendarContext); if (!instance) throw new Error("useEventCalendar must be used within an event calendar"); return instance as EventCalendarInstance<TData>; }
function useEventCalendarSelector<TData = unknown, TSelected = unknown>(selector: (state: EventCalendarState<TData>) => TSelected, options?: { calendar?: EventCalendarInstance<TData>; isEqual?: (a: TSelected, b: TSelected) => boolean }): TSelected { const context = useContext(EventCalendarContext); const instance = options?.calendar ?? context; if (!instance) throw new Error("Calendar context is required"); const last = useRef<TSelected | undefined>(undefined); const equal = options?.isEqual ?? Object.is; return useSyncExternalStore(instance.subscribe, () => { const next = selector(instance.getState() as EventCalendarState<TData>); if (last.current !== undefined && equal(last.current, next)) return last.current; last.current = next; return next; }, () => selector(instance.getState() as EventCalendarState<TData>)); }
const EMPTY_BUCKET: EventCalendarDayBucket = { allDay: [], timed: [] };
const EMPTY_BARS: EventCalendarSegment[] = [];
function useEventCalendarDay<TData = unknown>(day: Date) { const instance = useEventCalendar<TData>(); const key = getDayKey(day, instance.settings.timeZone); const segments = useEventCalendarSelector<TData, EventCalendarDayBucket<TData>>(() => instance.internals.getIndex().byDay.get(key) ?? (EMPTY_BUCKET as EventCalendarDayBucket<TData>), { calendar: instance }); const activeRange = useEventCalendarSelector((state) => state.activeRange); const dayStart = zonedStartOfDay(day, instance.settings.timeZone); return { segments, isToday: getDayKey(new Date(), instance.settings.timeZone) === key, isOutside: dayStart < activeRange.start || dayStart >= activeRange.end }; }
function useEventCalendarWeek<TData = unknown>(day: Date) { const instance = useEventCalendar<TData>(); const zone = instance.settings.timeZone; const dayStart = zonedStartOfDay(day, zone).getTime(); const row = useEventCalendarSelector<TData, { bars: EventCalendarSegment<TData>[]; rowStart: Date | null }>(() => { const found = instance.internals.getIndex().weekRows.find((item) => { const start = zonedStartOfDay(item.rowStart, zone).getTime(); const end = zonedStartOfDay(addDays(toZoned(item.rowStart, zone), 7), zone).getTime(); return dayStart >= start && dayStart < end; }); return { bars: found?.bars ?? (EMPTY_BARS as EventCalendarSegment<TData>[]), rowStart: found?.rowStart ?? null }; }, { calendar: instance, isEqual: (a, b) => (a.rowStart?.getTime() ?? 0) === (b.rowStart?.getTime() ?? 0) && (a.bars === b.bars || (a.bars.length === b.bars.length && a.bars.every((segment, index) => segment === b.bars[index]))) }); return { bars: row.bars, laneCount: row.bars.reduce((max, segment) => Math.max(max, (segment.lane ?? 0) + 1), 0), rowStart: row.rowStart }; }
function useEventCalendarSettings<TData = unknown>() { const instance = useEventCalendar<TData>(); useEventCalendarSelector(() => instance.internals.getSettingsVersion()); return instance.settings; }

interface EventCalendarRenderEventProps<TData = unknown> {
  occurrence: EventCalendarOccurrence<TData>;
  segment: EventCalendarSegment<TData>;
}

interface EventCalendarRootProps<TData = unknown>
  extends Omit<
      useRender.ComponentProps<"div">,
      "children" | "defaultValue"
    >,
    Pick<
      UseEventCalendarStateOptions<TData>,
      | "events"
      | "date"
      | "loading"
      | "timeZone"
      | "activation"
      | "onEventClick"
      | "onEventUpdate"
      | "canDropEvent"
      | "onDragBlocked"
      | "onSlotClick"
      | "onMoreClick"
    > {
  period: CalendarPeriod;
  renderEvent: (props: EventCalendarRenderEventProps<TData>) => ReactNode;
  onEventsChange: (events: CalendarEvent<TData>[]) => void;
  children: ReactNode;
  slot: "month-event-calendar" | "week-event-calendar";
}

type MonthEventCalendarProps<TData = unknown> = Omit<
  EventCalendarRootProps<TData>,
  "children" | "period" | "slot"
>;

type WeekEventCalendarProps<TData = unknown> = Omit<
  MonthEventCalendarProps<TData>,
  "onMoreClick"
>;

const EventCalendarRenderContext = createContext<
  ((props: EventCalendarRenderEventProps<any>) => ReactNode) | null
>(null);

function useEventCalendarRenderEvent<TData = unknown>() {
  return useContext(EventCalendarRenderContext) as
    | ((props: EventCalendarRenderEventProps<TData>) => ReactNode)
    | null;
}

function EventCalendarRoot<TData = unknown>({
  period,
  slot,
  className,
  render,
  events,
  date,
  loading,
  timeZone,
  activation,
  onEventClick,
  onEventUpdate,
  canDropEvent,
  onDragBlocked,
  onSlotClick,
  onMoreClick,
  onEventsChange,
  renderEvent,
  children,
  ...rest
}: EventCalendarRootProps<TData>) {
  const instance = useEventCalendarState({
    period,
    events,
    date,
    loading,
    timeZone,
    activation,
    fixedWeeks: period === "month",
    showOutsideDays: period === "month",
    onEventClick,
    onEventUpdate,
    canDropEvent,
    onDragBlocked,
    onSlotClick,
    onMoreClick,
    onEventsChange,
  });
  const root = useCallback(
    (element: HTMLElement | null) => instance.internals.setRootEl(element),
    [instance],
  );

  return (
    <EventCalendarContext.Provider value={instance}>
      <EventCalendarRenderContext.Provider value={renderEvent as any}>
        <EventCalendarDndProvider>
          {useRender({
            defaultTagName: "div",
            render,
            props: mergeProps<"div">(
              {
                "data-slot": slot,
                ref: root,
                className: cn(
                  "min-w-0 overflow-hidden border text-xs",
                  period === "month" && "flex min-h-[620px] flex-col",
                  className,
                ),
                children,
              } as useRender.ComponentProps<"div">,
              rest as useRender.ComponentProps<"div">,
            ),
          })}
        </EventCalendarDndProvider>
      </EventCalendarRenderContext.Provider>
    </EventCalendarContext.Provider>
  );
}

function MonthEventCalendar<TData = unknown>(
  props: MonthEventCalendarProps<TData>,
) {
  return (
    <EventCalendarRoot {...props} period="month" slot="month-event-calendar">
      <EventCalendarMonthView />
    </EventCalendarRoot>
  );
}

function WeekEventCalendar<TData = unknown>(
  props: WeekEventCalendarProps<TData>,
) {
  return (
    <EventCalendarRoot {...props} period="week" slot="week-event-calendar">
      <EventCalendarWeekView />
    </EventCalendarRoot>
  );
}

export type { EventCalendarInstance, EventCalendarRenderEventProps };
export {
  MonthEventCalendar,
  useEventCalendar,
  useEventCalendarDay,
  useEventCalendarRenderEvent,
  useEventCalendarSelector,
  useEventCalendarSettings,
  useEventCalendarWeek,
  WeekEventCalendar,
};
