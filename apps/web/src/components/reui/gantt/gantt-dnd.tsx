"use client"

import {
  DndContext,
  DragOverlay,
  useDraggable,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import { useCallback, useEffect, useRef, type ReactNode } from "react"
import { createDndAutoScroller } from "~/components/dnd/auto-scroll"
import {
  createDndAnnouncements,
  cubbyDndScreenReaderInstructions,
} from "~/components/dnd/accessibility"
import { useCubbyDndSensors } from "~/components/dnd/sensors"
import {
  resolveScheduleMode,
  useGantt,
  useGanttSelector,
  useGanttViewConfig,
  type GanttInstance,
} from "~/components/reui/gantt/gantt"
import { DragPreviewFrame } from "~/components/dnd/DragPreviewFrame"
import {
  findResource,
  snapMinutes,
  toZoned,
  zonedStartOfDay,
} from "~/components/reui/gantt/gantt-lib"
import type {
  GanttProposedUpdate,
  GanttScheduleMode,
  GanttSegment,
} from "~/components/reui/gantt/gantt-types"
import { addDays, differenceInCalendarDays } from "date-fns"

export const GANTT_ACTIVATION = {
  moveDistancePx: 5,
  createDistancePx: 4,
  touchDelayMs: 250,
  touchTolerancePx: 5,
} as const
type GestureKind = "move" | "resize-start" | "resize-end" | "create"
interface GanttSurface {
  rect: DOMRect
  rangeStart: number
  rangeEnd: number
  snapMin: number
  isRtl: boolean
  rows: Array<{ resourceId: string; rect: DOMRect }>
}
interface GestureData<TData = unknown> {
  kind: GestureKind
  segment?: GanttSegment<TData>
  scheduleMode?: GanttScheduleMode
  resourceId?: string
}
let lastGestureEndedAt = 0
const activeCancels = new Set<() => void>()
export const wasRecentDrag = () => performance.now() - lastGestureEndedAt < 250
export const markGestureEnd = () => {
  lastGestureEndedAt = performance.now()
}

function collectSurface(root: HTMLElement | null): GanttSurface | null {
  const axis = root?.querySelector<HTMLElement>("[data-gantt-axis]")
  if (!axis) return null
  return {
    rect: axis.getBoundingClientRect(),
    rangeStart: Number(axis.dataset.ganttRangeStart),
    rangeEnd: Number(axis.dataset.ganttRangeEnd),
    snapMin: Number(axis.dataset.ganttSnap) || 15,
    isRtl: getComputedStyle(axis).direction === "rtl",
    rows: [...root!.querySelectorAll<HTMLElement>("[data-gantt-row]")]
      .filter((row) => row.dataset.ganttRowStatic === undefined)
      .map((row) => ({
        resourceId: row.dataset.ganttResource ?? "",
        rect: row.getBoundingClientRect(),
      })),
  }
}
function minutesAt(surface: GanttSurface, x: number) {
  const x1 = Math.min(Math.max(x, surface.rect.left), surface.rect.right)
  const progress = surface.isRtl
    ? surface.rect.right - x1
    : x1 - surface.rect.left
  return (
    (progress / surface.rect.width) *
    ((surface.rangeEnd - surface.rangeStart) / 60000)
  )
}
function eventPoint(
  event: DragStartEvent | DragMoveEvent,
  surface: GanttSurface,
) {
  const activator = event.activatorEvent as {
    clientX?: number
    clientY?: number
  }
  const rect = event.active.rect.current.initial
  const x =
    activator.clientX ??
    (rect?.left ?? surface.rect.left) + (rect?.width ?? 0) / 2
  const y =
    activator.clientY ??
    (rect?.top ?? surface.rect.top) + (rect?.height ?? 0) / 2
  return {
    x: x + ("delta" in event ? event.delta.x : 0),
    y: y + ("delta" in event ? event.delta.y : 0),
  }
}
function clampNeighbours<TData>(
  instance: GanttInstance<TData>,
  data: GestureData<TData>,
  start: Date,
  end: Date,
) {
  const occurrence = data.segment?.occurrence
  if (!occurrence)
    return { start, end, allDay: false, resourceId: data.resourceId }
  const node = findResource(
    instance.settings.resources,
    occurrence.event.resourceId ?? "",
  )
  const policy =
    resolveScheduleMode(node, data.scheduleMode) === "single"
      ? "reject"
      : instance.settings.overlap
  if (policy !== "clamp")
    return {
      start,
      end,
      allDay: occurrence.allDay,
      resourceId: occurrence.event.resourceId,
    }
  let floor = -Infinity,
    ceiling = Infinity
  for (const other of instance.api.getOccurrences())
    if (
      other.event.resourceId === occurrence.event.resourceId &&
      other.key !== occurrence.key
    ) {
      if (other.end.getTime() <= occurrence.start.getTime())
        floor = Math.max(floor, other.end.getTime())
      else if (other.start.getTime() >= occurrence.end.getTime())
        ceiling = Math.min(ceiling, other.start.getTime())
    }
  let from = start.getTime(),
    to = end.getTime()
  if (data.kind === "resize-start") from = Math.min(Math.max(from, floor), to)
  else if (data.kind === "resize-end")
    to = Math.max(Math.min(to, ceiling), from)
  else {
    const duration = to - from
    if (from < floor) {
      from = floor
      to = from + duration
    }
    if (to > ceiling) {
      to = ceiling
      from = to - duration
    }
  }
  return {
    start: new Date(from),
    end: new Date(to),
    allDay: occurrence.allDay,
    resourceId: occurrence.event.resourceId,
  }
}
function proposalFor<TData>(
  instance: GanttInstance<TData>,
  data: GestureData<TData>,
  surface: GanttSurface,
  startPoint: { x: number; y: number },
  point: { x: number; y: number },
) {
  const { settings } = instance
  const occurrence = data.segment?.occurrence
  const at = (m: number) => new Date(surface.rangeStart + m * 60000)
  const snap = (m: number) => {
    if (surface.snapMin < 1440) return snapMinutes(m, surface.snapMin)
    const ms = surface.rangeStart + m * 60000
    const before = zonedStartOfDay(new Date(ms), settings.timeZone)
    const after = zonedStartOfDay(
      addDays(toZoned(new Date(ms), settings.timeZone), 1),
      settings.timeZone,
    )
    return (
      ((ms - before.getTime() < after.getTime() - ms
        ? before
        : after
      ).getTime() -
        surface.rangeStart) /
      60000
    )
  }
  if (data.kind === "create") {
    const anchor = snap(minutesAt(surface, startPoint.x))
    const current = snap(minutesAt(surface, point.x))
    const low = Math.min(anchor, current)
    return {
      start: at(low),
      end: at(
        Math.max(
          anchor,
          current,
          low + Math.max(surface.snapMin, settings.slotDuration),
        ),
      ),
      allDay: false,
      resourceId:
        data.resourceId ??
        surface.rows.find(
          (row) => point.y >= row.rect.top && point.y < row.rect.bottom,
        )?.resourceId,
    }
  }
  if (!occurrence) return null
  const time = snap(minutesAt(surface, point.x))
  const midnight = (d: Date) =>
    zonedStartOfDay(d, settings.timeZone).getTime() === d.getTime()
  if (data.kind === "move") {
    const grabbed =
      minutesAt(surface, startPoint.x) -
      (occurrence.start.getTime() - surface.rangeStart) / 60000
    const proposedStart = at(snap(minutesAt(surface, point.x) - grabbed))
    const proposedEnd =
      surface.snapMin >= 1440 &&
      (occurrence.allDay ||
        (midnight(occurrence.start) && midnight(occurrence.end)))
        ? zonedStartOfDay(
            addDays(
              toZoned(proposedStart, settings.timeZone),
              Math.max(
                differenceInCalendarDays(
                  toZoned(occurrence.end, settings.timeZone),
                  toZoned(occurrence.start, settings.timeZone),
                ),
                1,
              ),
            ),
            settings.timeZone,
          )
        : new Date(
            proposedStart.getTime() +
              occurrence.end.getTime() -
              occurrence.start.getTime(),
          )
    return clampNeighbours(instance, data, proposedStart, proposedEnd)
  }
  if (data.kind === "resize-start") {
    const end = (occurrence.end.getTime() - surface.rangeStart) / 60000
    const max =
      surface.snapMin >= 1440
        ? (zonedStartOfDay(
            midnight(occurrence.end)
              ? addDays(toZoned(occurrence.end, settings.timeZone), -1)
              : occurrence.end,
            settings.timeZone,
          ).getTime() -
            surface.rangeStart) /
          60000
        : end - surface.snapMin
    return clampNeighbours(
      instance,
      data,
      at(Math.min(Math.max(time, 0), max)),
      occurrence.end,
    )
  }
  const min =
    surface.snapMin >= 1440
      ? (zonedStartOfDay(
          addDays(toZoned(occurrence.start, settings.timeZone), 1),
          settings.timeZone,
        ).getTime() -
          surface.rangeStart) /
        60000
      : (occurrence.start.getTime() - surface.rangeStart) / 60000 +
        surface.snapMin
  return clampNeighbours(
    instance,
    data,
    occurrence.start,
    at(
      Math.max(
        Math.min(time, (surface.rangeEnd - surface.rangeStart) / 60000),
        min,
      ),
    ),
  )
}

function useGanttDraggable<TData>(
  id: string,
  data: GestureData<TData>,
  disabled: boolean,
) {
  return useDraggable({ id, data, disabled })
}
export function useGanttBarDraggable<TData>(
  segment: GanttSegment<TData>,
  kind: Exclude<GestureKind, "create">,
  disabled: boolean,
) {
  const config = useGanttViewConfig<TData>()
  return useGanttDraggable(
    `gantt:${kind}:${segment.occurrence.key}:${segment.day.getTime()}:${segment.startMin ?? ""}`,
    { kind, segment, scheduleMode: config.scheduleMode },
    disabled,
  )
}
export function useGanttCreateDraggable(resourceId: string, disabled: boolean) {
  return useGanttDraggable(
    `gantt:create:${resourceId}`,
    { kind: "create", resourceId },
    disabled,
  )
}

export function GanttDndProvider({ children }: { children: ReactNode }) {
  const instance = useGantt()
  const current = useRef<{
    data: GestureData
    root: HTMLElement
    surface: GanttSurface
    start: { x: number; y: number }
    invalid: boolean
  } | null>(null)
  const lastMove = useRef<DragMoveEvent | DragStartEvent | null>(null)
  const applyRef = useRef<
    ((event: DragMoveEvent | DragStartEvent) => void) | null
  >(null)
  const viewConfig = useGanttViewConfig()
  const drag = useGanttSelector((state) => state.drag)
  const scroller = useRef(
    createDndAutoScroller({
      axis: "horizontal",
      edgeSize: 24,
      maxSpeed: 14,
      onScroll: () => {
        const active = current.current
        const event = lastMove.current
        if (!active || !event) return
        active.surface = collectSurface(active.root) ?? active.surface
        applyRef.current?.(event)
      },
    }),
  )
  const sensors = useCubbyDndSensors({
    pointerDistance: GANTT_ACTIVATION.moveDistancePx,
    touchDelay: GANTT_ACTIVATION.touchDelayMs,
    touchTolerance: GANTT_ACTIVATION.touchTolerancePx,
  })
  const clear = useCallback(() => {
    scroller.current.stop()
    current.current = null
    instance.internals.setDrag(null)
    instance.internals.setSlotDraft(null)
    lastGestureEndedAt = performance.now()
  }, [instance])
  useEffect(() => {
    activeCancels.add(clear)
    return () => {
      activeCancels.delete(clear)
      clear()
    }
  }, [clear])
  const apply = useCallback(
    (event: DragMoveEvent | DragStartEvent) => {
      const active = current.current
      if (!active) return
      lastMove.current = event
      const point = eventPoint(event, active.surface)
      const proposal = proposalFor(
        instance,
        active.data,
        active.surface,
        active.start,
        point,
      )
      if (!proposal) return
      const viewport = active.root.querySelector<HTMLElement>(
        "[data-slot=gantt-timeline-pane] [data-slot=scroll-area-viewport]",
      )
      if (viewport) scroller.current.update(point, [viewport])
      if (active.data.kind === "create") {
        const valid = instance.settings.canSelectSlot?.(proposal) ?? true
        active.invalid = !valid
        instance.internals.setSlotDraft(valid ? proposal : null)
        return
      }
      const occurrence = active.data.segment!.occurrence
      const policy =
        resolveScheduleMode(
          findResource(
            instance.settings.resources,
            occurrence.event.resourceId ?? "",
          ),
          active.data.scheduleMode,
        ) === "single"
          ? "reject"
          : instance.settings.overlap
      const overlaps = instance.api
        .getOccurrences()
        .some(
          (other) =>
            other.event.resourceId === occurrence.event.resourceId &&
            other.key !== occurrence.key &&
            other.start < proposal.end &&
            other.end > proposal.start,
        )
      const update: GanttProposedUpdate = {
        event: occurrence.event,
        occurrence,
        ...proposal,
        source:
          active.data.kind === "move"
            ? "drag"
            : (active.data.kind as "resize-start" | "resize-end"),
      }
      const valid =
        !(policy === "reject" && overlaps) &&
        (instance.settings.canDropEvent?.(update) ?? true)
      active.invalid = !valid
      instance.internals.setDrag({
        kind: active.data.kind,
        occurrence,
        proposedStart: proposal.start,
        proposedEnd: proposal.end,
        proposedAllDay: proposal.allDay,
        proposedResourceId: proposal.resourceId,
        valid,
      })
    },
    [instance],
  )
  applyRef.current = apply
  const onStart = useCallback(
    (event: DragStartEvent) => {
      const data = event.active.data.current as GestureData | undefined
      const root =
        (
          event.activatorEvent.target as HTMLElement | null
        )?.closest<HTMLElement>("[data-slot=gantt]") ?? null
      const surface = collectSurface(root)
      if (!data || !root || !surface) return
      instance.internals.setDrag(null)
      instance.internals.setSlotDraft(null)
      current.current = {
        data,
        root,
        surface,
        start: eventPoint(event, surface),
        invalid: false,
      }
      apply(event)
    },
    [apply, instance],
  )
  const onEnd = useCallback(
    (_event: DragEndEvent) => {
      const active = current.current
      const state = instance.getState()
      if (active?.data.kind === "create") {
        const draft = state.slotDraft
        clear()
        if (draft) {
          instance.api.select({
            slot: { start: draft.start, end: draft.end, allDay: draft.allDay },
          })
          instance.settings.onSelectSlot?.(draft)
        }
        return
      }
      const drag = state.drag
      if (active && drag && !active.invalid) {
        const occurrence = active.data.segment!.occurrence
        if (
          drag.proposedStart.getTime() !== occurrence.start.getTime() ||
          drag.proposedEnd.getTime() !== occurrence.end.getTime()
        )
          instance.internals.applyProposedUpdate({
            event: occurrence.event,
            occurrence,
            start: drag.proposedStart,
            end: drag.proposedEnd,
            allDay: drag.proposedAllDay,
            resourceId: drag.proposedResourceId,
            source: active.data.kind === "move" ? "drag" : active.data.kind,
          })
      }
      clear()
    },
    [clear, instance],
  )
  return (
    <DndContext
      sensors={sensors}
      autoScroll={false}
      onDragStart={onStart}
      onDragMove={apply}
      onDragEnd={onEnd}
      onDragCancel={clear}
      accessibility={{
        container: typeof document === "undefined" ? undefined : document.body,
        screenReaderInstructions: cubbyDndScreenReaderInstructions,
        announcements: createDndAnnouncements({
          item: (id) =>
            id.startsWith("gantt:create:")
              ? "New schedule"
              : (drag?.occurrence.event.title ?? "Schedule"),
          target: () => "timeline",
        }),
      }}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {drag ? (
          drag.kind === "move" && viewConfig.renderDragPreview ? (
            viewConfig.renderDragPreview({
              occurrence: drag.occurrence,
              kind: drag.kind,
              start: drag.proposedStart,
              end: drag.proposedEnd,
              valid: drag.valid,
            })
          ) : drag.kind !== "move" && viewConfig.renderResizeIndicator ? (
            viewConfig.renderResizeIndicator({
              occurrence: drag.occurrence,
              kind: drag.kind,
              start: drag.proposedStart,
              end: drag.proposedEnd,
              valid: drag.valid,
            })
          ) : (
            <DragPreviewFrame
              valid={drag.valid}
              className="px-2 py-1 text-xs font-medium"
            >
              {drag.occurrence.event.title}
            </DragPreviewFrame>
          )
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
export function cancelActiveGanttGestures(): void {
  for (const cancel of activeCancels) cancel()
}
export function useGanttGestureTeardown(): void {
  useEffect(() => cancelActiveGanttGestures, [])
}
