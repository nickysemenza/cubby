"use client";

import {
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  useDraggable,
  useDroppable,
} from "@dnd-kit/core";
import { addDays, differenceInCalendarDays } from "date-fns";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
import { useCubbyDndSensors } from "~/components/dnd/sensors";
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

type GestureKind = "move" | "resize-start" | "resize-end" | "create";
export type EventCalendarDragData<T> = {
  calendarGesture: true;
  kind: GestureKind;
  segment?: EventCalendarSegment<T>;
  day?: Date;
  allDay?: boolean;
};
export type EventCalendarDropData = {
  calendarDrop: true;
  day: Date;
  allDay: boolean;
  resourceId?: string;
};

let lastGestureEndedAt = 0;
let lastChipPressAt = 0;
export const wasRecentDrag = () => performance.now() - lastGestureEndedAt < 250;
export const markChipPress = () => {
  lastChipPressAt = performance.now();
};
export const wasRecentChipPress = () =>
  performance.now() - lastChipPressAt < 300;

/** Preserve feedback for a genuine drag attempt on a locked event. */
export function beginBlockedEventCalendarGesture<T>(
  instance: EventCalendarInstance<T>,
  startEvent: PointerEvent,
  segment: EventCalendarSegment<T>,
  gesture: "move" | "resize",
) {
  const { clientX: startX, clientY: startY, pointerId } = startEvent;
  const event = segment.occurrence.event;
  const reason = event.readOnly
    ? "readOnly"
    : (gesture === "move" ? event.draggable : event.resizable) === false
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
      gesture,
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

export function proposeEventCalendarDrop<T>(
  data: EventCalendarDragData<T>,
  target: EventCalendarDropData,
  timeZone: string,
): EventCalendarProposedUpdate<T> | null {
  const occurrence = data.segment?.occurrence;
  if (!occurrence) return null;
  const sourceDay = zonedStartOfDay(
    data.segment?.day ?? occurrence.start,
    timeZone,
  );
  const targetDay = zonedStartOfDay(target.day, timeZone);
  const delta = differenceInCalendarDays(
    toZoned(targetDay, timeZone),
    toZoned(sourceDay, timeZone),
  );
  let start = occurrence.start;
  let end = occurrence.end;
  if (data.kind === "move") {
    const duration = occurrence.end.getTime() - occurrence.start.getTime();
    start = addDays(toZoned(occurrence.start, timeZone), delta);
    end = new Date(start.getTime() + duration);
  } else if (data.kind === "resize-start") {
    const time =
      occurrence.start.getTime() -
      zonedStartOfDay(occurrence.start, timeZone).getTime();
    start = new Date(targetDay.getTime() + time);
  } else {
    const time = occurrence.allDay
      ? 0
      : occurrence.end.getTime() -
        zonedStartOfDay(occurrence.end, timeZone).getTime();
    end = occurrence.allDay
      ? addDays(targetDay, 1)
      : new Date(
          addDays(targetDay, time > 0 ? 0 : 1).getTime() + time,
        );
  }
  if (start >= end) return null;
  return {
    event: occurrence.event,
    occurrence,
    start,
    end,
    allDay: occurrence.allDay,
    resourceId: target.resourceId,
    source:
      data.kind === "move"
        ? "drag"
        : (data.kind as "resize-start" | "resize-end"),
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
  });
  const [active, setActive] =
    useState<EventCalendarDragData<T> | null>(null);
  const activeRef = useRef(false);
  const scopeKey = useEventCalendarSelector<T, string>(
    (state) =>
      `${state.view}:${state.visibleRange.start.getTime()}:${state.visibleRange.end.getTime()}`,
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
      if (data.kind === "create") {
        const anchor = data.day ?? target.day;
        const start = anchor <= target.day ? anchor : target.day;
        const end = addDays(anchor <= target.day ? target.day : anchor, 1);
        const draft = {
          start,
          end,
          allDay: target.allDay,
          view: instance.getState().view,
        };
        const allowed = settings.canSelectSlot?.(draft) ?? true;
        setValid(allowed);
        if (allowed) instance.internals.setSlotDraft(draft);
        return;
      }
      const update = proposeEventCalendarDrop(
        data,
        target,
        settings.timeZone,
      );
      if (!update) return;
      const allowed = settings.canDropEvent?.(update) ?? true;
      setValid(allowed);
      instance.internals.setDrag({
        kind: data.kind,
        occurrence: update.occurrence!,
        proposedStart: update.start,
        proposedEnd: update.end,
        proposedAllDay: update.allDay,
        proposedDayGranular: target.allDay,
        proposedResourceId: target.resourceId,
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
    ({ active: item, over }: DragMoveEvent) => {
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
    lastGestureEndedAt = performance.now();
    instance.internals.setDrag(null);
    instance.internals.setSlotDraft(null);
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
      if (data.kind === "create") {
        const draft = instance.getState().slotDraft;
        if (draft && (settings.canSelectSlot?.(draft) ?? true)) {
          instance.api.select({
            slot: { start: draft.start, end: draft.end, allDay: draft.allDay },
          });
          settings.onSelectSlot?.(draft);
        }
      } else {
        const drag = instance.getState().drag;
        if (drag?.valid)
          instance.internals.applyProposedUpdate({
            event: drag.occurrence.event,
            occurrence: drag.occurrence,
            start: drag.proposedStart,
            end: drag.proposedEnd,
            allDay: drag.proposedAllDay,
            resourceId: drag.proposedResourceId,
            source: data.kind === "move" ? "drag" : data.kind,
          });
      }
      clear();
    },
    [clear, instance, settings],
  );
  const state = useMemo(() => ({ active, valid }), [active, valid]);
  return (
    <CalendarDndContext.Provider value={state as State<unknown>}>
      <DndContext
        sensors={sensors}
        autoScroll={false}
        onDragStart={onStart}
        onDragMove={onMove}
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
  kind: Exclude<GestureKind, "create">,
  disabled = false,
) {
  return useDraggable({
    id: `calendar:${kind}:${segment.occurrence.key}:${segment.day.getTime()}`,
    data: {
      calendarGesture: true,
      kind,
      segment,
    } satisfies EventCalendarDragData<T>,
    disabled,
  });
}
export function useEventCalendarCreateDrag(
  day: Date,
  allDay: boolean,
  disabled = false,
) {
  return useDraggable({
    id: `calendar:create:${day.getTime()}:${allDay}`,
    data: {
      calendarGesture: true,
      kind: "create",
      day,
      allDay,
    } satisfies EventCalendarDragData<unknown>,
    disabled,
  });
}
export function useEventCalendarDrop(
  day: Date,
  allDay: boolean,
  resourceId?: string,
) {
  return useDroppable({
    id: `calendar:drop:${day.getTime()}:${allDay}:${resourceId ?? ""}`,
    data: {
      calendarDrop: true,
      day,
      allDay,
      resourceId,
    } satisfies EventCalendarDropData,
  });
}
export function useEventCalendarDndState<T>() {
  return useContext(CalendarDndContext) as State<T>;
}
