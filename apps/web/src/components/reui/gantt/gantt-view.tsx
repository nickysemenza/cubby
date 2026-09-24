"use client"

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"
import {
  useGantt,
  useGanttSelector,
  useGanttSettings,
  useGanttViewConfig,
  type GanttColumn,
} from "~/components/reui/gantt/gantt"
import { GanttBar } from "~/components/reui/gantt/gantt-bar"
import {
  getDayKey,
  getLaneKey,
  getRangeKey,
  packTimedSegments,
  resolveOffDay,
  toZoned,
  zonedStartOfDay,
  type GanttLaneMemo,
} from "~/components/reui/gantt/gantt-lib"
import type {
  GanttDateRange,
  GanttDependencyEdge,
  GanttEvent,
  GanttOccurrence,
  GanttResource,
  GanttSegment,
} from "~/components/reui/gantt/gantt-types"
import { mergeProps } from "@base-ui/react/merge-props"
// Base UI's ScrollArea re-measures its thumb + overflow on mount, viewport
// resize and scroll, but NOT on a content-size change unless the content sits
// in a ScrollArea.Content (which carries the content ResizeObserver). ReUI's
// ScrollArea puts children straight in the Viewport, so the tree/timeline
// panes wrap their scroll content in this Content to keep the scrollbar in
// sync when rows expand/collapse or tree columns show/hide. (Radix observes
// content automatically, so its twin needs no equivalent.)
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"
import { useRender } from "@base-ui/react/use-render"
import {
  addDays,
  addMinutes,
  addMonths,
  format,
  getWeek,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  type Locale,
} from "date-fns"

import { cn } from "~/lib/utils"
import { Button } from "~/components/ui/button"
import { ScrollArea, ScrollBar } from "~/components/ui/scroll-area"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip"
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { MinusIcon } from "@phosphor-icons/react/dist/csr/Minus";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft";

/** Current time, refreshed on an interval and on tab focus. */
function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const tick = () => setNow(new Date())
    const id = setInterval(tick, intervalMs)
    document.addEventListener("visibilitychange", tick)
    window.addEventListener("focus", tick)
    return () => {
      clearInterval(id)
      document.removeEventListener("visibilitychange", tick)
      window.removeEventListener("focus", tick)
    }
  }, [intervalMs])
  return now
}

/**
 * Today's zoned day key, re-rendering only at the midnight rollover (and on
 * focus/visibility) - the grid needs day granularity, not the 30s now tick.
 */
function useTodayKey(timeZone: string): string {
  const [key, setKey] = useState(() => getDayKey(new Date(), timeZone))
  useEffect(() => {
    const tick = () =>
      setKey((prev) => {
        const next = getDayKey(new Date(), timeZone)
        return next === prev ? prev : next
      })
    tick()
    const id = setInterval(tick, 60_000)
    document.addEventListener("visibilitychange", tick)
    window.addEventListener("focus", tick)
    return () => {
      clearInterval(id)
      document.removeEventListener("visibilitychange", tick)
      window.removeEventListener("focus", tick)
    }
  }, [timeZone])
  return key
}

/**
 * Pointer x resolved against the element's TIME axis: the 0..1 fraction and
 * the same measurement in CSS pixels from the axis start. Mirrored in RTL,
 * where the range start renders at the element's right edge. One rect read
 * and one style read, because this runs on every pointer move.
 */
function trackPoint(
  el: HTMLElement,
  clientX: number
): { fraction: number; offset: number } {
  const rect = el.getBoundingClientRect()
  const rtl = getComputedStyle(el).direction === "rtl"
  const offset = rtl ? rect.right - clientX : clientX - rect.left
  // `offset` is exact and drives the time maths. `snapped` is the same value
  // biased so that rect start + snapped lands on a WHOLE viewport pixel: the
  // row's own edge routinely sits on a half pixel, so rounding the offset
  // alone still puts anything placed at it between two pixels.
  const snapped = rtl
    ? rect.right - Math.round(clientX)
    : Math.round(clientX) - rect.left
  return {
    fraction: rect.width > 0 ? offset / rect.width : 0,
    offset: snapped,
  }
}

/**
 * Row geometry is three numbers: a bar is LANE_HEIGHT_REM tall, stacked bars
 * are separated by LANE_GAP_REM, and the block as a whole is inset from the
 * row's edges by ROW_PADDING_REM. Padding and gap are deliberately NOT the
 * same value - schedules in one node belong together, so they sit tight, while
 * the row still needs real breathing room above and below. Every inter-lane
 * gap is identical, which is what keeps a stacked row reading evenly.
 */
const LANE_HEIGHT_REM = 1.25
const LANE_GAP_REM = 0.1875
const ROW_PADDING_REM = 0.5
/** Bars narrower than this flip their title outside in barLabel "auto". */
const AUTO_LABEL_MIN_REM = 7
const DEFAULT_TREE_PANEL = {
  width: 288,
  minWidth: 180,
  maxWidth: 640,
  resizable: true,
  nameColumnWidth: 208,
}
const DEFAULT_COLUMN_WIDTH = 96
const DEFAULT_ZOOM_RANGE = { min: 0.5, max: 3 }
/** Timeline pane never shrinks below this so it stays usable on narrow screens. */
const MIN_TIMELINE_WIDTH = 200
/** Scroll distance from an edge that triggers infinite-range growth. */

interface TimelineUnit {
  key: string
  label: string
  ms: number
  /** Relative width share; uniform scales use 1 (year: days per month). */
  weight: number
  isToday?: boolean
  isOff?: boolean
}

interface TimelineGroup {
  key: string
  label: string
  span: number
}

interface TimelineRow {
  resource: GanttResource
  parentId: string | null
  depth: number
  isGroup: boolean
  collapsed: boolean
}

/** Per-row packed bars plus the extents the off-screen chips need. */
interface TimelineRowBars {
  segments: GanttSegment[]
  laneCount: number
  heightRem: number
  /** Gap above the first bar; equal to every other gap in the row. */
  laneOffsetRem: number
  /**
   * The band the FIRST schedule occupies, its gaps included. The tree cell
   * sizes its label box to exactly this, so the label and the first bar share
   * a centerline however many lanes the node grew.
   */
  bandRem: number
  /** Envelope of all bars, as track fractions; null when the row is empty. */
  extent: {
    from: number
    to: number
    color?: string
    label: string
    /** First bar start, for the jump-chip tooltip. */
    startMs: number
  } | null
  /**
   * Parent rollup: descendant-bar envelope + duration-weighted progress,
   * present only on group rows without bars of their own.
   */
  summary: { from: number; to: number; progress: number | null } | null
}

interface GanttViewProps extends useRender.ComponentProps<"div"> {
  /** Day-scale unit interval in minutes; defaults to the interval view config. */
  interval?: number
}

interface DependencyPath {
  id: string
  d: string
  className?: string
}

function GanttDependencyOverlay({
  bodyRef,
  edges,
  refreshKey,
}: {
  bodyRef: RefObject<HTMLDivElement | null>
  edges: GanttDependencyEdge[]
  refreshKey: string
}) {
  const markerId = useId().replaceAll(":", "")
  const [paths, setPaths] = useState<DependencyPath[]>([])

  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body || edges.length === 0) {
      setPaths([])
      return
    }

    const measure = () => {
      const bodyRect = body.getBoundingClientRect()
      const next = edges.flatMap((edge) => {
        const fromRow = body.querySelector<HTMLElement>(
          `[data-gantt-row-id="${CSS.escape(edge.fromId)}"]`
        )
        const toRow = body.querySelector<HTMLElement>(
          `[data-gantt-row-id="${CSS.escape(edge.toId)}"]`
        )
        const fromBar = fromRow?.querySelector<HTMLElement>(
          "[data-slot=gantt-bar]:not([data-event-id^=envelope:])"
        )
        const toBar = toRow?.querySelector<HTMLElement>(
          "[data-slot=gantt-bar]:not([data-event-id^=envelope:])"
        )
        if (!fromBar || !toBar) return []

        const from = fromBar.getBoundingClientRect()
        const to = toBar.getBoundingClientRect()
        const startX = from.right - bodyRect.left
        const startY = from.top + from.height / 2 - bodyRect.top
        const endX = to.left - bodyRect.left
        const endY = to.top + to.height / 2 - bodyRect.top
        const elbowX =
          endX >= startX
            ? startX + Math.max(12, (endX - startX) / 2)
            : Math.max(startX, endX) + 16

        return [
          {
            id: `${edge.fromId}:${edge.toId}`,
            d: `M ${startX} ${startY} H ${elbowX} V ${endY} H ${endX}`,
            className: edge.className,
          },
        ]
      })
      setPaths(next)
    }

    let frame = requestAnimationFrame(measure)
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    })
    observer.observe(body)
    for (const row of body.querySelectorAll<HTMLElement>("[data-gantt-row-id]")) {
      observer.observe(row)
    }
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [bodyRef, edges, refreshKey])

  if (paths.length === 0) return null

  return (
    <svg
      aria-hidden
      data-slot="gantt-dependencies"
      className="pointer-events-none absolute inset-0 z-20 size-full overflow-visible"
    >
      <defs>
        <marker
          id={markerId}
          markerWidth="6"
          markerHeight="6"
          refX="5"
          refY="3"
          orient="auto"
        >
          <path d="M0,0 L6,3 L0,6 Z" className="fill-primary/60" />
        </marker>
      </defs>
      {paths.map((path) => (
        <path
          key={path.id}
          d={path.d}
          markerEnd={`url(#${markerId})`}
          className={cn(
            "fill-none stroke-primary/50 [stroke-width:1.5]",
            path.className
          )}
        />
      ))}
    </svg>
  )
}

/** The pane's scrollable viewport (custom ScrollArea or native host). */
function getPaneViewport(pane: HTMLElement | null): HTMLElement | null {
  return (
    pane?.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]") ?? null
  )
}

/** Distance scrolled from the inline-start edge (RTL reports negative). */
function getScrollStart(viewport: HTMLElement): number {
  return Math.abs(viewport.scrollLeft)
}

/** Write a distance-from-inline-start back as a signed scrollLeft. */
function setScrollStart(viewport: HTMLElement, value: number) {
  viewport.scrollLeft =
    getComputedStyle(viewport).direction === "rtl" ? -value : value
}

function GanttView({
  className,
  render,
  interval: intervalProp,
  ...props
}: GanttViewProps) {
  const instance = useGantt()
  const settings = useGanttSettings()
  const viewConfig = useGanttViewConfig()
  const range = useGanttSelector<unknown, GanttDateRange>(
    (state) => state.visibleRange,
    { isEqual: (a, b) => getRangeKey(a) === getRangeKey(b) }
  )
  const occurrences = useGanttSelector<unknown, GanttOccurrence[]>(
    () => instance.api.getOccurrences(),
    {
      isEqual: (a, b) =>
        a.length === b.length &&
        a.every(
          (occ, i) =>
            occ.key === b[i]?.key &&
            occ.start.getTime() === b[i]?.start.getTime() &&
            occ.end.getTime() === b[i]?.end.getTime() &&
            occ.event === b[i]?.event
        ),
    }
  )

  // Tree expand/collapse is controlled when the project owns its open groups.
  const [internalCollapsed, setInternalCollapsed] = useState<string[]>([])
  const collapsedIds = viewConfig.collapsedGroups ?? internalCollapsed
  const collapsedGroups = useMemo(() => new Set(collapsedIds), [collapsedIds])

  const scale = useGanttSelector((state) => state.scale)
  const interval = Math.min(
    Math.max(intervalProp ?? 60, 15),
    240
  )
  const laneHeightRem = LANE_HEIGHT_REM
  const rowPaddingRem = ROW_PADDING_REM
  const laneGapRem = LANE_GAP_REM
  const minRowRem = 2.5
  const minTimelineWidth = MIN_TIMELINE_WIDTH
  const timeZone = settings.timeZone
  const rangeStartMs = range.start.getTime()
  const rangeEndMs = range.end.getTime()
  const rangeKey = getRangeKey(range)
  const snapMin = 24 * 60
  // day-granular time input so the today highlight rolls over at midnight
  // without the whole grid re-rendering on the 30s now tick
  const todayDayKey = useTodayKey(timeZone)

  const rows = useMemo(() => {
    const result: TimelineRow[] = []
    const walk = (
      resources: GanttResource[],
      depth: number,
      parentId: string | null
    ) => {
      for (const resource of resources) {
        const isGroup = !!resource.children?.length
        const collapsed = collapsedGroups.has(resource.id)
        result.push({ resource, parentId, depth, isGroup, collapsed })
        if (isGroup && !collapsed)
          walk(resource.children!, depth + 1, resource.id)
      }
    }
    walk(settings.resources, 0, null)
    return result
  }, [settings.resources, collapsedGroups])

  // Header model: bottom row = units, top row = grouping sectors.
  // Weights are proportional to REAL duration (a 23h/25h DST day differs from
  // its siblings), so weight-driven gridlines, ms-fraction bar geometry, and
  // the dnd pointer math all share one coordinate system.
  const { units, groups, unitWidthRem } = useMemo(() => {
    const units: TimelineUnit[] = []
    const groups: TimelineGroup[] = []
    // day-start ms for the today window checks; recomputed when the day key
    // rolls over (this memo depends on todayDayKey)
    const todayStartMs = zonedStartOfDay(new Date(), timeZone).getTime()
    if (scale === "day") {
      const labelFormat =
        interval % 60 === 0 ? settings.i18n.formats.timeGutter : "h:mm"
      // walk whole days: infinite scroll can extend the range past one day
      let dayCursor = zonedStartOfDay(range.start, timeZone)
      while (dayCursor.getTime() < rangeEndMs) {
        const zonedDay = toZoned(dayCursor, timeZone)
        const nextDay = zonedStartOfDay(addDays(zonedDay, 1), timeZone)
        const dayMinutes = (nextDay.getTime() - dayCursor.getTime()) / 60000
        const dayOff = resolveOffDay(
          dayCursor,
          timeZone,
          true
        )
        let span = 0
        for (let m = 0; m < dayMinutes; m += interval) {
          const time = addMinutes(zonedDay, m)
          // a DST day whose minutes don't divide evenly leaves a short
          // final unit; its weight must be its REAL share or bars drift
          const weight = Math.min(interval, dayMinutes - m) / interval
          units.push({
            key: `${getDayKey(dayCursor, timeZone)}-m${m}`,
            label: format(time, labelFormat, { locale: settings.locale }),
            ms: time.getTime(),
            weight,
            isOff: dayOff,
          })
          span += weight
        }
        groups.push({
          key: getDayKey(dayCursor, timeZone),
          label: format(zonedDay, settings.i18n.formats.dayTitle, {
            locale: settings.locale,
          }),
          span,
        })
        dayCursor = nextDay
      }
      return {
        units,
        groups,
        unitWidthRem:
          Math.max(2.5, 5 * (interval / 60)),
      }
    }
    if (scale === "quarter") {
      // units are week-aligned weeks (lib aligns the range), groups are months
      let cursor = zonedStartOfDay(range.start, timeZone)
      while (cursor.getTime() < rangeEndMs) {
        const zoned = toZoned(cursor, timeZone)
        const next = zonedStartOfDay(addDays(zoned, 7), timeZone)
        // real week duration / nominal week: 1 except across DST changes
        const weight =
          (next.getTime() - cursor.getTime()) / (7 * 24 * 60 * 60000)
        units.push({
          key: getDayKey(cursor, timeZone),
          label: format(zoned, "MMM d", { locale: settings.locale }),
          ms: cursor.getTime(),
          weight,
          isToday:
            todayStartMs >= cursor.getTime() && todayStartMs < next.getTime(),
        })
        const monthKey = format(zoned, "yyyy-MM")
        const lastGroup = groups[groups.length - 1]
        if (lastGroup && lastGroup.key === monthKey) {
          lastGroup.span += weight
        } else {
          groups.push({
            key: monthKey,
            label: format(zoned, "MMMM", { locale: settings.locale }),
            span: weight,
          })
        }
        cursor = next
      }
      return { units, groups, unitWidthRem: 8 }
    }
    if (scale === "year") {
      // units are calendar months (weight = real duration), groups are quarters
      let cursor: Date = startOfMonth(toZoned(range.start, timeZone))
      while (cursor.getTime() < rangeEndMs) {
        const next = startOfMonth(addMonths(cursor, 1))
        // nominal-day units so a month reads ~30 wide; real ms keeps DST months true
        const weight = (next.getTime() - cursor.getTime()) / (24 * 60 * 60000)
        units.push({
          key: format(cursor, "yyyy-MM"),
          label: format(cursor, "MMM", { locale: settings.locale }),
          ms: cursor.getTime(),
          weight,
          isToday:
            todayStartMs >= cursor.getTime() && todayStartMs < next.getTime(),
        })
        const quarterStart = startOfQuarter(cursor)
        const quarterKey = format(quarterStart, "yyyy-QQQ")
        const lastGroup = groups[groups.length - 1]
        if (lastGroup && lastGroup.key === quarterKey) {
          lastGroup.span += weight
        } else {
          groups.push({
            key: quarterKey,
            label: format(quarterStart, "QQQ yyyy", {
              locale: settings.locale,
            }),
            span: weight,
          })
        }
        cursor = next
      }
      return { units, groups, unitWidthRem: 10 }
    }
    // week/month: units are days, groups are ISO-ish weeks
    let cursor = zonedStartOfDay(range.start, timeZone)
    while (cursor.getTime() < rangeEndMs) {
      const zoned = toZoned(cursor, timeZone)
      const nextDay = zonedStartOfDay(addDays(zoned, 1), timeZone)
      // real day duration / 24h: 1 except the 23h/25h DST days
      const weight = (nextDay.getTime() - cursor.getTime()) / (24 * 60 * 60000)
      units.push({
        key: getDayKey(cursor, timeZone),
        label: format(zoned, "EEE d", { locale: settings.locale }),
        ms: cursor.getTime(),
        weight,
        isToday: getDayKey(cursor, timeZone) === todayDayKey,
        isOff: resolveOffDay(cursor, timeZone, true),
      })
      // locale supplies firstWeekContainsDate so W-numbers match the locale's
      // week numbering (ISO in de/fr, US-style otherwise); the explicit
      // weekStartsOn keeps the number aligned with the rendered grid
      const weekNumber = getWeek(zoned, {
        locale: settings.locale,
        weekStartsOn: settings.weekStartsOn,
      })
      // key + label from the true week start: a range that begins midweek
      // must not split or mislabel its first group (incl. the Jan 1 week)
      const weekStart = startOfWeek(zoned, {
        weekStartsOn: settings.weekStartsOn,
      })
      const weekKey = `w-${format(weekStart, "yyyy-MM-dd")}`
      const lastGroup = groups[groups.length - 1]
      if (lastGroup && lastGroup.key === weekKey) {
        lastGroup.span += weight
      } else {
        groups.push({
          key: weekKey,
          label: `${settings.i18n.labels.week(weekNumber)} ${format(weekStart, "MMM d", { locale: settings.locale })} - ${format(addDays(weekStart, 6), "d", { locale: settings.locale })}`,
          span: weight,
        })
      }
      cursor = nextDay
    }
    return {
      units,
      groups,
      unitWidthRem: scale === "week" ? 10 : 4,
    }
  }, [
    scale,
    interval,
    range.start,
    rangeEndMs,
    timeZone,
    settings.i18n,
    settings.locale,
    settings.weekStartsOn,
    todayDayKey,
  ])

  // Zoom multiplies the minimum unit width; the flex track still fills when
  // the zoomed width is narrower than the pane.
  const zoomRange = DEFAULT_ZOOM_RANGE
  const clampZoom = (value: number) =>
    Math.min(Math.max(value, zoomRange.min), zoomRange.max)
  const [zoom, setInternalZoom] = useState(1)
  const setZoomValue = (next: number) => {
    const clamped = clampZoom(next)
    setInternalZoom(clamped)
  }
  const canZoomIn = zoom < zoomRange.max - 1e-9
  const canZoomOut = zoom > zoomRange.min + 1e-9
  const trackRemWidth = units.length * unitWidthRem * zoom
  const trackWidth = `${trackRemWidth}rem`
  // unequal weights (year months, DST-containing day/week ranges) draw
  // boundaries from weight fractions instead of the uniform gradient
  const uniform = units.every(
    (unit) => Math.abs(unit.weight - units[0]!.weight) < 1e-9
  )
  const totalWeight = units.reduce((sum, unit) => sum + unit.weight, 0)
  /** Cumulative start/width fractions per unit, for backdrop stripes/lines. */
  const unitFractions = useMemo(() => {
    let acc = 0
    return units.map((unit) => {
      const start = acc / totalWeight
      acc += unit.weight
      return { unit, start, width: unit.weight / totalWeight }
    })
  }, [units, totalWeight])
  /** Group boundary fractions; spans are in unit-weight terms everywhere. */
  const groupBoundaries = useMemo(() => {
    const fractions: number[] = []
    let acc = 0
    for (let i = 0; i < groups.length - 1; i++) {
      acc += groups[i]!.span
      fractions.push(acc / totalWeight)
    }
    return fractions
  }, [groups, totalWeight])
  /** Resource id -> every descendant id, for parent rollups. */
  const descendantIds = useMemo(() => {
    const map = new Map<string, string[]>()
    const walk = (resource: GanttResource): string[] => {
      const ids = (resource.children ?? []).flatMap((child) => [
        child.id,
        ...walk(child),
      ])
      map.set(resource.id, ids)
      return ids
    }
    settings.resources.forEach(walk)
    return map
  }, [settings.resources])

  // All events (not just visible occurrences) so parent rollup progress is
  // all-time and matches a consumer's own tree rollup, independent of scroll.
  const allEvents = useGanttSelector<unknown, GanttEvent[]>(
    (state) => state.events
  )
  const subtreeProgress = useMemo(() => {
    // default: one pass over events -> per-resource aggregates, then a cheap
    // descendant sum per group; never O(rows x events)
    const perResource = new Map<
      string,
      { weighted: number; total: number; saw: boolean }
    >()
    for (const ev of allEvents) {
      if (!ev.resourceId) continue
      let agg = perResource.get(ev.resourceId)
      if (!agg) {
        agg = { weighted: 0, total: 0, saw: false }
        perResource.set(ev.resourceId, agg)
      }
      const dur = Math.max(ev.end.getTime() - ev.start.getTime(), 1)
      agg.total += dur
      if (typeof ev.progress === "number") {
        agg.saw = true
        agg.weighted += ev.progress * dur
      }
    }
    const map = new Map<string, number | null>()
    for (const row of rows) {
      if (!row.isGroup) continue
      let weighted = 0
      let weightTotal = 0
      let saw = false
      for (const id of descendantIds.get(row.resource.id) ?? []) {
        const agg = perResource.get(id)
        if (!agg) continue
        weightTotal += agg.total
        if (agg.saw) {
          saw = true
          weighted += agg.weighted
        }
      }
      map.set(
        row.resource.id,
        saw && weightTotal > 0
          ? Math.min(Math.max(Math.round(weighted / weightTotal), 0), 100)
          : null
      )
    }
    return map
  }, [rows, allEvents, descendantIds])

  // Lane memory across layout passes, keyed by getLaneKey (event identity,
  // NOT the time-stamped occurrence key). It stores the TIMES alongside the
  // lane so the packer can tell the schedule the user just edited apart from
  // the ones that sat still: untouched schedules keep their lane, the edited
  // one re-seeks. Written during the memo below on purpose: the pass is
  // idempotent - feeding its own output back in produces the same assignment -
  // so a StrictMode double render is a no-op.
  const laneMemory = useRef(new Map<string, GanttLaneMemo>())

  const baseRowBars = useMemo(() => {
    const map = new Map<string, TimelineRowBars>()
    // read the lanes the previous pass settled on, write the ones this pass
    // settles on; rebuilding (not mutating) prunes schedules that are gone
    const previousLanes = laneMemory.current
    const nextLanes = new Map<string, GanttLaneMemo>()
    const totalMin = (rangeEndMs - rangeStartMs) / 60000
    // one pass: occurrences grouped by resource, plus per-resource envelopes
    // for the parent rollups (never O(rows x occurrences))
    const byResource = new Map<string, GanttOccurrence[]>()
    const envelopes = new Map<string, { fromMin: number; toMin: number }>()
    for (const occ of occurrences) {
      const rid = occ.event.resourceId
      if (!rid) continue
      const list = byResource.get(rid)
      if (list) list.push(occ)
      else byResource.set(rid, [occ])
      const fromMin = Math.max((occ.start.getTime() - rangeStartMs) / 60000, 0)
      const toMin = Math.min(
        (occ.end.getTime() - rangeStartMs) / 60000,
        totalMin
      )
      const env = envelopes.get(rid)
      if (!env) {
        envelopes.set(rid, { fromMin, toMin })
      } else {
        env.fromMin = Math.min(env.fromMin, fromMin)
        env.toMin = Math.max(env.toMin, toMin)
      }
    }
    for (const row of rows) {
      const mine = byResource.get(row.resource.id) ?? []
      const segments: GanttSegment[] = mine.map((occurrence) => ({
        occurrence,
        day: new Date(rangeStartMs),
        isStart: occurrence.start.getTime() >= rangeStartMs,
        isEnd: occurrence.end.getTime() <= rangeEndMs,
        continuesBefore: occurrence.start.getTime() < rangeStartMs,
        continuesAfter: occurrence.end.getTime() > rangeEndMs,
        startMin: Math.max(
          (occurrence.start.getTime() - rangeStartMs) / 60000,
          0
        ),
        endMin: Math.min(
          (occurrence.end.getTime() - rangeStartMs) / 60000,
          totalMin
        ),
      }))
      const mode = "single"
      packTimedSegments(segments, { mode, preferredLanes: previousLanes })
      for (const segment of segments) {
        nextLanes.set(getLaneKey(segment.occurrence), {
          lane: segment.column ?? 0,
          startMs: segment.occurrence.start.getTime(),
          endMs: segment.occurrence.end.getTime(),
        })
      }
      const laneCount = segments.reduce(
        (max, segment) => Math.max(max, (segment.column ?? 0) + 1),
        1
      )
      let from = Infinity
      let to = -Infinity
      for (const segment of segments) {
        from = Math.min(from, (segment.startMin ?? 0) / totalMin)
        to = Math.max(to, (segment.endMin ?? 0) / totalMin)
      }

      // Parent rollup from the subtree's bars: envelope clamped to the range,
      // progress weighted by each bar's full duration
      let summary: TimelineRowBars["summary"] = null
      if (row.isGroup && segments.length === 0) {
        let sumFrom = Infinity
        let sumTo = -Infinity
        for (const id of descendantIds.get(row.resource.id) ?? []) {
          const env = envelopes.get(id)
          if (!env) continue
          sumFrom = Math.min(sumFrom, env.fromMin / totalMin)
          sumTo = Math.max(sumTo, env.toMin / totalMin)
        }
        if (sumTo > sumFrom) {
          summary = {
            from: sumFrom,
            to: sumTo,
            // all-time completion (matches a consumer's tree rollup), not the
            // visible-range slice - task progress is independent of scroll
            progress: subtreeProgress.get(row.resource.id) ?? null,
          }
        }
      }

      // The stack, then the row's own padding around it. Centering the block
      // in the resulting height gives an equal inset top and bottom, and it
      // is also what keeps a lone bar on the tree label's centerline when a
      // short row is held open by minRowHeight.
      const blockRem = laneCount * laneHeightRem + (laneCount - 1) * laneGapRem
      const heightRem = Math.max(minRowRem, blockRem + 2 * rowPaddingRem)
      const laneOffsetRem = (heightRem - blockRem) / 2

      map.set(row.resource.id, {
        segments,
        laneCount,
        heightRem,
        laneOffsetRem,
        bandRem: laneHeightRem + laneOffsetRem * 2,
        extent:
          segments.length > 0
            ? {
                from,
                to,
                color: segments[0]!.occurrence.event.color,
                label:
                  segments.length === 1
                    ? segments[0]!.occurrence.event.title
                    : settings.i18n.labels.events(segments.length),
                startMs: Math.min(
                  ...segments.map((s) => s.occurrence.start.getTime())
                ),
              }
            : summary
              ? {
                  from: summary.from,
                  to: summary.to,
                  label: row.resource.title,
                  startMs:
                    rangeStartMs + summary.from * (rangeEndMs - rangeStartMs),
                }
              : null,
        summary,
      })
    }
    laneMemory.current = nextLanes
    return map
  }, [
    rows,
    occurrences,
    rangeStartMs,
    rangeEndMs,
    settings.i18n,
    descendantIds,
    subtreeProgress,
    laneHeightRem,
    rowPaddingRem,
    laneGapRem,
    minRowRem,
  ])

  const treeConfig = { ...DEFAULT_TREE_PANEL, ...viewConfig.treePanel }
  const clampTree = (width: number) =>
    Math.min(Math.max(width, treeConfig.minWidth), treeConfig.maxWidth)
  const [treeWidth, setTreeWidth] = useState(treeConfig.width)
  const configuredTreeWidth = clampTree(treeWidth)
  const columns = viewConfig.columns ?? []

  // "Add task" hint at the foot of the tree, gated by validation
  const rowBars = baseRowBars

  // Responsive guard: the timeline must always keep a usable width, so on
  // narrow containers the tree pane yields down toward its minWidth. Measured
  // (not media-queried) because the gantt can live in any column. The -1
  // reserves the splitter hairline so the timeline truly keeps MIN width.
  const [containerWidth, setContainerWidth] = useState(0)
  const clampContainer = (width: number, container: number) => {
    if (container <= 0) return width
    const ceiling = container - minTimelineWidth - 1
    // The tree's own minWidth is a PREFERENCE, not a licence to squeeze the
    // timeline out of existence: cap it by what the container can actually
    // spare. Without this cap a consumer minWidth wider than the container
    // wins outright and the timeline collapses below minTimelineWidth with
    // the splitter already pinned, so the space cannot be dragged back.
    const floor = Math.min(treeConfig.minWidth, Math.max(ceiling, 0))
    return Math.max(Math.min(width, ceiling), Math.min(floor, container - 1))
  }
  const clampedTreeWidth = clampContainer(configuredTreeWidth, containerWidth)
  /** Live width while the splitter is dragging; render reads it so a
      mid-drag re-render can't snap the pane back to stale state. */
  const liveTreeWidthRef = useRef<number | null>(null)

  // Latest-value refs so the row handlers keep ONE identity across renders -
  // the row components are memoized and must not re-render per state change
  const viewConfigRef = useRef(viewConfig)
  viewConfigRef.current = viewConfig

  const bodyRef = useRef<HTMLDivElement | null>(null)
  const treePaneRef = useRef<HTMLDivElement | null>(null)
  const timelinePaneRef = useRef<HTMLDivElement | null>(null)
  const timelineBodyRef = useRef<HTMLDivElement | null>(null)
  const treeRowsRef = useRef<HTMLDivElement | null>(null)

  // Track the body width so the tree pane can yield on narrow containers.
  // Layout effect, not effect: the first measure must flush BEFORE the first
  // paint so a clamped tree width never paints wide for a frame and then
  // snaps - the panes are laid out final from the very first displayed frame.
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const update = () => setContainerWidth(body.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(body)
    return () => observer.disconnect()
  }, [])

  const beginSplit = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const pointerId = e.pointerId
    const startX = e.clientX
    const startWidth = clampedTreeWidth
    const splitter = e.currentTarget as HTMLElement
    // in RTL the tree pane sits on the right: pointer deltas invert
    const dir = getComputedStyle(splitter).direction === "rtl" ? -1 : 1
    splitter.setAttribute("data-resizing", "")
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    // Live width goes straight to the DOM: a React state write here would
    // re-render every row and bar per pointermove. State commits on release.
    // The container clamp applies live too - the timeline must not collapse
    // below its minimum mid-drag only to snap back on release.
    let liveWidth = startWidth
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      liveWidth = clampContainer(
        clampTree(startWidth + (ev.clientX - startX) * dir),
        bodyRef.current?.clientWidth ?? 0
      )
      liveTreeWidthRef.current = liveWidth
      if (treePaneRef.current) {
        treePaneRef.current.style.width = `${liveWidth}px`
      }
    }
    const finish = (ev?: PointerEvent) => {
      if (ev && ev.pointerId !== pointerId) return
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", finish)
      window.removeEventListener("pointercancel", finish)
      splitter.removeAttribute("data-resizing")
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      liveTreeWidthRef.current = null
      if (liveWidth !== startWidth) {
        setTreeWidth(liveWidth)
      }
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", finish)
    window.addEventListener("pointercancel", finish)
  }

  // Both panes scroll vertically; whichever moves drives the other.
  useEffect(() => {
    const treeViewport = getPaneViewport(treePaneRef.current)
    const timelineViewport = getPaneViewport(timelinePaneRef.current)
    if (!treeViewport || !timelineViewport) return
    const link = (source: HTMLElement, target: HTMLElement) => {
      // Mirror only when the source's own vertical position changed -
      // horizontal-only scroll events must not replay a stale scrollTop over
      // the other pane. Assign only on drift: the mirrored handler then
      // no-ops, so no loop.
      let lastTop = source.scrollTop
      const onScroll = () => {
        if (source.scrollTop === lastTop) return
        lastTop = source.scrollTop
        if (target.scrollTop !== source.scrollTop) {
          target.scrollTop = source.scrollTop
        }
      }
      source.addEventListener("scroll", onScroll)
      return () => source.removeEventListener("scroll", onScroll)
    }
    const unlinkTree = link(treeViewport, timelineViewport)
    const unlinkTimeline = link(timelineViewport, treeViewport)
    let unforward: (() => void) | null = null
    if (treeViewport.hasAttribute("data-gantt-native-scroll")) {
      // Native mode: the tree's vertical axis is overflow-hidden (its bar
      // would duplicate the timeline's), so vertical wheel intent forwards to
      // the timeline, which mirrors back through the link above. Horizontal
      // wheel intent stays native for the tree's own columns.
      const onWheel = (e: WheelEvent) => {
        // ctrl/cmd (and trackpad pinch, which sets ctrlKey) is the zoom
        // gesture; scrolling as well would move the rows out from under it
        if (e.ctrlKey || e.metaKey) return
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
        timelineViewport.scrollTop += dy
        e.preventDefault()
      }
      treeViewport.addEventListener("wheel", onWheel, { passive: false })
      unforward = () => treeViewport.removeEventListener("wheel", onWheel)
    } else {
      // Custom scrollbars: both panes are real vertical scrollers. The links
      // above mirror on the scroll event, which fires only AFTER the source
      // has already painted - so with compositor momentum (wheel/trackpad) the
      // active pane runs a frame ahead of the mirror and the two visibly drift
      // (the flicker). Fix: drive BOTH viewports from one wheel handler so they
      // move in the same frame, perfectly locked. Horizontal intent stays
      // native for each pane's own axis; the links still cover scrollbar drags,
      // keyboard, touch and programmatic scrolls; touch has no wheel events,
      // so flick-scrolling syncs through the (frame-lagged) link - accepted,
      // pointer drags are the gantt's primary touch interaction.
      const onWheel = (e: WheelEvent) => {
        // ctrl/cmd (and trackpad pinch, which sets ctrlKey) is the zoom
        // gesture; scrolling as well would move the rows out from under it
        if (e.ctrlKey || e.metaKey) return
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
        const max =
          timelineViewport.scrollHeight - timelineViewport.clientHeight
        if (max <= 0) return
        const unit =
          e.deltaMode === 1
            ? 16
            : e.deltaMode === 2
              ? timelineViewport.clientHeight
              : 1
        const next = Math.max(
          0,
          Math.min(max, timelineViewport.scrollTop + e.deltaY * unit)
        )
        e.preventDefault()
        timelineViewport.scrollTop = next
        treeViewport.scrollTop = next
      }
      treeViewport.addEventListener("wheel", onWheel, { passive: false })
      timelineViewport.addEventListener("wheel", onWheel, { passive: false })
      unforward = () => {
        treeViewport.removeEventListener("wheel", onWheel)
        timelineViewport.removeEventListener("wheel", onWheel)
      }
    }
    return () => {
      unlinkTree()
      unlinkTimeline()
      unforward?.()
    }
  }, [scale])

  // Linked row hover: mirror data-hover onto the row's twin in the other pane
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    let current: string | null = null
    const apply = (id: string | null) => {
      if (id === current) return
      if (current) {
        body
          .querySelectorAll(`[data-gantt-row-id="${CSS.escape(current)}"]`)
          .forEach((el) => el.removeAttribute("data-hover"))
      }
      if (id) {
        body
          .querySelectorAll(`[data-gantt-row-id="${CSS.escape(id)}"]`)
          .forEach((el) => el.setAttribute("data-hover", ""))
      }
      current = id
    }
    const onOver = (e: PointerEvent) => {
      const row = (e.target as HTMLElement | null)?.closest?.(
        "[data-gantt-row-id]"
      )
      apply(row?.getAttribute("data-gantt-row-id") ?? null)
    }
    const onLeave = () => apply(null)
    body.addEventListener("pointerover", onOver)
    body.addEventListener("pointerleave", onLeave)
    return () => {
      body.removeEventListener("pointerover", onOver)
      body.removeEventListener("pointerleave", onLeave)
      apply(null)
    }
  }, [])

  // Auto-manage the horizontal position for the current anchor until the user
  // scrolls: pre-buffer one period per side (so infinite scroll never resizes
  // the scrollbar on the first gesture), then center the target instant.
  // Idempotent - re-running just re-centers the same instant - so React
  // StrictMode's double-invoke and range-growth re-renders are both safe.
  const anchorMs = useGanttSelector((state) => state.date.getTime())
  // flattened to a primitive so an inline `initialCenter={new Date(...)}`
  // cannot re-run the centring effect on every render
  const initialCenter =
    viewConfig.initialCenter instanceof Date
      ? viewConfig.initialCenter.getTime()
      : viewConfig.initialCenter
  const manageRef = useRef({ key: "", buffered: false, userTook: false })
  useLayoutEffect(() => {
    const key = `${scale}:${anchorMs}`
    if (manageRef.current.key !== key) {
      // An anchor change from an extendRange window SLIDE continues the
      // user's own travel: the guard survives, or the pre-buffer branch
      // would re-extend and cascade further slides at the window cap.
      const slideContinuation =
        manageRef.current.userTook && instance.internals.didAnchorSlide()
      manageRef.current = slideContinuation
        ? { key, buffered: manageRef.current.buffered, userTook: true }
        : { key, buffered: false, userTook: false }
    }
    if (manageRef.current.userTook) return
    // Deferred-mount wait: when the viewport is not measurable yet (hidden
    // tab, display:none ancestor), a ResizeObserver resumes positioning on
    // the exact frame it gains a size - RO callbacks run in the rendering
    // steps BEFORE that frame paints, so no uncentered frame is ever shown.
    // (An rAF retry here would paint the range start first and then snap.)
    let waiter: ResizeObserver | null = null
    const run = () => {
      waiter?.disconnect()
      waiter = null
      const viewport = getPaneViewport(timelinePaneRef.current)
      const axis = viewport?.querySelector<HTMLElement>("[data-gantt-axis]")
      if (!viewport || !axis) return
      if (viewport.clientWidth === 0) {
        waiter = new ResizeObserver(() => {
          if (viewport.clientWidth > 0) run()
        })
        waiter.observe(viewport)
        return
      }
      // pre-buffer once; the re-run after the range grows lands the center
      extendLockRef.current = false
      if (viewport.scrollWidth <= viewport.clientWidth) return
      // read the clock at run time - the effect must not depend on a
      // reactive now that re-runs it (and the whole grid) every 30s.
      // Target now ONLY when the anchor period itself contains it: keying
      // on the whole (buffered) visible range would re-center prev/next
      // navigation right back onto today.
      let target: number
      target = initialCenter
      const fraction = Math.min(
        Math.max((target - rangeStartMs) / (rangeEndMs - rangeStartMs), 0),
        1
      )
      setScrollStart(
        viewport,
        Math.max(0, fraction * viewport.scrollWidth - viewport.clientWidth / 2)
      )
    }
    run()
    return () => {
      waiter?.disconnect()
    }
  }, [
    scale,
    anchorMs,
    initialCenter,
    rangeKey,
    rangeStartMs,
    rangeEndMs,
    instance,
  ])

  // Restoration is anchored to a TIMESTAMP, not pixel deltas: it survives
  // growth, window slides, and zoom changes alike.
  const pendingRestoreRef = useRef<{
    ms: number
    align: "start" | "center"
    /**
     * Park the anchored instant this many pixels from the viewport's inline
     * start instead of at the edge or the middle. Wheel zoom needs it so the
     * instant under the cursor stays under the cursor.
     */
    offsetPx?: number
  } | null>(null)
  const extendLockRef = useRef(false)
  const lastUserScrollRef = useRef(0)
  /** Fine-grained viewport-center instant, for controlled-zoom anchoring. */
  const fineCenterRef = useRef<number | null>(null)
  const lastZoomRef = useRef<number | null>(null)

  // Only user gestures may extend the range - programmatic scrolls (chip
  // jumps, auto-center, zoom clamping) must never grow it.
  useEffect(() => {
    const pane = timelinePaneRef.current
    if (!pane) return
    const markIntent = () => {
      lastUserScrollRef.current = performance.now()
    }
    // zooming is not scroll intent - the re-seat it triggers must not be
    // mistaken for the user reaching an edge and asking to grow the range
    const markWheelIntent = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return
      markIntent()
    }
    // pointerdown counts only where pressing can scroll: the scrollbars,
    // the pan header, or a native-scroll host - NOT bars, chips, or zoom
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null
      if (
        target?.closest(
          "[data-slot=scroll-area-scrollbar], [data-slot=gantt-timeline-header], [data-gantt-native-scroll]"
        )
      ) {
        markIntent()
      }
    }
    pane.addEventListener("wheel", markWheelIntent, { passive: true })
    pane.addEventListener("pointerdown", onPointerDown)
    pane.addEventListener("touchstart", markIntent, { passive: true })
    pane.addEventListener("keydown", markIntent)
    return () => {
      pane.removeEventListener("wheel", markWheelIntent)
      pane.removeEventListener("pointerdown", onPointerDown)
      pane.removeEventListener("touchstart", markIntent)
      pane.removeEventListener("keydown", markIntent)
    }
  }, [])

  // Report the visible-center instant so the nav title names what you are
  // looking at. Throttled to period boundaries (a coarse key) so scrolling
  // within a period never re-renders the grid.
  useEffect(() => {
    const viewport = getPaneViewport(timelinePaneRef.current)
    if (!viewport) return
    const keyFmt =
      scale === "day"
        ? "yyyy-MM-dd"
        : scale === "week"
          ? "RRRR-'W'II"
          : scale === "month"
            ? "yyyy-MM"
            : scale === "quarter"
              ? "yyyy-qqq"
              : "yyyy"
    let raf = 0
    let lastKey = ""
    const measure = () => {
      raf = 0
      const axis = viewport.querySelector<HTMLElement>("[data-gantt-axis]")
      const liveStart = Number(axis?.dataset.ganttRangeStart)
      const liveEnd = Number(axis?.dataset.ganttRangeEnd)
      if (!axis || Number.isNaN(liveStart) || Number.isNaN(liveEnd)) return
      const fraction =
        (getScrollStart(viewport) + viewport.clientWidth / 2) /
        Math.max(1, viewport.scrollWidth)
      const centerMs = liveStart + fraction * (liveEnd - liveStart)
      // fine center first (controlled-zoom anchor), then the coarse-keyed
      // store report that drives the nav title
      fineCenterRef.current = centerMs
      const center = new Date(centerMs)
      const key = format(toZoned(center, timeZone), keyFmt)
      if (key === lastKey) return
      lastKey = key
      instance.internals.setViewportCenter(center)
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    viewport.addEventListener("scroll", schedule)
    schedule()
    return () => {
      viewport.removeEventListener("scroll", schedule)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [instance, scale, timeZone, rangeKey])

  // Re-seat the viewport on its anchored instant before paint. Runs for range
  // growth, window slides, and zoom changes; a slide moves the anchor date,
  // so pre-mark auto-centering as done for the new key.
  useLayoutEffect(() => {
    // Consumer-driven (controlled) zoom changes carry no anchorZoomCenter
    // call; anchor them to the last known viewport center so the view does
    // not drift. Built-in buttons set pendingRestore first and win.
    if (
      lastZoomRef.current !== null &&
      lastZoomRef.current !== zoom &&
      !pendingRestoreRef.current &&
      fineCenterRef.current !== null
    ) {
      pendingRestoreRef.current = { ms: fineCenterRef.current, align: "center" }
    }
    lastZoomRef.current = zoom
    let raf: number | null = null
    let attempts = 0
    const seat = () => {
      raf = null
      const viewport = getPaneViewport(timelinePaneRef.current)
      if (viewport && pendingRestoreRef.current) {
        // Not laid out yet (0-width on first mount): centering with a 0 offset
        // parks the view a half-pane off. Defer until the pane is measured so
        // "center" lands the anchored instant in the middle on initial load.
        if (viewport.clientWidth === 0 && attempts++ < 20) {
          raf = requestAnimationFrame(seat)
          return
        }
        const { ms, align, offsetPx } = pendingRestoreRef.current
        pendingRestoreRef.current = null
        // clamp: a stale anchor (e.g. an ignored controlled-zoom proposal)
        // must never park the view outside the track
        const fraction = Math.min(
          Math.max((ms - rangeStartMs) / (rangeEndMs - rangeStartMs), 0),
          1
        )
        const offset =
          offsetPx ?? (align === "center" ? viewport.clientWidth / 2 : 0)
        setScrollStart(
          viewport,
          Math.max(0, fraction * viewport.scrollWidth - offset)
        )
      }
      extendLockRef.current = false
    }
    seat()
    return () => {
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [
    rangeKey,
    zoom,
    rangeStartMs,
    rangeEndMs,
    scale,
    instance,
  ])

  /** Keep the view centered on the same instant across a zoom step. */
  const anchorZoomCenter = () => {
    const viewport = getPaneViewport(timelinePaneRef.current)
    const axis = viewport?.querySelector<HTMLElement>("[data-gantt-axis]")
    if (!viewport || !axis) return
    const liveStart = Number(axis.dataset.ganttRangeStart)
    const liveEnd = Number(axis.dataset.ganttRangeEnd)
    if (Number.isNaN(liveStart) || Number.isNaN(liveEnd)) return
    pendingRestoreRef.current = {
      ms:
        liveStart +
        ((getScrollStart(viewport) + viewport.clientWidth / 2) /
          viewport.scrollWidth) *
          (liveEnd - liveStart),
      align: "center",
    }
  }

  /**
   * Keep the instant under the POINTER pinned across a zoom step. The buttons
   * anchor the viewport center, but a wheel or pinch gesture points at
   * something - zooming away from it reads as the content sliding out from
   * under the cursor.
   */
  const anchorZoomPointer = (clientX: number) => {
    const viewport = getPaneViewport(timelinePaneRef.current)
    const axis = viewport?.querySelector<HTMLElement>("[data-gantt-axis]")
    if (!viewport || !axis) return
    const liveStart = Number(axis.dataset.ganttRangeStart)
    const liveEnd = Number(axis.dataset.ganttRangeEnd)
    if (Number.isNaN(liveStart) || Number.isNaN(liveEnd)) return
    // trackPoint mirrors in RTL, where the range start is the right edge
    const offsetPx = trackPoint(viewport, clientX).offset
    pendingRestoreRef.current = {
      ms:
        liveStart +
        ((getScrollStart(viewport) + offsetPx) / viewport.scrollWidth) *
          (liveEnd - liveStart),
      align: "start",
      offsetPx,
    }
  }

  // The listener is manual and non-passive because it must preventDefault:
  // React's synthetic wheel handler cannot. It attaches once and reads the
  // live logic through a ref, so a zoom step never re-binds mid-gesture.
  const wheelZoomRef = useRef<((e: WheelEvent) => void) | null>(null)
  useEffect(() => {
    wheelZoomRef.current = (e: WheelEvent) => {
      // Browsers deliver a trackpad pinch as wheel + ctrlKey on every
      // platform; metaKey is the Mac keyboard idiom the same gesture implies.
      if (!e.ctrlKey && !e.metaKey) return
      const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
      // Continuous, not stepped: a pinch emits dozens of small deltas per
      // second, so the button's 0.25 step would slam to a limit instantly.
      // Exponential keeps each notch proportional at any zoom level.
      const next = clampZoom(zoom * Math.exp(-e.deltaY * lines * 0.002))
      // Already clamped: hand the gesture back so the browser's own page
      // zoom still works for anyone who relies on it.
      if (Math.abs(next - zoom) < 1e-4) return
      e.preventDefault()
      anchorZoomPointer(e.clientX)
      setZoomValue(+next.toFixed(4))
    }
  })
  useEffect(() => {
    const viewport = getPaneViewport(timelinePaneRef.current)
    if (!viewport) return
    const onWheel = (e: WheelEvent) => wheelZoomRef.current?.(e)
    viewport.addEventListener("wheel", onWheel, { passive: false })
    return () => viewport.removeEventListener("wheel", onWheel)
  }, [scale])

  // Drag-to-pan from the header (intent-based: activates after 4px)
  const beginHeaderPan = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const viewport = getPaneViewport(timelinePaneRef.current)
    if (!viewport) return
    const pointerId = e.pointerId
    const startX = e.clientX
    const startLeft = viewport.scrollLeft
    let active = false
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      const dx = ev.clientX - startX
      if (!active && Math.abs(dx) < 4) return
      active = true
      // panning is a user scroll: keep the infinite-scroll gate open
      lastUserScrollRef.current = performance.now()
      document.body.style.cursor = "grabbing"
      document.body.style.userSelect = "none"
      viewport.scrollLeft = startLeft - dx
    }
    const finish = (ev?: PointerEvent) => {
      if (ev && ev.pointerId !== pointerId) return
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", finish)
      window.removeEventListener("pointercancel", finish)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", finish)
    window.addEventListener("pointercancel", finish)
  }

  // Panning suppresses the placement hints (scroll intent, not create intent)

  const collapsedIdsRef = useRef(collapsedIds)
  collapsedIdsRef.current = collapsedIds
  // Stable identity (reads through refs) so memoized rows survive re-renders
  const onToggleRow = useCallback((row: TimelineRow) => {
    const current = collapsedIdsRef.current
    const next = current.includes(row.resource.id)
      ? current.filter((id) => id !== row.resource.id)
      : [...current, row.resource.id]
    if (viewConfigRef.current.collapsedGroups === undefined) {
      setInternalCollapsed(next)
    }
    viewConfigRef.current.onCollapsedGroupsChange?.(next)
  }, [])

  const loading = useGanttSelector<unknown, boolean>((state) => state.loading)
  const customScrollbars = true
  const gridLines = { vertical: "solid" as const, horizontal: "solid" as const }
  const showVerticalLines = gridLines.vertical !== null
  const offDayClassName = "bg-muted/40"
  // Body texture: default off-days carry a whisper-faint diagonal hatch over
  const offDayBodyClassName =
    "bg-muted/25 bg-[repeating-linear-gradient(135deg,transparent,transparent_5px,color-mix(in_oklab,var(--color-border)_35%,transparent)_5px,color-mix(in_oklab,var(--color-border)_35%,transparent)_6px)]"

  // Header-only unit lines, and ONE mechanism for every vertical line in the
  // header: positioned spans at calc(fraction% - 1px). A background gradient
  // rasterizes stripe positions differently from element layout at fractional
  // unit widths, which shifted the group-row boundaries 1px off the unit
  // lines below them mid-track - identical span formulas snap identically.
  // The body stays bare - rows separate by whitespace, never vertical borders.
  const showUnitLines = !uniform || showVerticalLines

  // Header label offset = the row cell's ps-3 (0.75rem) left gutter + the
  // collapse-toggle gutter (w-5 + me-1 = 1.5rem), so "Resources" lines up
  // with the row titles below it.
  const namePaddingStart = "2.25rem"
  const treeContent = (
    <div
      className={cn(
        "flex min-h-full w-max min-w-full flex-col",
        // clearance for the pinned horizontal scrollbar strip
        customScrollbars && "pb-2.5"
      )}
    >
      {/* Same 65px height as the two-row timeline header so the panes align.
          The head keeps its own bottom rule (under the Resources label), but
          the header/body boundary line is transparent so the first tree node
          has no rule directly above it - the 1px is kept only to preserve the
          65px height, matching the timeline. */}
      <div
        data-slot="gantt-tree-header"
        className="bg-background sticky top-0 z-30 box-content h-16 shrink-0 border-b border-b-transparent"
      >
        <div className="flex h-8 border-b">
          <div className="flex h-full min-w-0 flex-1">
            <div
              className="flex h-full shrink-0 items-center"
              style={{
                width: treeConfig.nameColumnWidth,
                paddingInlineStart: namePaddingStart,
              }}
            >
              <span className="text-muted-foreground truncate font-medium">
                {settings.i18n.labels.resources}
              </span>
            </div>
            {columns.map((column) => (
              <div
                key={column.id}
                data-slot="gantt-column-header"
                data-column={column.id}
                className={cn(
                  "text-muted-foreground flex h-full shrink-0 items-center px-2 font-medium",
                  column.align === "center" && "justify-center",
                  column.align === "end" && "justify-end",
                  column.className
                )}
                style={{ width: column.width ?? DEFAULT_COLUMN_WIDTH }}
              >
                <span className="truncate">{column.title ?? column.id}</span>
              </div>
            ))}
            <div className="min-w-0 flex-1" />
          </div>
        </div>
      </div>
      <div ref={treeRowsRef} className="flex flex-col">
            {rows.map((row) => (
              <GanttTreeRow
                key={row.resource.id}
                row={row}
                heightRem={rowBars.get(row.resource.id)?.heightRem ?? minRowRem}
                bandRem={rowBars.get(row.resource.id)?.bandRem ?? minRowRem}
                columns={columns}
                nameWidth={treeConfig.nameColumnWidth}
                dimmed={false}
                onToggle={onToggleRow}
              />
            ))}
      </div>
    </div>
  )

  const timelineContent = (
    <div
      className={cn(
        // grow (not just min-h-full) so the body reaches the bottom of the
        // pane: the columns then run the full height and the empty space
        // below the last row becomes pannable canvas instead of dead area
        "flex min-h-full w-max min-w-full grow flex-col",
        customScrollbars && "pb-2.5"
      )}
    >
      {/* Two-row grouped header; also the drag-to-pan surface */}
      <div
        data-slot="gantt-timeline-header"
        className="bg-background sticky top-0 z-30 shrink-0 border-b"
        style={{ minWidth: trackWidth }}
        onPointerDown={beginHeaderPan}
      >
        {/* group sectors; boundaries painted like the body lines */}
        <div className="relative h-8 border-b">
          <div className="flex h-full">
            {groups.map((group) => (
              <div
                key={group.key}
                data-slot="gantt-axis-group"
                // no `truncate` here: overflow-hidden would make this the
                // sticky label's scrollport and the stick would never fire
                className="text-muted-foreground flex min-w-0 items-center ps-3 pe-2"
                style={{ flex: `${group.span} 0 0px` }}
              >
                {/* Pure-CSS sticky: the label rides the leading edge for as
                  long as its own band is on screen, then the next band pushes
                  it out - so the day you are looking at always names itself.
                  The browser composites this; a scroll listener would run JS
                  on every frame to do worse. start-3 matches the cell's ps-3
                  so the gutter is identical parked or pinned. */}
                <span
                  data-slot="gantt-axis-group-label"
                  className="sticky start-3 max-w-full truncate"
                >
                  {group.label}
                </span>
              </div>
            ))}
          </div>
          {/* same span formula as the unit lines below: equal fractions get
              equal layout rounding, so the two rows' lines never drift apart */}
          {groupBoundaries.map((fraction) => (
            <span
              key={fraction}
              aria-hidden
              className="bg-border absolute inset-y-0 w-px"
              style={{ insetInlineStart: `calc(${fraction * 100}% - 1px)` }}
            />
          ))}
        </div>
        {/* units, engine axis = this row */}
        <div
          data-gantt-axis=""
          data-gantt-range-start={rangeStartMs}
          data-gantt-range-end={rangeEndMs}
          data-gantt-snap={snapMin}
          className="relative h-8"
        >
          {/* chrome underlay: off-day washes under the label layer */}
          <div aria-hidden className="absolute inset-0">
            {unitFractions.map(
              ({ unit, start, width }) =>
                unit.isOff && (
                  <span
                    key={unit.key}
                    className={cn("absolute inset-y-0", offDayClassName)}
                    style={{
                      insetInlineStart: `${start * 100}%`,
                      width: `${width * 100}%`,
                    }}
                  />
                )
            )}
          </div>
          <div className="flex h-full">
            {units.map((unit) => (
              <div
                key={unit.key}
                data-today={unit.isToday || undefined}
                data-off={unit.isOff || undefined}
                className={cn(
                  "flex min-w-0 items-center justify-center truncate px-1.5 text-center",
                  "text-muted-foreground",
                  unit.isToday && "text-primary font-medium"
                )}
                style={{ flex: `${unit.weight} 0 0px` }}
              >
                {/* today reads as a soft pill, not just tinted text */}
                {unit.isToday ? (
                  <span className="bg-primary/10 truncate rounded-full px-1.5 py-px">
                    {unit.label}
                  </span>
                ) : (
                  unit.label
                )}
              </div>
            ))}
          </div>
          {showUnitLines &&
            unitFractions.slice(1).map(({ unit, start }) => (
              <span
                key={unit.key}
                aria-hidden
                data-slot="gantt-grid-line"
                data-axis="vertical"
                className={cn(
                  "absolute inset-y-0 w-px",
                  // a dashed rule is a repeating gradient, not a border: the
                  // line is a 1px span, and border-dashed on a zero-width box
                  // paints nothing
                  "bg-border"
                )}
                style={{ insetInlineStart: `calc(${start * 100}% - 1px)` }}
              />
            ))}
          <GanttNowDot rangeStartMs={rangeStartMs} rangeEndMs={rangeEndMs} />
        </div>
      </div>
      {/* Rows over a shared backdrop (off days, today, boundaries, now);
          grows so the columns run to the bottom of the pane. Pressing anywhere
          here that is not a bar or a hint tile begins a scroll pan - the whole
          panel is a draggable canvas, not just the rows. */}
      <div
        ref={timelineBodyRef}
        className="relative flex min-h-0 grow flex-col"
        onPointerDown={beginHeaderPan}
      >
        {/* off-day / today / now backdrop only; vertical gridlines are
            per-row and reveal on selection, not painted here */}
        <div
          aria-hidden
          data-slot="gantt-timeline-backdrop"
          className="pointer-events-none absolute inset-0"
        >
          {unitFractions.map(({ unit, start, width }) => (
            <span key={unit.key} className="contents">
              {unit.isOff && (
                <span
                  data-off=""
                  className={cn("absolute inset-y-0", offDayBodyClassName)}
                  style={{
                    insetInlineStart: `${start * 100}%`,
                    width: `${width * 100}%`,
                  }}
                />
              )}
              {unit.isToday && scale !== "day" && (
                <span
                  data-today=""
                  className="bg-primary/5 absolute inset-y-0"
                  style={{
                    insetInlineStart: `${start * 100}%`,
                    width: `${width * 100}%`,
                  }}
                />
              )}
            </span>
          ))}
          {/* one layer for the whole body, not per row: the unit boundaries
            have to line up with the header's spans exactly, so both use the
            same fraction formula */}
          {gridLines.vertical !== null &&
            unitFractions
              .slice(1)
              .map(({ unit, start }) => (
                <span
                  key={`grid-${unit.key}`}
                  data-slot="gantt-grid-line"
                  data-axis="vertical"
                  className={cn(
                    "absolute inset-y-0 w-px",
                    "bg-border"
                  )}
                  style={{ insetInlineStart: `calc(${start * 100}% - 1px)` }}
                />
              ))}
          <GanttNowLine rangeStartMs={rangeStartMs} rangeEndMs={rangeEndMs} />
        </div>
        {rows.map((row) => (
          <GanttTimelineRow
            key={row.resource.id}
            row={row}
            bars={rowBars.get(row.resource.id)}
            rangeStartMs={rangeStartMs}
            rangeEndMs={rangeEndMs}
            trackWidth={trackWidth}
            trackRemWidth={trackRemWidth}
            rowBorder={gridLines.horizontal}
            laneHeightRem={laneHeightRem}
            laneGapRem={laneGapRem}
            minRowRem={minRowRem}
          />
        ))}
        {viewConfig.dependencyEdges &&
          viewConfig.dependencyEdges.length > 0 && (
            <GanttDependencyOverlay
              bodyRef={timelineBodyRef}
              edges={viewConfig.dependencyEdges}
              refreshKey={`${scale}:${rangeKey}:${zoom}:${rows.length}`}
            />
          )}
        {rows.length === 0 && viewConfig.renderNoResources && (
          <div
            data-slot="gantt-no-resources"
            className="text-muted-foreground flex grow items-center justify-center p-6 text-sm"
          >
            {viewConfig.renderNoResources()}
          </div>
        )}
      </div>
    </div>
  )

  const horizontalScrollbar = (
    <ScrollBar
      orientation="horizontal"
      // taller strip with vertical padding so the thumb is not crowded.
      // end-0 runs the strip (bg + top border) to the pane's right edge instead
      // of stopping short by the corner width - the vertical scrollbar is inset
      // to end above this strip, so nothing collides in the bottom-right corner.
      className="bg-background border-t-border! end-0! z-40 h-4! rounded-none py-1"
    />
  )

  const defaultProps = {
    "data-slot": "gantt-view",
    "data-scale": scale,
    "aria-busy": loading || undefined,
    className: cn(
      "flex min-h-0 flex-1 flex-col overflow-hidden",
      className
    ),
    children: (
      <div ref={bodyRef} className="relative flex min-h-0 flex-1">
        {/* Tree pane */}
        <div
          ref={treePaneRef}
          data-slot="gantt-tree-pane"
          className="relative h-full shrink-0"
          style={{ width: liveTreeWidthRef.current ?? clampedTreeWidth }}
        >
          {customScrollbars ? (
            // keyed by scale: Base UI measures overflow once per mount, and a
            // scale switch changes content without resizing the viewport
            <ScrollArea
              key={scale}
              className="h-full [&>[data-orientation=vertical]]:hidden"
            >
              <ScrollAreaPrimitive.Content>
                {treeContent}
              </ScrollAreaPrimitive.Content>
              {horizontalScrollbar}
            </ScrollArea>
          ) : (
            <div
              data-slot="scroll-area-viewport"
              data-gantt-native-scroll=""
              // vertical axis is DISPLAY-ONLY: the position is always
              // mirrored from the timeline, so no vertical scrollbar can
              // ever appear (overlay platforms included). Wheel deltas
              // forward to the timeline (see the sync effect); horizontal
              // column scrolling stays fully native.
              className="h-full overflow-x-auto overflow-y-hidden overscroll-contain"
            >
              {treeContent}
            </div>
          )}
          {/* Reserved horizontal-scrollbar rail: the tree usually has no
              horizontal overflow, so its real scrollbar never mounts and its
              bottom edge would sit higher than the timeline's pinned strip.
              This static rail fills that gutter (same 1rem height + top border)
              so the bottom strip reads as one continuous band across both
              panes; a real tree scrollbar (with columns) draws over it. */}
          {customScrollbars && (
            <div
              aria-hidden
              data-slot="gantt-tree-scrollbar-rail"
              className="bg-background border-t-border pointer-events-none absolute inset-x-0 bottom-0 h-4 border-t"
            />
          )}
        </div>
        {/* Splitter */}
        {treeConfig.resizable ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={settings.i18n.labels.resizePanel}
            aria-valuenow={Math.round(clampedTreeWidth)}
            // the EFFECTIVE floor, not the configured one: on a narrow
            // container the tree yields below its own minWidth to keep the
            // timeline usable, and valuenow must never fall outside the range
            aria-valuemin={Math.round(
              Math.min(treeConfig.minWidth, clampedTreeWidth)
            )}
            aria-valuemax={Math.round(
              Math.max(treeConfig.maxWidth, clampedTreeWidth)
            )}
            tabIndex={0}
            data-slot="gantt-splitter"
            className={cn(
              "group/gantt-splitter bg-border hover:bg-primary/60 data-resizing:bg-primary relative z-30 w-px shrink-0 cursor-col-resize touch-none outline-none",
              "focus-visible:ring-ring/50 focus-visible:ring-2",
              "after:absolute after:inset-y-0 after:-start-1 after:-end-1"
            )}
            onPointerDown={beginSplit}
            onDoubleClick={() => {
              setTreeWidth(treeConfig.width)
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault()
                const dir =
                  getComputedStyle(e.currentTarget).direction === "rtl" ? -1 : 1
                const delta = (e.key === "ArrowLeft" ? -16 : 16) * dir
                const next = clampTree(clampedTreeWidth + delta)
                setTreeWidth(next)
              }
            }}
          >
            {/* grip pill: makes the hairline read as draggable on approach */}
            <span
              aria-hidden
              data-slot="gantt-splitter-grip"
              className="bg-primary/60 group-data-resizing/gantt-splitter:bg-primary absolute top-1/2 left-1/2 h-6 w-0.75 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-0 transition-opacity duration-150 group-hover/gantt-splitter:opacity-100 group-focus-visible/gantt-splitter:opacity-100 group-data-resizing/gantt-splitter:opacity-100"
            />
          </div>
        ) : (
          <div aria-hidden className="bg-border w-px shrink-0" />
        )}
        {/* Timeline pane */}
        <div
          ref={timelinePaneRef}
          data-slot="gantt-timeline-pane"
          className="relative h-full min-w-0 flex-1"
        >
          {(
            <div
              data-slot="gantt-zoom"
              className="bg-background absolute end-3 bottom-5 z-40 flex flex-col border shadow-sm"
            >
              {/* aria-disabled instead of disabled: the not-allowed cursor
                  must still show at the zoom limits */}
              <TooltipProvider delay={600} closeDelay={0} timeout={300}>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={settings.i18n.labels.zoomIn}
                        aria-disabled={!canZoomIn || undefined}
                        className="text-muted-foreground hover:text-foreground size-5! rounded-b-none aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent"
                        onClick={() => {
                          if (!canZoomIn) return
                          anchorZoomCenter()
                          setZoomValue(
                            +(zoom + 0.25).toFixed(2)
                          )
                        }}
                      />
                    }
                  >
                    <PlusIcon className="size-3" aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    {settings.i18n.labels.zoomIn}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={settings.i18n.labels.zoomOut}
                        aria-disabled={!canZoomOut || undefined}
                        className="text-muted-foreground hover:text-foreground size-5! rounded-t-none border-t aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent"
                        onClick={() => {
                          if (!canZoomOut) return
                          anchorZoomCenter()
                          setZoomValue(
                            +(zoom - 0.25).toFixed(2)
                          )
                        }}
                      />
                    }
                  >
                    <MinusIcon className="size-3" aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    {settings.i18n.labels.zoomOut}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          )}
          {customScrollbars ? (
            // The vertical scrollbar is inset into the body lane: it starts
            // below the sticky 65px two-row header (otherwise its top slides
            // behind the header and the thumb is clipped) and stops above the
            // pinned 16px horizontal strip. `!` overrides Base UI's inline
            // top/bottom; h-auto lets top+bottom define the track height so
            // the thumb is measured against the visible lane, not the full pane.
            <ScrollArea
              key={scale}
              className="h-full [&>[data-orientation=vertical]]:top-[65px]! [&>[data-orientation=vertical]]:bottom-4! [&>[data-orientation=vertical]]:h-auto!"
            >
              {/* A FLEX column, not a percentage: the content's own
                min-h-full would resolve against this box's auto height and
                collapse to nothing, which is why the columns used to stop at
                the last row and leave the rest of the pane dead space. As a
                flex parent it can hand the leftover height down instead. */}
              <ScrollAreaPrimitive.Content className="flex min-h-full flex-col">
                {timelineContent}
              </ScrollAreaPrimitive.Content>
              {horizontalScrollbar}
            </ScrollArea>
          ) : (
            <div
              data-slot="scroll-area-viewport"
              data-gantt-native-scroll=""
              className="h-full overflow-auto overscroll-contain"
            >
              {timelineContent}
            </div>
          )}
          {/* Reserved scrollbar rail - the twin of the tree rail. Keeps the
              bottom gutter present even when the real horizontal scrollbar is
              hidden (e.g. hover-reveal scrollbars at rest), so the strip reads
              as one continuous reserved band across both panes; the real
              scrollbar (z-40) draws over it when active. */}
          {customScrollbars && (
            <div
              aria-hidden
              data-slot="gantt-timeline-scrollbar-rail"
              className="bg-background border-t-border pointer-events-none absolute inset-x-0 bottom-0 h-4 border-t"
            />
          )}
          <GanttOffscreenChips
              paneRef={timelinePaneRef}
              occurrences={occurrences}
              locale={settings.locale}
              refreshKey={`${scale}:${rangeKey}:${zoom}:${rows.length}:${clampedTreeWidth}`}
            />
        </div>
        {loading && (
          <div
            data-slot="gantt-loading"
            className="bg-background/60 absolute inset-0 z-50 flex items-center justify-center"
          >
            <span className="text-muted-foreground animate-pulse text-sm">
              {settings.i18n.labels.loading}
            </span>
          </div>
        )}
      </div>
    ),
  }

  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(defaultProps, props),
  })
}

function GanttNowLine({
  rangeStartMs,
  rangeEndMs,
}: {
  rangeStartMs: number
  rangeEndMs: number
}) {
  const now = useNow()
  const ms = now.getTime()
  if (ms < rangeStartMs || ms >= rangeEndMs) return null
  const fraction = (ms - rangeStartMs) / (rangeEndMs - rangeStartMs)
  return (
    <div
      data-slot="gantt-now-indicator"
      // comet tail: solid at the cap, dissolving toward the bottom -
      // present without ruling a hard line through every row
      className="from-destructive/80 via-destructive/45 to-destructive/15 absolute inset-y-0 z-10 w-px bg-linear-to-b"
      style={{ insetInlineStart: `${fraction * 100}%` }}
    />
  )
}

function GanttNowDot({
  rangeStartMs,
  rangeEndMs,
}: {
  rangeStartMs: number
  rangeEndMs: number
}) {
  const now = useNow()
  const ms = now.getTime()
  if (ms < rangeStartMs || ms >= rangeEndMs) return null
  const fraction = (ms - rangeStartMs) / (rangeEndMs - rangeStartMs)
  return (
    <span
      aria-hidden
      data-slot="gantt-now-dot"
      className="bg-destructive absolute -bottom-0.75 z-10 size-1.5 -translate-x-1/2 rounded-full"
      style={{ insetInlineStart: `${fraction * 100}%` }}
    />
  )
}

const GanttTreeRow = memo(function GanttTreeRow({
  row,
  heightRem,
  bandRem,
  columns,
  nameWidth,
  dimmed,
  onToggle,
}: {
  row: TimelineRow
  heightRem: number
  bandRem: number
  columns: GanttColumn[]
  nameWidth: number
  dimmed: boolean
  onToggle: (row: TimelineRow) => void
}) {
  const viewConfig = useGanttViewConfig()
  const ctx = {
    resource: row.resource,
    depth: row.depth,
    isGroup: row.isGroup,
    collapsed: row.collapsed,
  }

  // A node with several schedules grows its row; "start" keeps the label and
  // its columns on the FIRST schedule's baseline instead of floating them to
  // the middle of a tall row. Every cell's inner box is minRowHeight tall, so
  // a single-lane row renders identically either way.
  const alignStart = false

  const rowNode = (
    <div
      data-slot="gantt-row-group"
      data-gantt-row-id={row.resource.id}
      className={cn(
        "group/gantt-row data-hover:bg-muted/40 flex border-b",
        dimmed && "opacity-50"
      )}
      style={{ height: `${heightRem}rem` }}
    >
      <div className="flex h-full w-full min-w-0">
        {/* In-flow name cell: the whole tree row scrolls horizontally as one;
          row-level hover/selected tints show through the transparent cell */}
        <div
          data-slot="gantt-tree-cell"
          className={cn(
            // ps-3 keeps the row toggles off the left edge (kept in sync with
            // namePaddingStart above so headers stay aligned with row titles)
            "flex shrink-0 ps-3 pe-3",
            alignStart ? "items-start" : "items-center",
            row.isGroup && "font-medium"
          )}
          style={{ width: nameWidth }}
        >
          {/* exactly the band the first schedule occupies: same height, both
            top-anchored, so the label and that schedule share a centerline */}
          <div
            className="flex w-full min-w-0 items-center"
            style={{ height: `${bandRem}rem` }}
          >
            {/* per-level indent keeps sibling titles on one x */}
            <span
              aria-hidden
              className="shrink-0"
              style={{ width: `${row.depth * 0.875}rem` }}
            />
            {/* Fixed collapse-toggle gutter keeps titles aligned by level. */}
            <span className="me-1 flex w-5 shrink-0 items-center justify-start">
              {row.isGroup ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-expanded={!row.collapsed}
                  aria-label={row.resource.title}
                  className={cn(
                    "size-5! aria-expanded:bg-transparent!",
                    row.collapsed
                      ? "text-foreground"
                      : "text-muted-foreground aria-expanded:text-muted-foreground! hover:text-foreground!"
                  )}
                  onClick={() => onToggle(row)}
                >
                  <CaretRightIcon className={cn(
                                                        "size-3.5 transition-transform",
                                                        !row.collapsed && "rotate-90"
                                                      )} aria-hidden="true" />
                </Button>
              ) : null}
            </span>
            {viewConfig.renderResourceLabel?.(ctx) ?? (
              <span className="truncate">{row.resource.title}</span>
            )}
          </div>
        </div>
        {columns.map((column) => (
          <div
            key={column.id}
            data-slot="gantt-tree-column-cell"
            data-column={column.id}
            className={cn(
              "flex shrink-0 px-2",
              alignStart ? "items-start" : "items-center",
              column.className
            )}
            style={{ width: column.width ?? DEFAULT_COLUMN_WIDTH }}
          >
            <div
              className={cn(
                "flex w-full min-w-0 items-center",
                column.align === "center" && "justify-center",
                column.align === "end" && "justify-end"
              )}
              style={{ height: `${bandRem}rem` }}
            >
              {column.render?.(ctx)}
            </div>
          </div>
        ))}
        <div className="min-w-0 flex-1" />
      </div>
    </div>
  )

  return rowNode
})

const GanttTimelineRow = memo(function GanttTimelineRow({
  row,
  bars,
  rangeStartMs,
  rangeEndMs,
  trackWidth,
  trackRemWidth,
  rowBorder,
  laneHeightRem,
  laneGapRem,
  minRowRem,
}: {
  row: TimelineRow
  bars: TimelineRowBars | undefined
  rangeStartMs: number
  rangeEndMs: number
  trackWidth: string
  trackRemWidth: number
  rowBorder: "solid" | "dashed" | null
  laneHeightRem: number
  laneGapRem: number
  minRowRem: number
}) {
  const viewConfig = useGanttViewConfig()
  const segments = bars?.segments ?? []
  const heightRem = bars?.heightRem ?? minRowRem
  const laneCount = bars?.laneCount ?? 1
  const singleTrack = true
  // shared with the tree pane so the two can never drift apart
  const laneOffsetRem = bars?.laneOffsetRem ?? (minRowRem - laneHeightRem) / 2

  const fractionOf = (ms: number) =>
    Math.min(Math.max((ms - rangeStartMs) / (rangeEndMs - rangeStartMs), 0), 1)

  return (
    <div
      data-gantt-row=""
      data-gantt-resource={row.resource.id}
      data-gantt-row-id={row.resource.id}
      data-gantt-bar-min={bars?.extent?.from}
      data-gantt-bar-max={bars?.extent?.to}
      data-gantt-bar-color={bars?.extent?.color}
      data-gantt-bar-label={bars?.extent?.label}
      data-gantt-bar-start-ms={bars?.extent?.startMs}
      className={cn(
        "relative w-full min-w-0",
        // horizontal separators mirror the tree node borders across panes.
        // No special case for the last row: the columns run the full height of
        // the pane, so the grid closes on the container edge on its own.
        rowBorder !== null && "border-b",
        rowBorder === "dashed" && "border-dashed"
      )}
      style={{
        height: `${heightRem}rem`,
        minWidth: trackWidth,
      }}
    >
      {/* Row content (bars and labels). Pointer-transparent so
          empty-track presses still hit the row itself.
          content-visibility lets the browser skip rendering this layer for
          rows scrolled out of view (large trees stay cheap on low-end
          devices). Safe here: the layer is absolute inset-0 (geometry comes
          from the row, never from content), its paint containment keeps it
          a stacking context, and nothing inside escapes the row box - the
          Browsers without support simply ignore it. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ contentVisibility: "auto" }}
      >
        {segments.map((segment, segmentIndex) => {
          const from = fractionOf(
            rangeStartMs + (segment.startMin ?? 0) * 60000
          )
          const to = fractionOf(rangeStartMs + (segment.endMin ?? 0) * 60000)
          if (to <= from) return null
          const lane = segment.column ?? 0
          // Title placement: outside beside the bar when configured (or too
          // short in "auto"), flipped before the bar near the range end, and
          // back inside when the bar spans the whole view.
          const barRemWidth = (to - from) * trackRemWidth
          const wantsOutside = barRemWidth < AUTO_LABEL_MIN_REM
          const placement = !wantsOutside
            ? "inside"
            : to <= 0.92
              ? "after"
              : from >= 0.08
                ? "before"
                : "inside"
          // the wrapper carries the drag kind itself (from the row's ghost
          // state, same notify as the bar's own attribute) so the hide rules
          // below use plain attribute selectors instead of :has(), which
          // older Firefox (<121) does not support
          return (
            <div
              key={segment.occurrence.key}
              // lane position is headless state: a consumer can read it to
              // label the bar ("2 of 4") or drive its own manage UI
              data-lane={lane}
              data-lane-count={laneCount}
              // during a MOVE the whole thing (bar + its outside label) hides so
              // the smooth clone carries both; resize keeps the BAR as a faint
              // placeholder but its label yields to the ghost's outside label.
              // pointer-events-auto: the parent mask layer is pointer-
              // transparent so empty-track presses reach the row.
              // px-px keeps back-to-back bars off each other; the vertical
              // breathing room is the lane gap itself, not padding here, so
              // the bar is exactly laneHeight tall
              className="group/gantt-seg absolute px-px"
              // insetInlineStart, not left: in RTL the axis mirrors and bars
              // must mirror with it (fractions measure from the range start)
              style={{
                insetInlineStart: `${from * 100}%`,
                width: `${Math.max((to - from) * 100, 0.5)}%`,
                top: `${laneOffsetRem + lane * (laneHeightRem + laneGapRem)}rem`,
                height: `${laneHeightRem}rem`,
                // one track means every lane is 0, so paint order (not the
                // lane) is what keeps overlapping bars individually reachable
                zIndex:
                  segment.occurrence.event.zIndex ??
                  10 + (singleTrack ? segmentIndex : lane),
              }}
            >
              <GanttBar
                segment={segment}
                labelOutside={placement !== "inside"}
                rowTitle={row.resource.title}
                className="h-full"
              />
              {placement !== "inside" && (
                <span
                  data-slot="gantt-bar-label"
                  data-placement={placement}
                  className={cn(
                    "text-foreground pointer-events-none absolute top-1/2 z-10 max-w-60 -translate-y-1/2 truncate font-medium",
                    placement === "after" ? "start-full ms-2" : "end-full me-2"
                  )}
                >
                  {segment.occurrence.event.title}
                </span>
              )}
            </div>
          )
        })}
        {bars?.summary && segments.length === 0 && (
          <div
            data-slot="gantt-summary"
            aria-hidden
            className="pointer-events-none absolute top-1/2 -translate-y-1/2"
            style={{
              insetInlineStart: `${bars.summary.from * 100}%`,
              width: `${Math.max((bars.summary.to - bars.summary.from) * 100, 0.5)}%`,
            }}
          >
            {viewConfig.renderSummary ? (
              // consumer-owned rollup: the positioned envelope wrapper stays
              viewConfig.renderSummary({
                resource: row.resource,
                start: new Date(
                  rangeStartMs + bars.summary.from * (rangeEndMs - rangeStartMs)
                ),
                end: new Date(
                  rangeStartMs + bars.summary.to * (rangeEndMs - rangeStartMs)
                ),
                progress: bars.summary.progress,
              })
            ) : (
              <>
                {/* envelope end caps: the classic PM rollup silhouette, muted */}
                <span
                  aria-hidden
                  className="bg-muted-foreground/50 absolute start-0 top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-full"
                />
                <span
                  aria-hidden
                  className="bg-muted-foreground/50 absolute end-0 top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-full"
                />
                <div className="bg-muted-foreground/20 relative h-1.5 overflow-hidden rounded-full">
                  {bars.summary.progress !== null && (
                    <div
                      data-slot="gantt-summary-progress"
                      className="bg-muted-foreground/50 absolute inset-y-0 start-0 rounded-full"
                      style={{ width: `${bars.summary.progress}%` }}
                    />
                  )}
                </div>
                {bars.summary.progress !== null && (
                  <span className="text-muted-foreground absolute start-full top-1/2 ms-2 -translate-y-1/2 whitespace-nowrap">
                    {bars.summary.progress}%
                  </span>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
})

interface OffscreenChip {
  id: string
  side: "start" | "end"
  top: number
  color?: string
  label: string
  startMs: number | null
  target: number
  insetEnd: number
}

function sameChips(a: OffscreenChip[], b: OffscreenChip[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (chip, i) =>
        chip.id === b[i]!.id &&
        chip.side === b[i]!.side &&
        chip.top === b[i]!.top &&
        chip.target === b[i]!.target &&
        chip.insetEnd === b[i]!.insetEnd
    )
  )
}

function GanttOffscreenChips({
  paneRef,
  occurrences,
  locale,
  refreshKey,
}: {
  paneRef: RefObject<HTMLDivElement | null>
  occurrences: GanttOccurrence[]
  locale?: Locale
  refreshKey: string
}) {
  const settings = useGanttSettings()
  const [chips, setChips] = useState<OffscreenChip[]>([])

  useEffect(() => {
    const pane = paneRef.current
    const viewport = getPaneViewport(pane)
    if (!pane || !viewport) return
    let raf = 0
    const measure = () => {
      raf = 0
      const paneRect = pane.getBoundingClientRect()
      const header = viewport.querySelector<HTMLElement>(
        "[data-slot=gantt-timeline-header]"
      )
      const headerBottom = header
        ? header.getBoundingClientRect().bottom - paneRect.top
        : 0
      const trackW = viewport.scrollWidth
      const visibleStart = getScrollStart(viewport)
      const visibleEnd = visibleStart + viewport.clientWidth
      // the floating zoom control shares the right edge (higher z); end chips
      // whose row center falls in its band shift left so they stay clickable
      const zoomEl = pane.querySelector<HTMLElement>("[data-slot=gantt-zoom]")
      const zoom = zoomEl
        ? {
            top: zoomEl.getBoundingClientRect().top - paneRect.top - 8,
            bottom: zoomEl.getBoundingClientRect().bottom - paneRect.top + 8,
            inset: paneRect.right - zoomEl.getBoundingClientRect().left + 8,
          }
        : null
      const next: OffscreenChip[] = []
      for (const rowEl of viewport.querySelectorAll<HTMLElement>(
        "[data-gantt-row]"
      )) {
        const from = parseFloat(rowEl.dataset.ganttBarMin ?? "")
        const to = parseFloat(rowEl.dataset.ganttBarMax ?? "")
        if (Number.isNaN(from) || Number.isNaN(to)) continue
        const rect = rowEl.getBoundingClientRect()
        const top = rect.top - paneRect.top + rect.height / 2
        if (top < headerBottom + 10 || top > paneRect.height - 16) continue
        const startPx = from * trackW
        const endPx = to * trackW
        const startMs = parseFloat(rowEl.dataset.ganttBarStartMs ?? "")
        const base = {
          id: rowEl.dataset.ganttRowId ?? "",
          top: Math.round(top),
          color: rowEl.dataset.ganttBarColor,
          label: rowEl.dataset.ganttBarLabel ?? "",
          startMs: Number.isNaN(startMs) ? null : startMs,
        }
        if (endPx <= visibleStart + 2) {
          next.push({
            ...base,
            side: "start",
            target: startPx - 24,
            insetEnd: 14,
          })
        } else if (startPx >= visibleEnd - 2) {
          const overlapsZoom = zoom && top >= zoom.top && top <= zoom.bottom
          next.push({
            ...base,
            side: "end",
            target: endPx - viewport.clientWidth + 24,
            insetEnd: overlapsZoom ? Math.max(14, zoom.inset) : 14,
          })
        }
      }
      setChips((prev) => (sameChips(prev, next) ? prev : next))
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    viewport.addEventListener("scroll", schedule)
    const observer = new ResizeObserver(schedule)
    observer.observe(viewport)
    schedule()
    return () => {
      viewport.removeEventListener("scroll", schedule)
      observer.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [paneRef, occurrences, refreshKey])

  if (chips.length === 0) return null

  const scrollTo = (chip: OffscreenChip) => {
    const viewport = getPaneViewport(paneRef.current)
    if (!viewport) return
    const target = Math.max(0, chip.target)
    viewport.scrollTo({
      // chip targets are distances from the inline start; RTL signs them
      left: getComputedStyle(viewport).direction === "rtl" ? -target : target,
      behavior: "smooth",
    })
    // hand keyboard focus to the bar the chip promised (the chip unmounts)
    const bar = viewport.querySelector<HTMLElement>(
      `[data-gantt-row-id="${CSS.escape(chip.id)}"] [data-slot=gantt-bar]`
    )
    bar?.focus({ preventScroll: true })
  }

  return (
    <div
      data-slot="gantt-offscreen-chips"
      className="pointer-events-none absolute inset-0 z-30 overflow-hidden"
    >
      <TooltipProvider delay={600} closeDelay={0} timeout={300}>
        {chips.map((chip) => (
          <Tooltip key={`${chip.id}-${chip.side}`}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  data-slot="gantt-offscreen-chip"
                  data-side={chip.side}
                  aria-label={settings.i18n.labels.jumpToBar(chip.label)}
                  className="bg-background text-muted-foreground hover:text-foreground pointer-events-auto absolute flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border shadow-xs"
                  style={{
                    top: chip.top,
                    ...(chip.side === "start"
                      ? { insetInlineStart: "0.5rem" }
                      : { insetInlineEnd: chip.insetEnd }),
                  }}
                  onClick={() => scrollTo(chip)}
                />
              }
            >
              {chip.side === "start" ? (
                <CaretLeftIcon className="size-3" aria-hidden="true" />
              ) : (
                <CaretRightIcon className="size-3" aria-hidden="true" />
              )}
              <span
                aria-hidden
                className="ring-background absolute -end-px -top-px size-1.5 rounded-full ring-1"
                style={{ background: chip.color ?? "var(--color-primary)" }}
              />
            </TooltipTrigger>
            <TooltipContent side={chip.side === "start" ? "right" : "left"}>
              <div className="font-medium">{chip.label}</div>
              {chip.startMs !== null && (
                <div className="opacity-80">
                  {/* zoned: the chip must name the same day the grid shows */}
                  {format(
                    toZoned(new Date(chip.startMs), settings.timeZone),
                    "MMM d, yyyy",
                    { locale }
                  )}
                </div>
              )}
            </TooltipContent>
          </Tooltip>
        ))}
      </TooltipProvider>
    </div>
  )
}

export { GanttView }
