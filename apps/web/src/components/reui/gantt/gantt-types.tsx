type GanttBarId = string

/** Horizontal time scale of the gantt axis. */
type GanttScale = "day" | "week" | "month" | "quarter" | "year"

/**
 * One node of the gantt tree: a generic item that carries a title, consumer
 * columns, and zero or more schedules. It is not domain-bound - the same node
 * expresses a task (one schedule) or a resource lane (many). Nesting via
 * children renders as collapsible groups.
 */
interface GanttResource {
  id: string
  title: string
  /** Token or css color used for subtle row/column accents. */
  color?: string
  children?: GanttResource[]
}

interface GanttDateRange {
  /** Inclusive instant. */
  start: Date
  /** Exclusive instant. */
  end: Date
}

interface GanttEvent<TData = unknown> {
  id: GanttBarId
  title: string
  /** Plain instant; consumers parse ISO strings themselves. */
  start: Date
  /** Exclusive; must be >= start. */
  end: Date
  allDay?: boolean
  /** Token or css color; flows to the --gantt-event-color css var. */
  color?: string
  /** Packing prominence; feeds getEventPriority ordering. */
  priority?: number
  /** Completion 0-100; renders as a subtle fill inside the bar. */
  progress?: number
  /** Explicit stacking override; wins over the computed z. */
  zIndex?: number
  /** Resource row this bar belongs to. */
  resourceId?: string
  /** Consumer payload, fully generic. */
  data?: TData
}

/** Read-only dependency connector between two resource rows. */
interface GanttDependencyEdge {
  fromId: string
  toId: string
  className?: string
}

interface GanttOccurrence<TData = unknown> {
  /** Stable per instance: `${event.id}::${startISO}`. */
  key: string
  eventId: GanttBarId
  event: GanttEvent<TData>
  start: Date
  end: Date
  allDay: boolean
}

interface GanttSegment<TData = unknown> {
  occurrence: GanttOccurrence<TData>
  /** Range-start reference instant of the segment's timeline slice. */
  day: Date
  isStart: boolean
  isEnd: boolean
  continuesBefore: boolean
  continuesAfter: boolean
  /** Minutes from the visible range start, clamped to the range. */
  startMin?: number
  endMin?: number
  /** Row lane packing: 0-based lane index within the node's row. */
  column?: number
  /** Lanes the node's row resolved to. */
  columnCount?: number
  columnSpan?: number
}

interface GanttState<TData = unknown> {
  /** Horizontal axis scale. */
  scale: GanttScale
  /** Anchor date. */
  date: Date
  /** Full rendered axis range - fetch remote data for THIS. */
  visibleRange: GanttDateRange
  /** The logical period (the month/week itself). */
  activeRange: GanttDateRange
  events: GanttEvent<TData>[]
  loading: boolean
  /**
   * Instant at the center of the scrolled viewport; the nav title follows it
   * so the header always names what you are looking at. null before the view
   * reports a position (falls back to the anchor date).
   */
  viewportCenter: Date | null
}

interface GanttRangeInfo {
  range: GanttDateRange
  activeRange: GanttDateRange
  scale: GanttScale
  date: Date
  timeZone: string
}

/**
 * Off-day marking (non-working days). `true` uses the defaults: weekends
 * with a muted background. Custom weekday sets, explicit dates, a predicate,
 * and a custom class are all supported; marked cells carry `data-off` for
 * CSS-selector customization.
 */
interface GanttOffDaysConfig {
  /** Weekday numbers treated as off (0 = Sunday). Default [0, 6]. */
  weekendDays?: number[]
  /** Additional explicit off dates (compared by day in the display zone). */
  dates?: Date[]
  /** Full custom predicate; runs in addition to weekendDays/dates. */
  isOffDay?: (day: Date) => boolean
  /** Marker classes; default "bg-muted/40". */
  className?: string
}

export type {
  GanttEvent,
  GanttDependencyEdge,
  GanttDateRange,
  GanttOccurrence,
  GanttOffDaysConfig,
  GanttRangeInfo,
  GanttResource,
  GanttSegment,
  GanttState,
  GanttScale,
}
