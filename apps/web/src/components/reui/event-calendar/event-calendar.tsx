"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { addDays, type Locale } from "date-fns";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
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
  stepDate,
  toZoned,
  type EventCalendarDayBucket,
  type EventCalendarIndex,
  type WeekStartsOn,
  zonedStartOfDay,
} from "./event-calendar-lib";
import type {
  CalendarEvent,
  EventCalendarDateRange,
  EventCalendarDragState,
  EventCalendarEventId,
  EventCalendarOccurrence,
  EventCalendarProposedUpdate,
  EventCalendarRangeInfo,
  EventCalendarSegment,
  EventCalendarSlotInfo,
  EventCalendarUpdateResult,
} from "./event-calendar-types";
import { EventCalendarDndProvider } from "./event-calendar-dnd";
import { EventCalendarMonthView } from "./event-calendar-month-view";
import { cn } from "~/lib/utils";

interface EventCalendarActivationConfig {
  moveDistancePx: number;
  touchDelayMs: number;
  touchTolerancePx: number;
  autoScrollEdgePx: number;
  autoScrollMaxStepPx: number;
}

interface EventCalendarCallbacks<TData> {
  onEventClick?: (occurrence: EventCalendarOccurrence<TData>, e: React.MouseEvent) => void;
  onEventDoubleClick?: (occurrence: EventCalendarOccurrence<TData>, e: React.MouseEvent) => void;
  onEventUpdate?: (update: EventCalendarProposedUpdate<TData>) => EventCalendarUpdateResult;
  canDropEvent?: (update: EventCalendarProposedUpdate<TData>) => boolean;
  onDragBlocked?: (occurrence: EventCalendarOccurrence<TData>, info: { gesture: "move"; reason: "readOnly" | "disabled" | "interactions-off" }) => void;
  onSlotClick?: (slot: EventCalendarSlotInfo, e: React.MouseEvent) => void;
  onRangeChange?: (info: EventCalendarRangeInfo) => void;
  onDateChange?: (date: Date) => void;
  onEventsChange?: (events: CalendarEvent<TData>[]) => void;
  onMoreClick?: (day: Date, segments: EventCalendarOccurrence<TData>[], e: React.MouseEvent) => void | false;
}

interface UseEventCalendarStateOptions<TData> extends EventCalendarCallbacks<TData> {
  events?: CalendarEvent<TData>[];
  defaultEvents?: CalendarEvent<TData>[];
  date?: Date;
  defaultDate?: Date;
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
  date: Date;
  visibleRange: EventCalendarDateRange;
  activeRange: EventCalendarDateRange;
  events: CalendarEvent<TData>[];
  loading: boolean;
  drag: EventCalendarDragState<TData> | null;
}

interface EventCalendarApi<TData> {
  next(): void;
  prev(): void;
  today(): void;
  goTo(date: Date): void;
  getEvents(): CalendarEvent<TData>[];
  getEvent(id: EventCalendarEventId): CalendarEvent<TData> | undefined;
  setEvents(events: CalendarEvent<TData>[]): void;
  updateEvent(id: EventCalendarEventId, patch: Partial<CalendarEvent<TData>>): void;
  getOccurrences(range?: EventCalendarDateRange): EventCalendarOccurrence<TData>[];
  getOccurrencesForDay(day: Date): EventCalendarOccurrence<TData>[];
  findOverlapping(candidate: { start: Date; end: Date; excludeEventId?: string }): EventCalendarOccurrence<TData>[];
  getVisibleRange(): EventCalendarDateRange;
  getActiveRange(): EventCalendarDateRange;
  toZoned(date: Date): Date;
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
  api: EventCalendarApi<TData>;
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
    onEventDoubleClick: options.onEventDoubleClick,
    onEventUpdate: options.onEventUpdate,
    canDropEvent: options.canDropEvent,
    onDragBlocked: options.onDragBlocked,
    onSlotClick: options.onSlotClick,
    onRangeChange: options.onRangeChange,
    onDateChange: options.onDateChange,
    onEventsChange: options.onEventsChange,
    onMoreClick: options.onMoreClick,
  };
}

function createEventCalendarStore<TData>(initial: UseEventCalendarStateOptions<TData>) {
  let options = initial;
  let settings = resolveSettings(options);
  let settingsVersion = 0;
  let internal = { date: initial.defaultDate ?? new Date(), events: initial.defaultEvents ?? [], drag: null as EventCalendarDragState<TData> | null };
  let snapshot: EventCalendarState<TData> | null = null;
  let rootEl: HTMLElement | null = null;
  let indexCache: { events: CalendarEvent<TData>[]; rangeKey: string; zone: string; weekStartsOn: WeekStartsOn; order: EventCalendarSettings<TData>["eventOrder"]; value: EventCalendarIndex<TData> } | null = null;
  let lastRangeKey: string | null = null;
  const listeners = new Set<() => void>();
  const invalidate = () => { snapshot = null; };
  const range = (date: Date) => getViewDateRange("month", date, { timeZone: settings.timeZone, weekStartsOn: settings.weekStartsOn, dayCount: 1, agendaDayCount: 1, fixedWeeks: settings.fixedWeeks });
  const state = (): EventCalendarState<TData> => {
    if (snapshot) return snapshot;
    const date = options.date ?? internal.date;
    const ranges = range(date);
    snapshot = { date, ...ranges, events: options.events ?? internal.events, loading: options.loading ?? false, drag: internal.drag };
    return snapshot;
  };
  const emitRange = () => {
    const current = state();
    const key = getRangeKey(current.visibleRange);
    if (key === lastRangeKey) return;
    lastRangeKey = key;
    settings.onRangeChange?.({ range: current.visibleRange, activeRange: current.activeRange, date: current.date, timeZone: settings.timeZone, view: "month" });
  };
  const notify = () => { listeners.forEach((listener) => listener()); emitRange(); };
  const setDate = (date: Date) => { if (options.date === undefined) { internal.date = date; invalidate(); } settings.onDateChange?.(date); if (options.date === undefined) notify(); };
  const setEvents = (events: CalendarEvent<TData>[]) => { if (options.events === undefined) { internal.events = events; invalidate(); } settings.onEventsChange?.(events); if (options.events === undefined) notify(); };
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
  const api: EventCalendarApi<TData> = {
    next: () => setDate(stepDate("month", state().date, 1, { timeZone: settings.timeZone, dayCount: 1, agendaDayCount: 1 })),
    prev: () => setDate(stepDate("month", state().date, -1, { timeZone: settings.timeZone, dayCount: 1, agendaDayCount: 1 })),
    today: () => setDate(new Date()), goTo: setDate,
    getEvents: () => state().events, getEvent: (id) => state().events.find((event) => event.id === id), setEvents,
    updateEvent: (id, patch) => { const event = api.getEvent(id); if (!event) return; const next = { ...event, ...patch }; if ((patch.start || patch.end || patch.allDay !== undefined) && settings.onEventUpdate) applyProposedUpdate({ event: next, occurrence: null, start: next.start, end: next.end, allDay: next.allDay ?? false, source: "api" }); else setEvents(state().events.map((item) => item.id === id ? next : item)); },
    getOccurrences: (range) => range ? buildEventIndex(state().events, range, { timeZone: settings.timeZone, weekStartsOn: settings.weekStartsOn, eventOrder: settings.eventOrder }).occurrences : getIndex().occurrences,
    getOccurrencesForDay: (day) => { const bucket = getIndex().byDay.get(getDayKey(day, settings.timeZone)); return bucket ? [...new Map([...bucket.allDay, ...bucket.timed].map((segment) => [segment.occurrence.key, segment.occurrence])).values()] : []; },
    findOverlapping: ({ start, end, excludeEventId }) => api.getOccurrences({ start, end }).filter((item) => item.eventId !== excludeEventId),
    getVisibleRange: () => state().visibleRange, getActiveRange: () => state().activeRange, toZoned: (date) => toZoned(date, settings.timeZone),
  };
  const internals: EventCalendarInternals<TData> = { getIndex, setDrag: (drag) => { internal.drag = drag; invalidate(); notify(); }, applyProposedUpdate, getSettingsVersion: () => settingsVersion, getRootEl: () => rootEl, setRootEl: (element) => { rootEl = element; } };
  const instance: EventCalendarInstance<TData> = { getState: state, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }, api, get settings() { return settings; }, internals };
  return { instance, setOptions(next: UseEventCalendarStateOptions<TData>) { const prev = options; options = next; const changed = ["events", "date", "loading", "timeZone", "locale", "weekStartsOn", "fixedWeeks", "showOutsideDays", "i18n", "eventOrder", "weekendDays", "activation"].some((key) => prev[key as keyof typeof prev] !== next[key as keyof typeof next]); settings = resolveSettings(next); if (changed) { settingsVersion++; invalidate(); } return changed; }, notify, emitRange };
}

function useEventCalendarState<TData = unknown>(options: UseEventCalendarStateOptions<TData> = {}): EventCalendarInstance<TData> {
  const [store] = useState(() => createEventCalendarStore(options)); const changed = store.setOptions(options); const changedRef = useRef(changed); if (changed) changedRef.current = true;
  useLayoutEffect(() => { if (changedRef.current) { changedRef.current = false; store.notify(); } });
  useEffect(() => { store.emitRange(); }, [store]); return store.instance;
}

const EventCalendarContext = createContext<EventCalendarInstance<any> | null>(null);
function useEventCalendar<TData = unknown>() { const instance = useContext(EventCalendarContext); if (!instance) throw new Error("useEventCalendar must be used within <MonthEventCalendar>"); return instance as EventCalendarInstance<TData>; }
function useEventCalendarSelector<TData = unknown, TSelected = unknown>(selector: (state: EventCalendarState<TData>) => TSelected, options?: { calendar?: EventCalendarInstance<TData>; isEqual?: (a: TSelected, b: TSelected) => boolean }): TSelected { const context = useContext(EventCalendarContext); const instance = options?.calendar ?? context; if (!instance) throw new Error("Calendar context is required"); const last = useRef<TSelected | undefined>(undefined); const equal = options?.isEqual ?? Object.is; return useSyncExternalStore(instance.subscribe, () => { const next = selector(instance.getState() as EventCalendarState<TData>); if (last.current !== undefined && equal(last.current, next)) return last.current; last.current = next; return next; }, () => selector(instance.getState() as EventCalendarState<TData>)); }
const EMPTY_BUCKET: EventCalendarDayBucket = { allDay: [], timed: [] };
const EMPTY_BARS: EventCalendarSegment[] = [];
function useEventCalendarDay<TData = unknown>(day: Date) { const instance = useEventCalendar<TData>(); const key = getDayKey(day, instance.settings.timeZone); const segments = useEventCalendarSelector<TData, EventCalendarDayBucket<TData>>(() => instance.internals.getIndex().byDay.get(key) ?? (EMPTY_BUCKET as EventCalendarDayBucket<TData>), { calendar: instance }); const activeRange = useEventCalendarSelector((state) => state.activeRange); const dayStart = zonedStartOfDay(day, instance.settings.timeZone); return { segments, isToday: getDayKey(new Date(), instance.settings.timeZone) === key, isOutside: dayStart < activeRange.start || dayStart >= activeRange.end }; }
function useEventCalendarWeek<TData = unknown>(day: Date) { const instance = useEventCalendar<TData>(); const zone = instance.settings.timeZone; const dayStart = zonedStartOfDay(day, zone).getTime(); const row = useEventCalendarSelector<TData, { bars: EventCalendarSegment<TData>[]; rowStart: Date | null }>(() => { const found = instance.internals.getIndex().weekRows.find((item) => { const start = zonedStartOfDay(item.rowStart, zone).getTime(); const end = zonedStartOfDay(addDays(toZoned(item.rowStart, zone), 7), zone).getTime(); return dayStart >= start && dayStart < end; }); return { bars: found?.bars ?? (EMPTY_BARS as EventCalendarSegment<TData>[]), rowStart: found?.rowStart ?? null }; }, { calendar: instance, isEqual: (a, b) => (a.rowStart?.getTime() ?? 0) === (b.rowStart?.getTime() ?? 0) && (a.bars === b.bars || (a.bars.length === b.bars.length && a.bars.every((segment, index) => segment === b.bars[index]))) }); return { bars: row.bars, laneCount: row.bars.reduce((max, segment) => Math.max(max, (segment.lane ?? 0) + 1), 0), rowStart: row.rowStart }; }
function useEventCalendarSettings<TData = unknown>() { const instance = useEventCalendar<TData>(); useEventCalendarSelector(() => instance.internals.getSettingsVersion()); return instance.settings; }

interface MonthEventCalendarRenderEventProps<TData = unknown> { occurrence: EventCalendarOccurrence<TData>; segment: EventCalendarSegment<TData>; }
interface MonthEventCalendarProps<TData = unknown> extends Omit<useRender.ComponentProps<"div">, "children" | "defaultValue">, Pick<UseEventCalendarStateOptions<TData>, "events" | "date" | "loading" | "timeZone" | "activation" | "onEventClick" | "onEventUpdate" | "canDropEvent" | "onDragBlocked" | "onSlotClick" | "onMoreClick"> { renderEvent: (props: MonthEventCalendarRenderEventProps<TData>) => ReactNode; onEventsChange: (events: CalendarEvent<TData>[]) => void; }
const MonthEventCalendarRenderContext = createContext<((props: MonthEventCalendarRenderEventProps<any>) => ReactNode) | null>(null);
function useMonthEventCalendarRenderEvent<TData = unknown>() { return useContext(MonthEventCalendarRenderContext) as ((props: MonthEventCalendarRenderEventProps<TData>) => ReactNode) | null; }
function MonthEventCalendar<TData = unknown>({ className, render, events, date, loading, timeZone, activation, onEventClick, onEventUpdate, canDropEvent, onDragBlocked, onSlotClick, onMoreClick, onEventsChange, renderEvent, ...rest }: MonthEventCalendarProps<TData>) { const instance = useEventCalendarState({ events, date, loading, timeZone, activation, fixedWeeks: true, showOutsideDays: true, onEventClick, onEventUpdate, canDropEvent, onDragBlocked, onSlotClick, onMoreClick, onEventsChange }); const root = useCallback((element: HTMLElement | null) => instance.internals.setRootEl(element), [instance]); return <EventCalendarContext.Provider value={instance}><MonthEventCalendarRenderContext.Provider value={renderEvent as any}><EventCalendarDndProvider>{useRender({ defaultTagName: "div", render, props: mergeProps<"div">({ "data-slot": "month-event-calendar", ref: root, className: cn("flex min-h-[620px] min-w-0 flex-col overflow-hidden border text-xs", className), children: <EventCalendarMonthView /> } as useRender.ComponentProps<"div">, rest as useRender.ComponentProps<"div">) })}</EventCalendarDndProvider></MonthEventCalendarRenderContext.Provider></EventCalendarContext.Provider>; }

export type { EventCalendarInstance, MonthEventCalendarRenderEventProps };
export { MonthEventCalendar, useEventCalendar, useEventCalendarDay, useEventCalendarSelector, useEventCalendarSettings, useEventCalendarWeek, useMonthEventCalendarRenderEvent };
