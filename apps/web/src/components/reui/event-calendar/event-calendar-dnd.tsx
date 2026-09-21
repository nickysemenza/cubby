"use client";

import {
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  useDraggable,
  useDroppable,
} from "@dnd-kit/core";
import { addDays, differenceInCalendarDays } from "date-fns";
import {
  createContext,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createDndAnnouncements,
  cubbyDndScreenReaderInstructions,
} from "~/components/dnd/accessibility";
import { DragPreviewFrame } from "~/components/dnd/DragPreviewFrame";
import { createDndAutoScroller } from "~/components/dnd/auto-scroll";
import {
  createValidTargetKeyboardCoordinates,
  useCubbyDndSensors,
} from "~/components/dnd/sensors";
import {
  type EventCalendarInstance,
  useEventCalendar,
  useEventCalendarSelector,
} from "./event-calendar";
import { toZoned, zonedStartOfDay } from "./event-calendar-lib";
import type {
  EventCalendarProposedUpdate,
  EventCalendarSegment,
} from "./event-calendar-types";

type GestureKind = "move";
export type EventCalendarDragData<T> = {
  calendarGesture: true;
  kind: GestureKind;
  segment: EventCalendarSegment<T>;
};
export type EventCalendarDropData = {
  calendarDrop: true;
  day: Date;
  allDay: boolean;
};

// A zero timestamp treats every click during the first suppression window
// after hydration as a completed gesture. Start outside the window so the
// first blank-day click is never swallowed.
let lastGestureEndedAt = Number.NEGATIVE_INFINITY;
let lastChipPressAt = Number.NEGATIVE_INFINITY;
export const wasRecentDrag = () => performance.now() - lastGestureEndedAt < 250;
export const markChipPress = () => {
  lastChipPressAt = performance.now();
};
export const wasRecentChipPress = () =>
  performance.now() - lastChipPressAt < 300;

/** Preserve feedback for a genuine move attempt on a locked event. */
export function beginBlockedEventCalendarGesture<T>(
  instance: EventCalendarInstance<T>,
  startEvent: PointerEvent,
  segment: EventCalendarSegment<T>,
) {
  const { clientX: startX, clientY: startY, pointerId } = startEvent;
  const event = segment.occurrence.event;
  const reason = event.readOnly
    ? "readOnly"
    : event.draggable === false
      ? "disabled"
      : "interactions-off";
  let activated = false;
  const cleanup = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onRelease);
    window.removeEventListener("pointercancel", onRelease);
    window.removeEventListener("blur", cleanup);
    if (activated) {
      document.body.style.cursor = "";
      document.body.classList.remove("ec-drag-blocked");
      lastGestureEndedAt = performance.now();
    }
  };
  const onMove = (pointerEvent: PointerEvent) => {
    if (pointerEvent.pointerId !== pointerId || activated) return;
    if (
      Math.hypot(pointerEvent.clientX - startX, pointerEvent.clientY - startY) <
      (instance.settings.activation?.moveDistancePx ?? 5)
    ) {
      return;
    }
    activated = true;
    document.body.style.cursor = "not-allowed";
    document.body.classList.add("ec-drag-blocked");
    window.addEventListener("blur", cleanup);
    instance.settings.onDragBlocked?.(segment.occurrence, {
      gesture: "move",
      reason,
    });
  };
  const onRelease = (pointerEvent: PointerEvent) => {
    if (pointerEvent.pointerId === pointerId) cleanup();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onRelease);
  window.addEventListener("pointercancel", onRelease);
}

const isDrag = (value: unknown): value is EventCalendarDragData<unknown> =>
  !!value && typeof value === "object" && "calendarGesture" in value;
const isDrop = (value: unknown): value is EventCalendarDropData =>
  !!value && typeof value === "object" && "calendarDrop" in value;

export function isEventCalendarKeyboardTarget(
  activeData: Record<string, unknown> | undefined,
  targetData: Record<string, unknown> | undefined,
) {
  if (!isDrag(activeData) || !isDrop(targetData)) return false;
  const sourceDay = activeData.segment.day;
  // The grip sits slightly left of its containing cell's center. Without
  // excluding that no-op cell, ArrowRight can choose the source again.
  return !sourceDay || sourceDay.getTime() !== targetData.day.getTime();
}

const calendarKeyboardCoordinates = createValidTargetKeyboardCoordinates(
  isEventCalendarKeyboardTarget,
);

export function proposeEventCalendarDrop<T>(
  data: EventCalendarDragData<T>,
  target: EventCalendarDropData,
  timeZone: string,
): EventCalendarProposedUpdate<T> | null {
  const occurrence = data.segment.occurrence;
  const sourceDay = zonedStartOfDay(
    data.segment?.day ?? occurrence.start,
    timeZone,
  );
  const targetDay = zonedStartOfDay(target.day, timeZone);
  const delta = differenceInCalendarDays(
    toZoned(targetDay, timeZone),
    toZoned(sourceDay, timeZone),
  );
  const duration = occurrence.end.getTime() - occurrence.start.getTime();
  const start = addDays(toZoned(occurrence.start, timeZone), delta);
  const end = new Date(start.getTime() + duration);
  if (start >= end) return null;
  return {
    event: occurrence.event,
    occurrence,
    start,
    end,
    allDay: occurrence.allDay,
    source: "drag",
  };
}

type State<T> = { active: EventCalendarDragData<T> | null; valid: boolean };
const CalendarDndContext = createContext<State<unknown>>({
  active: null,
  valid: true,
});

export function EventCalendarDndProvider<T>({
  children,
}: {
  children: React.ReactNode;
}) {
  const instance = useEventCalendar<T>();
  const { settings } = instance;
  const sensors = useCubbyDndSensors({
    pointerDistance: settings.activation?.moveDistancePx ?? 5,
    touchDelay: settings.activation?.touchDelayMs ?? 250,
    touchTolerance: settings.activation?.touchTolerancePx ?? 5,
    keyboardCoordinates: calendarKeyboardCoordinates,
  });
  // Hydration-stable id; see TableHeaderLayout for why the counter default breaks.
  const describedById = `DndDescribedBy-${useId()}`;
  const [active, setActive] =
    useState<EventCalendarDragData<T> | null>(null);
  const activeRef = useRef(false);
  const scopeKey = useEventCalendarSelector<T, string>(
    (state) =>
      `${state.visibleRange.start.getTime()}:${state.visibleRange.end.getTime()}`,
    { calendar: instance },
  );
  const previousScopeKey = useRef(scopeKey);
  const [valid, setValid] = useState(true);
  const movingRef = useRef<{
    data: EventCalendarDragData<T>;
    target: EventCalendarDropData;
  } | null>(null);
  const apply = useCallback(
    (
      data: EventCalendarDragData<T>,
      target: EventCalendarDropData | null,
    ) => {
      if (!target) return;
      const update = proposeEventCalendarDrop(
        data,
        target,
        settings.timeZone,
      );
      if (!update) return;
      const allowed = settings.canDropEvent?.(update) ?? true;
      setValid(allowed);
      instance.internals.setDrag({
        kind: "move",
        occurrence: update.occurrence!,
        proposedStart: update.start,
        proposedEnd: update.end,
        proposedAllDay: update.allDay,
        proposedDayGranular: target.allDay,
        valid: allowed,
      });
    },
    [instance, settings],
  );
  const autoScroller = useMemo(
    () =>
      createDndAutoScroller({
        axis: "both",
        edgeSize: settings.activation?.autoScrollEdgePx ?? 48,
        maxSpeed: settings.activation?.autoScrollMaxStepPx ?? 15,
        onScroll: () => {
          const moving = movingRef.current;
          if (moving) apply(moving.data, moving.target);
        },
      }),
    [apply, settings.activation],
  );
  useEffect(() => () => autoScroller.stop(), [autoScroller]);
  const onStart = useCallback(({ active: item }: DragStartEvent) => {
    if (isDrag(item.data.current)) {
      activeRef.current = true;
      setValid(true);
      setActive(item.data.current as EventCalendarDragData<T>);
    }
  }, []);
  const onMove = useCallback(
    ({ active: item, over }: DragMoveEvent | DragOverEvent) => {
      if (!isDrag(item.data.current) || !isDrop(over?.data.current)) return;
      const data = item.data.current as EventCalendarDragData<T>;
      const target = over.data.current as EventCalendarDropData;
      movingRef.current = { data, target };
      apply(data, target);
      const rect = item.rect.current.translated ?? item.rect.current.initial;
      if (!rect) return;
      const root = instance.internals.getRootEl();
      autoScroller.update(
        { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        [
          root?.querySelector<HTMLElement>(
            "[data-slot=scroll-area-viewport]",
          ) ?? null,
          document.scrollingElement as HTMLElement | null,
        ],
      );
    },
    [apply, autoScroller, instance],
  );
  const clear = useCallback(() => {
    if (activeRef.current) lastGestureEndedAt = performance.now();
    instance.internals.setDrag(null);
    movingRef.current = null;
    autoScroller.stop();
    activeRef.current = false;
    setActive(null);
  }, [autoScroller, instance]);
  useEffect(() => {
    if (
      previousScopeKey.current !== scopeKey &&
      activeRef.current
    ) {
      clear();
    }
    previousScopeKey.current = scopeKey;
  }, [clear, scopeKey]);
  useEffect(() => () => clear(), [clear]);
  const onEnd = useCallback(
    ({ active: item, over }: DragEndEvent) => {
      const data = item.data.current;
      const target = over?.data.current;
      if (!isDrag(data) || !isDrop(target)) return clear();
      const drag = instance.getState().drag;
      if (drag?.valid)
        instance.internals.applyProposedUpdate({
          event: drag.occurrence.event,
          occurrence: drag.occurrence,
          start: drag.proposedStart,
          end: drag.proposedEnd,
          allDay: drag.proposedAllDay,
          source: "drag",
        });
      clear();
    },
    [clear, instance, settings],
  );
  const state = useMemo(() => ({ active, valid }), [active, valid]);
  return (
    <CalendarDndContext.Provider value={state as State<unknown>}>
      <DndContext
        id={describedById}
        sensors={sensors}
        autoScroll={false}
        onDragStart={onStart}
        onDragMove={onMove}
        onDragOver={onMove}
        onDragEnd={onEnd}
        onDragCancel={clear}
        accessibility={{
          container:
            typeof document === "undefined" ? undefined : document.body,
          screenReaderInstructions: cubbyDndScreenReaderInstructions,
          announcements: createDndAnnouncements({ item: (id) => id }),
        }}
      >
        {children}
        <DragOverlay dropAnimation={null}>
          {active?.segment ? (
            <DragPreviewFrame valid={valid} className="px-2 py-1 text-xs">
              {active.segment.occurrence.event.title}
            </DragPreviewFrame>
          ) : null}
        </DragOverlay>
      </DndContext>
    </CalendarDndContext.Provider>
  );
}

export function useEventCalendarDrag<T>(
  segment: EventCalendarSegment<T>,
  disabled = false,
) {
  return useDraggable({
    id: `calendar:move:${segment.occurrence.key}:${segment.day.getTime()}`,
    data: {
      calendarGesture: true,
      kind: "move",
      segment,
    } satisfies EventCalendarDragData<T>,
    disabled,
  });
}
export function useEventCalendarDrop(
  day: Date,
  allDay: boolean,
) {
  return useDroppable({
    id: `calendar:drop:${day.getTime()}:${allDay}`,
    data: {
      calendarDrop: true,
      day,
      allDay,
    } satisfies EventCalendarDropData,
  });
}
