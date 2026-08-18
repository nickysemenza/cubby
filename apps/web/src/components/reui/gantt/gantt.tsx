"use client"

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import {
  mergeGanttI18n,
  type GanttI18nConfig,
  type GanttI18nOverrides,
} from "~/components/reui/gantt/gantt-i18n"
import {
  buildEventIndex,
  defaultEventOrder,
  eventsOverlap,
  getGanttDateRange,
  getRangeKey,
  stepGanttDate,
  toZoned,
  type GanttIndex,
  type WeekStartsOn,
} from "~/components/reui/gantt/gantt-lib"
import type {
  GanttDateRange,
  GanttDependencyEdge,
  GanttEvent,
  GanttOccurrence,
  GanttRangeInfo,
  GanttResource,
  GanttScale,
  GanttSegment,
  GanttState,
} from "~/components/reui/gantt/gantt-types"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import type { Locale } from "date-fns"

import { cn } from "~/lib/utils"

/** Infinite-scroll growth cap, in whole periods per side. */
const MAX_RANGE_WINDOW = 12

interface GanttCallbacks {
  onRangeChange?: (info: GanttRangeInfo) => void
  onScaleChange?: (scale: GanttScale) => void
  onDateChange?: (date: Date) => void
}

interface UseGanttStateOptions<TData = unknown> extends GanttCallbacks {
  events?: GanttEvent<TData>[]
  scale?: GanttScale
  defaultScale?: GanttScale
  date?: Date
  defaultDate?: Date
  loading?: boolean
  timeZone?: string
  locale?: Locale
  weekStartsOn?: WeekStartsOn
  i18n?: GanttI18nOverrides
  /**
   * Hard travel bounds for infinite scrolling; either side may be omitted
   * for unlimited travel in that direction.
   */
  rangeBounds?: { min?: Date; max?: Date }
  /**
   * Infinite-scroll growth cap in whole periods per side; past it the
   * anchor slides instead (DOM stays bounded). Default 12.
   */
  maxRangeWindow?: number
  /** Tree nodes of the gantt (GanttNode is the preferred type name). */
  resources?: GanttResource[]
  getEventPriority?: (event: GanttEvent<TData>) => number
  eventOrder?: (a: GanttOccurrence<TData>, b: GanttOccurrence<TData>) => number
}

/**
 * Resolved configuration: every UseGanttStateOptions field except the
 * controlled/uncontrolled state pairs, with defaults applied and i18n merged.
 * Read via ref semantics - callback identity changes never re-render the grid.
 */
interface GanttSettings<TData = unknown> extends GanttCallbacks {
  timeZone: string
  locale?: Locale
  weekStartsOn: WeekStartsOn
  i18n: GanttI18nConfig
  rangeBounds?: { min?: Date; max?: Date }
  maxRangeWindow?: number
  resources: GanttResource[]
  getEventPriority: (event: GanttEvent<TData>) => number
  eventOrder: (a: GanttOccurrence<TData>, b: GanttOccurrence<TData>) => number
}

interface GanttApi<TData = unknown> {
  next(): void
  prev(): void
  today(): void
  goTo(date: Date): void
  setScale(scale: GanttScale): void
  getEvents(): GanttEvent<TData>[]
  getOccurrences(range?: GanttDateRange): GanttOccurrence<TData>[]
  getVisibleRange(): GanttDateRange
  getActiveRange(): GanttDateRange
  /** TZDate in the gantt's display time zone. */
  toZoned(date: Date): Date
}

/** Cross-file plumbing for sibling view/interaction modules; not public API. */
interface GanttInternals<TData = unknown> {
  getIndex(): GanttIndex<TData>
  getSettingsVersion(): number
  /**
   * Grow visibleRange by whole periods for infinite scrolling; resets on
   * date/scale changes. Returns false once the growth cap is reached.
   */
  extendRange(direction: "before" | "after"): boolean
  /**
   * True when the LAST anchor-date change was an extendRange window slide
   * (not a navigation) - the view keeps its scroll guard across slides.
   */
  didAnchorSlide(): boolean
  /** View reports the visible-center instant (or null) for the nav title. */
  setViewportCenter(date: Date | null): void
}

interface GanttInstance<TData = unknown> {
  getState(): GanttState<TData>
  subscribe(listener: () => void): () => void
  api: GanttApi<TData>
  settings: GanttSettings<TData>
  internals: GanttInternals<TData>
}

function resolveSettings<TData>(
  options: UseGanttStateOptions<TData>
): GanttSettings<TData> {
  const {
    // strip state pairs; the rest flows into settings
    events: _e,
    scale: _v,
    defaultScale: _dv,
    date: _d,
    defaultDate: _dd,
    loading: _l,
    ...rest
  } = options
  const getEventPriority =
    options.getEventPriority ??
    ((event: GanttEvent<TData>) => event.priority ?? 0)
  return {
    ...rest,
    timeZone:
      options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: options.locale,
    // locale-first default: a de/fr locale gets Monday weeks without also
    // having to set weekStartsOn; an explicit weekStartsOn always wins
    weekStartsOn:
      options.weekStartsOn ?? options.locale?.options?.weekStartsOn ?? 0,
    i18n: mergeGanttI18n(options.i18n),
    rangeBounds: options.rangeBounds,
    resources: options.resources ?? [],
    getEventPriority,
    // priority-aware default: higher getEventPriority packs/orders first
    eventOrder:
      options.eventOrder ??
      ((a, b) =>
        getEventPriority(b.event) - getEventPriority(a.event) ||
        defaultEventOrder(a, b)),
  }
}

interface GanttStore<TData> {
  instance: GanttInstance<TData>
  setOptions(next: UseGanttStateOptions<TData>): boolean
  notify(): void
  emitRangeIfChanged(): void
}

function createGanttStore<TData>(
  initial: UseGanttStateOptions<TData>
): GanttStore<TData> {
  let options = initial
  let settings = resolveSettings(initial)
  let settingsVersion = 0

  const listeners = new Set<() => void>()

  const internal = {
    scale: initial.defaultScale ?? "day",
    date: initial.defaultDate ?? new Date(),
    /** Whole extra periods rendered on each side (infinite scroll). */
    rangeWindow: { before: 0, after: 0 },
    /** Visible-center instant reported by the view; drives the nav title. */
    viewportCenter: null as Date | null,
  }

  let snapshot: GanttState<TData> | null = null
  let indexCache: {
    events: GanttEvent<TData>[]
    rangeKey: string
    timeZone: string
    index: GanttIndex<TData>
  } | null = null
  let lastEmittedRangeKey: string | null = null
  /** Whether the last anchor change came from an extendRange window slide. */
  let lastAnchorChangeWasSlide = false

  const invalidate = () => {
    snapshot = null
  }

  const notify = () => {
    listeners.forEach((listener) => listener())
    emitRangeIfChanged()
  }

  const getState = (): GanttState<TData> => {
    if (snapshot) return snapshot
    const scale = options.scale ?? internal.scale
    const date = options.date ?? internal.date
    const rangeOpts = {
      timeZone: settings.timeZone,
      weekStartsOn: settings.weekStartsOn,
    }
    const { visibleRange: baseRange, activeRange } = getGanttDateRange(
      scale,
      date,
      rangeOpts
    )
    // Infinite scroll: widen by whole periods; the anchor period stays put
    const { before, after } = internal.rangeWindow
    let visibleRange = baseRange
    if (before > 0 || after > 0) {
      let earlier = date
      for (let i = 0; i < before; i++) {
        earlier = stepGanttDate(scale, earlier, -1, rangeOpts)
      }
      let later = date
      for (let i = 0; i < after; i++) {
        later = stepGanttDate(scale, later, 1, rangeOpts)
      }
      visibleRange = {
        start: getGanttDateRange(scale, earlier, rangeOpts).visibleRange.start,
        end: getGanttDateRange(scale, later, rangeOpts).visibleRange.end,
      }
    }
    snapshot = {
      scale,
      date,
      visibleRange,
      activeRange,
      events: options.events ?? [],
      loading: options.loading ?? false,
      viewportCenter: internal.viewportCenter,
    }
    return snapshot
  }

  const emitRangeIfChanged = () => {
    if (!settings.onRangeChange) return
    const state = getState()
    const key = `${state.scale}:${getRangeKey(state.visibleRange)}:${settings.timeZone}`
    if (key === lastEmittedRangeKey) return
    lastEmittedRangeKey = key
    settings.onRangeChange({
      range: state.visibleRange,
      activeRange: state.activeRange,
      scale: state.scale,
      date: state.date,
      timeZone: settings.timeZone,
    })
  }

  type ControlledKey =
    | "scale"
    | "date"
    | "events"

  const setField = <K extends ControlledKey>(
    key: K,
    value: GanttState<TData>[K extends "events" ? "events" : K]
  ) => {
    const controlled = options[key] !== undefined
    if (key === "date" || key === "scale") {
      // value-equal sets are no-ops: they must not touch store state (the
      // controlled path would mutate without notify) nor drop infinite-
      // scroll growth for a navigation that never happened
      const current = getState()[key]
      const same =
        key === "date"
          ? (current as Date).getTime() === (value as Date).getTime()
          : current === value
      if (same) return
      // navigating re-anchors the axis; drop any infinite-scroll growth and
      // let the title follow the anchor again until the user scrolls
      internal.rangeWindow = { before: 0, after: 0 }
      internal.viewportCenter = null
      lastAnchorChangeWasSlide = false
      invalidate()
    }
    if (!controlled) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(internal as any)[key] = value
      invalidate()
    }
    const callbacks: Partial<
      Record<ControlledKey, ((v: never) => void) | undefined>
    > = {
      scale: settings.onScaleChange as never,
      date: settings.onDateChange as never,
    }
    callbacks[key]?.(value as never)
    if (!controlled) notify()
  }

  const getIndex = (): GanttIndex<TData> => {
    const state = getState()
    const rangeKey = getRangeKey(state.visibleRange)
    if (
      indexCache &&
      indexCache.events === state.events &&
      indexCache.rangeKey === rangeKey &&
      indexCache.timeZone === settings.timeZone
    ) {
      return indexCache.index
    }
    const index = buildEventIndex(state.events, state.visibleRange, {
      timeZone: settings.timeZone,
      eventOrder: settings.eventOrder,
    })
    indexCache = {
      events: state.events,
      rangeKey,
      timeZone: settings.timeZone,
      index,
    }
    return index
  }

  /** Anchor clamp: navigation may never leave the configured bounds. */
  const clampToBounds = (date: Date): Date => {
    const bounds = settings.rangeBounds
    if (!bounds) return date
    if (bounds.min && date.getTime() < bounds.min.getTime()) return bounds.min
    if (bounds.max && date.getTime() > bounds.max.getTime()) return bounds.max
    return date
  }

  const api: GanttApi<TData> = {
    next() {
      const state = getState()
      setField(
        "date",
        clampToBounds(
          stepGanttDate(state.scale, state.date, 1, {
            timeZone: settings.timeZone,
          })
        )
      )
    },
    prev() {
      const state = getState()
      setField(
        "date",
        clampToBounds(
          stepGanttDate(state.scale, state.date, -1, {
            timeZone: settings.timeZone,
          })
        )
      )
    },
    today() {
      setField("date", clampToBounds(new Date()))
    },
    goTo(date) {
      setField("date", clampToBounds(date))
    },
    setScale(scale) {
      setField("scale", scale)
    },
    getEvents() {
      return getState().events
    },
    getOccurrences(range) {
      if (!range) return getIndex().occurrences
      const state = getState()
      const within =
        range.start >= state.visibleRange.start &&
        range.end <= state.visibleRange.end
      if (within) {
        return getIndex().occurrences.filter((occ) => eventsOverlap(occ, range))
      }
      return buildEventIndex(state.events, range, {
        timeZone: settings.timeZone,
        eventOrder: settings.eventOrder,
      }).occurrences
    },
    getVisibleRange() {
      return getState().visibleRange
    },
    getActiveRange() {
      return getState().activeRange
    },
    toZoned(date) {
      return toZoned(date, settings.timeZone)
    },
  }

  const internals: GanttInternals<TData> = {
    getIndex,
    setViewportCenter(date) {
      const prev = internal.viewportCenter
      if (prev?.getTime() === date?.getTime()) return
      internal.viewportCenter = date
      invalidate()
      notify()
    },
    getSettingsVersion() {
      return settingsVersion
    },
    extendRange(direction) {
      const state = getState()
      const bounds = settings.rangeBounds
      if (
        direction === "before" &&
        bounds?.min &&
        state.visibleRange.start.getTime() <= bounds.min.getTime()
      ) {
        return false
      }
      if (
        direction === "after" &&
        bounds?.max &&
        state.visibleRange.end.getTime() >= bounds.max.getTime()
      ) {
        return false
      }
      const cap = Math.max(1, settings.maxRangeWindow ?? MAX_RANGE_WINDOW)
      const { before, after } = internal.rangeWindow
      const grow = direction === "before" ? before < cap : after < cap
      if (grow) {
        internal.rangeWindow =
          direction === "before"
            ? { before: before + 1, after }
            : { before, after: after + 1 }
      } else {
        // window is at capacity: SLIDE the anchor one period instead, so
        // travel stays unbounded while the DOM stays bounded
        const next = stepGanttDate(
          state.scale,
          state.date,
          direction === "before" ? -1 : 1,
          {
            timeZone: settings.timeZone,
          }
        )
        if (options.date !== undefined) {
          // controlled anchor: propose the slide; nothing changes until the
          // parent adopts it
          settings.onDateChange?.(next)
          return false
        }
        internal.date = next
        lastAnchorChangeWasSlide = true
        settings.onDateChange?.(next)
      }
      invalidate()
      notify()
      return true
    },
    didAnchorSlide() {
      return lastAnchorChangeWasSlide
    },
  }

  const instance: GanttInstance<TData> = {
    getState,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    api,
    get settings() {
      return settings
    },
    internals,
  }

  const STATE_KEYS = [
    "scale",
    "date",
    "loading",
  ] as const
  const SETTINGS_KEYS = [
    "timeZone",
    "locale",
    "weekStartsOn",
    "i18n",
    "rangeBounds",
    "maxRangeWindow",
    "resources",
    "getEventPriority",
    "eventOrder",
  ] as const

  return {
    instance,
    setOptions(next) {
      const prev = options
      options = next
      // compare by value: a freshly constructed but equal controlled date
      // must not wipe infinite-scroll growth on every parent re-render
      if (
        prev.date?.getTime() !== next.date?.getTime() ||
        prev.scale !== next.scale
      ) {
        internal.rangeWindow = { before: 0, after: 0 }
        lastAnchorChangeWasSlide = false
      }
      let changed = false
      for (const key of STATE_KEYS) {
        if (prev[key] !== next[key]) {
          changed = true
          break
        }
      }
      let settingsChanged = false
      for (const key of SETTINGS_KEYS) {
        if (prev[key] !== next[key]) {
          settingsChanged = true
          break
        }
      }
      settings = resolveSettings(next)
      if (settingsChanged) {
        settingsVersion++
        changed = true
      }
      if (changed) invalidate()
      return changed
    },
    notify,
    emitRangeIfChanged,
  }
}

/**
 * Headless root hook - the full calendar engine without any markup.
 * Pass the returned instance to <Gantt calendar={instance}> or drive
 * fully custom UI from instance.getState()/subscribe/api.
 */
function useGanttState<TData = unknown>(
  options: UseGanttStateOptions<TData> = {}
): GanttInstance<TData> {
  const [store] = useState(() => createGanttStore<TData>(options))
  const changed = store.setOptions(options)
  const changedRef = useRef(false)
  if (changed) changedRef.current = true
  useLayoutEffect(() => {
    if (changedRef.current) {
      changedRef.current = false
      store.notify()
    }
  })
  useEffect(() => {
    store.emitRangeIfChanged()
    // mount-only: onRangeChange fires once for the initial range
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return store.instance
}

const GanttContext =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createContext<GanttInstance<any> | null>(null)

/** The stable calendar instance; throws outside <Gantt>. */
function useGantt<TData = unknown>(): GanttInstance<TData> {
  const instance = useContext(GanttContext)
  if (!instance) {
    throw new Error("useGantt must be used within <Gantt>")
  }
  return instance as GanttInstance<TData>
}

interface UseGanttSelectorOptions<TSelected> {
  isEqual?: (a: TSelected, b: TSelected) => boolean
}

/** Fine-grained subscription with equality memoization (Object.is default). */
function useGanttSelector<TData = unknown, TSelected = unknown>(
  selector: (state: GanttState<TData>) => TSelected,
  options?: UseGanttSelectorOptions<TSelected>
): TSelected {
  const instance = useContext(GanttContext)
  if (!instance) {
    throw new Error("useGanttSelector needs a <Gantt> ancestor")
  }
  const isEqual = options?.isEqual ?? Object.is
  const lastRef = useRef<{ value: TSelected } | null>(null)
  const selectorRef = useRef(selector)
  selectorRef.current = selector

  const getSnapshot = () => {
    const next = selectorRef.current(instance.getState() as GanttState<TData>)
    if (lastRef.current && isEqual(lastRef.current.value, next)) {
      return lastRef.current.value
    }
    lastRef.current = { value: next }
    return next
  }

  return useSyncExternalStore(instance.subscribe, getSnapshot, getSnapshot)
}

function useGanttScale(): {
  scale: GanttScale
  setScale: (scale: GanttScale) => void
} {
  const instance = useGantt()
  const scale = useGanttSelector((state) => state.scale)
  return { scale, setScale: instance.api.setScale }
}

function useGanttNavigation(): {
  date: Date
  /** i18n.functions.formatTitle output for the current view. */
  title: string
  visibleRange: GanttDateRange
  activeRange: GanttDateRange
  next: () => void
  prev: () => void
  today: () => void
  goTo: (date: Date) => void
  /** True when the anchor period contains now in the display time zone. */
  isToday: boolean
} {
  const instance = useGantt()
  const { settings } = instance
  const slice = useGanttSelector(
    (state) => ({
      date: state.date,
      scale: state.scale,
      visibleRange: state.visibleRange,
      activeRange: state.activeRange,
      viewportCenter: state.viewportCenter,
    }),
    {
      isEqual: (a, b) =>
        a.date.getTime() === b.date.getTime() &&
        a.scale === b.scale &&
        a.viewportCenter?.getTime() === b.viewportCenter?.getTime() &&
        getRangeKey(a.visibleRange) === getRangeKey(b.visibleRange),
    }
  )
  useGanttSettingsVersion(instance)
  const now = new Date()
  // The title names what you are LOOKING at: the visible-center period when
  // the view reports one, otherwise the anchor period.
  const titleDate = slice.viewportCenter ?? slice.date
  const titleActive = slice.viewportCenter
    ? getGanttDateRange(slice.scale, slice.viewportCenter, {
        timeZone: settings.timeZone,
        weekStartsOn: settings.weekStartsOn,
      }).activeRange
    : slice.activeRange
  return {
    date: slice.date,
    title: settings.i18n.functions.formatTitle(slice.scale, {
      date: toZoned(titleDate, settings.timeZone),
      activeRange: titleActive,
      visibleRange: slice.visibleRange,
      locale: settings.locale,
    }),
    visibleRange: slice.visibleRange,
    activeRange: slice.activeRange,
    next: instance.api.next,
    prev: instance.api.prev,
    today: instance.api.today,
    goTo: instance.api.goTo,
    isToday: now >= slice.activeRange.start && now < slice.activeRange.end,
  }
}

/** Subscribes to settings changes only (version counter, not state). */
function useGanttSettingsVersion<TData>(
  instance: GanttInstance<TData>
): number {
  return useSyncExternalStore(
    instance.subscribe,
    instance.internals.getSettingsVersion,
    instance.internals.getSettingsVersion
  )
}

/** Resolved settings incl. merged i18n; re-renders only when settings change. */
function useGanttSettings<TData = unknown>(): GanttSettings<TData> {
  const instance = useGantt<TData>()
  useGanttSettingsVersion(instance)
  return instance.settings
}

/** Row context handed to tree-panel column and label renderers. */
interface GanttColumnContext {
  resource: GanttResource
  depth: number
  isGroup: boolean
  collapsed: boolean
}

/** One extra tree-panel column after the built-in name column. */
interface GanttColumn {
  /** Stable id; doubles as the default header label. */
  id: string
  /** Header label. */
  title?: ReactNode
  /** Fixed column width in px. Default 96. */
  width?: number
  /** Cell content alignment. Default "start". */
  align?: "start" | "center" | "end"
  /** Cell content per row; omit or return null for an empty cell. */
  render?: (ctx: GanttColumnContext) => ReactNode
  /** Extra classes on every cell of this column (header included). */
  className?: string
}

/** Parent rollup handed to a custom summary renderer. */
interface GanttSummaryProps {
  resource: GanttResource
  start: Date
  end: Date
  progress: number | null
}

/** Left tree-panel sizing and splitter behavior. */
interface GanttTreePanelConfig {
  /** Initial panel width in px. Default 288. */
  width?: number
  /** Splitter lower bound in px. Default 180. */
  minWidth?: number
  /** Splitter upper bound in px. Default 640. */
  maxWidth?: number
  /** Drag/keyboard splitter between the panels. */
  resizable: boolean
  /** Width of the sticky name column in px. Default 208. */
  nameColumnWidth?: number
}

interface GanttRenderEventProps<TData = unknown> {
  occurrence: GanttOccurrence<TData>
  segment: GanttSegment<TData>
}

/**
 * View-layer configuration: display props and render overrides. These live on
 * <Gantt> (and per-view components), never in the headless options.
 */
interface GanttViewConfig<TData = unknown> {
  /** Where the project timeline opens. */
  initialCenter: Date
  /**
   * Extra tree-panel columns after the built-in name column. The tree panel
   * scrolls horizontally when the columns outgrow it; the name column stays
   * pinned.
   */
  columns?: GanttColumn[]
  /** Tree-panel width, splitter bounds, and resizability. */
  treePanel?: GanttTreePanelConfig
  /** Controlled collapsed group ids; pairs with onCollapsedGroupsChange. */
  collapsedGroups?: string[]
  onCollapsedGroupsChange?: (ids: string[]) => void
  /** Read-only connectors between visible resource rows. */
  dependencyEdges?: GanttDependencyEdge[]
  /** Extra classes on an event bar. */
  getEventClassName?: (props: GanttRenderEventProps<TData>) => string | undefined
  renderEvent?: (props: GanttRenderEventProps<TData>) => ReactNode
  /**
   * Tree-node label. Receives the resource with its tree position; return
   * any rich content (icons, badges). Default is the plain title.
   */
  renderResourceLabel?: (props: {
    resource: GanttResource
    depth: number
    isGroup: boolean
    collapsed: boolean
  }) => ReactNode
  /** Rendered in the timeline body when there are no resources. */
  renderNoResources?: () => ReactNode
  /** Replaces the parent rollup strip (the positioned wrapper stays gantt-owned). */
  renderSummary?: (props: GanttSummaryProps) => ReactNode
}

const DEFAULT_VIEW_CONFIG: GanttViewConfig = {
  initialCenter: new Date(0),
}

const GanttViewConfigContext = createContext<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  GanttViewConfig<any>
>(DEFAULT_VIEW_CONFIG)

/** Root-level display props + render overrides, for view components. */
function useGanttViewConfig<TData = unknown>(): GanttViewConfig<TData> {
  return useContext(GanttViewConfigContext)
}

const VIEW_CONFIG_KEYS: Array<keyof GanttViewConfig> = [
  "initialCenter",
  "columns",
  "treePanel",
  "collapsedGroups",
  "onCollapsedGroupsChange",
  "dependencyEdges",
  "getEventClassName",
  "renderEvent",
  "renderResourceLabel",
  "renderNoResources",
  "renderSummary",
]

interface GanttProps<TData = unknown>
  extends
    UseGanttStateOptions<TData>,
    Partial<GanttViewConfig<TData>>,
    Omit<useRender.ComponentProps<"div">, "children" | "defaultValue"> {
  children?: ReactNode
}

const OPTION_KEYS: Array<keyof UseGanttStateOptions> = [
  "events",
  "scale",
  "defaultScale",
  "date",
  "defaultDate",
  "loading",
  "timeZone",
  "locale",
  "weekStartsOn",
  "i18n",
  "rangeBounds",
  "maxRangeWindow",
  "resources",
  "getEventPriority",
  "eventOrder",
  "onRangeChange",
  "onScaleChange",
  "onDateChange",
]

function shallowEqualRecord(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  for (const key of aKeys) {
    if (!Object.is(a[key], b[key])) return false
  }
  return true
}

function splitOptions<TData>(props: Record<string, unknown>): {
  options: UseGanttStateOptions<TData>
  viewConfig: GanttViewConfig<TData>
  rest: Record<string, unknown>
} {
  const options: Record<string, unknown> = {}
  const viewConfig: Record<string, unknown> = { ...DEFAULT_VIEW_CONFIG }
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(props)) {
    if ((OPTION_KEYS as string[]).includes(key)) options[key] = value
    else if ((VIEW_CONFIG_KEYS as string[]).includes(key)) {
      if (value !== undefined) viewConfig[key] = value
    } else rest[key] = value
  }
  return {
    options: options as UseGanttStateOptions<TData>,
    viewConfig: viewConfig as unknown as GanttViewConfig<TData>,
    rest,
  }
}

/**
 * Root provider + container. Composition contract:
 * <Gantt><GanttNav/><GanttToolbar/><GanttView/></Gantt>
 */
function Gantt<TData = unknown>({
  className,
  render,
  children,
  ...props
}: GanttProps<TData>) {
  const { options, viewConfig, rest } = splitOptions<TData>(
    props as Record<string, unknown>
  )

  // Stable context identity: splitOptions builds a fresh object per render,
  // and every row subscribes to this context - hand out the previous object
  // unless a config value actually changed.
  const viewConfigRef = useRef(viewConfig)
  if (
    !shallowEqualRecord(
      viewConfigRef.current as unknown as Record<string, unknown>,
      viewConfig as unknown as Record<string, unknown>
    )
  ) {
    viewConfigRef.current = viewConfig
  }
  const stableViewConfig = viewConfigRef.current

  const instance = useGanttState<TData>(options)

  const defaultProps = {
    "data-slot": "gantt",
    // own the foreground (previews and consumer shells may not set body
    // color) and the type scale: every gantt label inherits the root's text
    // size, so one class here (or on the consumer's className) rescales the
    // whole component - e.g. className="text-sm" for a roomier grid
    className: cn(
      "text-foreground flex min-h-0 min-w-0 flex-col text-xs",
      className
    ),
    children: (
      <>
        {children}
        <div
          data-slot="gantt-announcer"
          aria-live="polite"
          className="sr-only"
        />
      </>
    ),
  }

  return (
    <GanttContext.Provider value={instance}>
      <GanttViewConfigContext.Provider value={stableViewConfig}>
        {useRender({
          defaultTagName: "div",
          render,
          props: mergeProps<"div">(defaultProps, rest),
        })}
      </GanttViewConfigContext.Provider>
    </GanttContext.Provider>
  )
}

export {
  Gantt,
  useGantt,
  useGanttNavigation,
  useGanttScale,
  useGanttSelector,
  useGanttSettings,
  useGanttViewConfig,
}
export type {
  GanttColumn,
}
