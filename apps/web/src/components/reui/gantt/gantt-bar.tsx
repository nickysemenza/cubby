"use client"

import { useMemo, useState, type CSSProperties, type ReactNode } from "react"
import {
  useGantt,
  useGanttViewConfig,
} from "~/components/reui/gantt/gantt"
import {
  flattenResources,
  toZoned,
} from "~/components/reui/gantt/gantt-lib"
import type {
  GanttSegment,
} from "~/components/reui/gantt/gantt-types"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"

import { cn } from "~/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip"
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";

interface GanttBarProps<TData = unknown> extends Omit<
  useRender.ComponentProps<"div">,
  "children"
> {
  segment: GanttSegment<TData>
  /** Replaces the default bar CONTENT; the wrapper stays gantt-owned. */
  children?: ReactNode
  /**
   * The title renders beside the bar (view-owned), so the default inner
   * content is suppressed. Explicit children and renderEvent still win.
   */
  labelOutside?: boolean
  /**
   * The owning row's title for the aria-label. Pass it when the row is in
   * scope (the internal view does); omitting falls back to a tree lookup.
   */
  rowTitle?: string
}

/**
 * Read-only project bar. The wrapper owns positioning, labelling, tooltips,
 * and data attributes; content comes from children, renderEvent, or the
 * built-in default.
 */
function GanttBar<TData = unknown>({
  segment,
  className,
  render,
  children,
  labelOutside,
  rowTitle: rowTitleProp,
  ...props
}: GanttBarProps<TData>) {
  const instance = useGantt<TData>()
  const viewConfig = useGanttViewConfig<TData>()
  const { settings } = instance
  const occurrence = segment.occurrence
  const event = occurrence.event

  // Hover-only range tooltip. Focus opens are ignored so it does not flash
  // after an overlay returns focus to the bar.
  const [tipOpen, setTipOpen] = useState(false)

  const progress =
    typeof event.progress === "number"
      ? Math.min(Math.max(Math.round(event.progress), 0), 100)
      : null

  const defaultContent = (
    <>
      <span className="truncate font-medium">{event.title}</span>
      {!occurrence.allDay && segment.isStart && (
        <span className="text-muted-foreground hidden truncate @[8rem]:inline">
          {settings.i18n.functions.formatEventTime(
            toZoned(occurrence.start, settings.timeZone),
            toZoned(occurrence.end, settings.timeZone),
            occurrence.allDay,
            settings.locale
          )}
        </span>
      )}
    </>
  )

  const renderProps = { occurrence, segment }
  const content =
    children ??
    viewConfig.renderEvent?.(renderProps) ??
    (labelOutside ? null : defaultContent)
  // Consumer-owned content owns the WHOLE inner visualization: the built-in
  // progress fill and done mark yield so custom bars start from a blank
  // canvas (progress stays readable via data-progress/data-completed).
  const consumerOwnsContent = children !== undefined || !!viewConfig.renderEvent

  const timeLabel = settings.i18n.functions.formatEventTime(
    toZoned(occurrence.start, settings.timeZone),
    toZoned(occurrence.end, settings.timeZone),
    occurrence.allDay,
    settings.locale
  )
  // name the row too: the split-pane layout carries no grid semantics.
  // The prop path is O(1); the lookup fallback is memoized so external
  // GanttBar usage never flattens the tree per render.
  const fallbackRowTitle = useMemo(
    () =>
      rowTitleProp === undefined && event.resourceId
        ? flattenResources(settings.resources).find(
            ({ resource }) => resource.id === event.resourceId
          )?.resource.title
        : undefined,
    [rowTitleProp, event.resourceId, settings.resources]
  )
  const rowTitle = rowTitleProp ?? fallbackRowTitle


  const defaultProps = {
    "data-slot": "gantt-bar",
    "data-event-id": event.id,
    "data-all-day": occurrence.allDay || undefined,
    "data-past": occurrence.end.getTime() < Date.now() || undefined,
    "data-label-outside": labelOutside || undefined,
    "data-progress": progress ?? undefined,
    "data-completed": progress === 100 || undefined,
    "aria-label": settings.i18n.functions.formatEventAriaLabel({
      title: event.title,
      timeLabel,
      rowTitle,
      progressLabel:
        progress !== null ? settings.i18n.labels.progress(progress) : undefined,
      continues: segment.continuesBefore || segment.continuesAfter,
    }),
    style: {
      "--gantt-event-color": event.color ?? "var(--color-primary)",
    } as CSSProperties,
    className: cn(
      "group/gantt-bar-group text-foreground @container relative flex w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-sm px-1.5 py-0.5 text-start leading-normal select-none",
      // the unfilled remainder has to be legible on its own - at /12 a bar
      // with a progress fill read as a floating segment with no basement
      "bg-(--gantt-event-color)/20 hover:bg-(--gantt-event-color)/30",
      segment.continuesBefore && "rounded-s-none",
      segment.continuesAfter && "rounded-e-none",
      viewConfig.getEventClassName?.(renderProps),
      className
    ),
    children: (
      <>
        {progress !== null && (
          // Chrome, not content: it is an absolutely-positioned layer BEHIND
          // whatever the bar renders, so a consumer bar (renderEvent) keeps
          // its completion fill instead of silently losing it. The inline
          // done-mark below stays gated, because that one really is content.
          <span
            aria-hidden
            data-slot="gantt-bar-progress"
            className="pointer-events-none absolute inset-y-0 start-0 border-e border-(--gantt-event-color)/65 bg-(--gantt-event-color)/40 data-full:border-e-0"
            data-full={progress === 100 || undefined}
            style={{ width: `${progress}%` }}
          />
        )}
        {progress === 100 && !consumerOwnsContent && (
          // done mark: completion chrome like the fill itself, so it shows
          // for outside-label bars too (where the inner content is empty)
          <CheckIcon className="relative size-2.5 shrink-0 opacity-80" aria-hidden="true" />
        )}
        {content}
      </>
    ),
  }

  const bar = useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(defaultProps, props),
  })

  const barTree = (
    <TooltipProvider delay={500} closeDelay={0} timeout={300}>
      <Tooltip
        open={tipOpen}
        onOpenChange={(next: boolean, details: { reason?: string }) => {
          // opens only on hover; focus/press opens are dropped
          if (next && details?.reason !== "trigger-hover") return
          setTipOpen(next)
        }}
      >
        <TooltipTrigger render={bar} />
        {tipOpen && (
          <TooltipContent side="top" className="pointer-events-none">
            <div className="font-medium">{event.title}</div>
            <div className="opacity-80">{timeLabel}</div>
          </TooltipContent>
        )}
      </Tooltip>
    </TooltipProvider>
  )

  return barTree
}

export { GanttBar }
