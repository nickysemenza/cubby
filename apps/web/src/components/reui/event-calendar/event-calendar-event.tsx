"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { format } from "date-fns";
import {
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  useEventCalendar,
  useEventCalendarRenderEvent,
  useEventCalendarSelector,
} from "~/components/reui/event-calendar/event-calendar";
import {
  beginBlockedEventCalendarGesture,
  markChipPress,
  useEventCalendarDrag,
  wasRecentDrag,
} from "~/components/reui/event-calendar/event-calendar-dnd";
import { toZoned } from "~/components/reui/event-calendar/event-calendar-lib";
import type {
  EventCalendarSegment,
} from "~/components/reui/event-calendar/event-calendar-types";
import { cn } from "~/lib/utils";

/**
 * Standardized drag-ghost surface treatment, shared by Month and Week. One
 * visual language for interactions:
 * - move: the event is CARRIED FREELY - a cursor-attached full clone (built
 *   by the dnd engine, data-slot=event-calendar-drag-carry) travels with the
 *   pointer; the in-grid ghost is only this faint dashed placeholder marking
 *   the snapped drop slot. The source stays dimmed in place.
 * - resize: the event is STRETCHED - the chip itself at the proposed extent
 *   with a dashed boundary instead of solid (slight indicator, no elevation).
 * - invalid: destructive tint on the placeholder / dashed clone; the engine
 *   adds the not-allowed cursor, a destructive ring on the carry clone, and
 *   a cursor-following validation hint.
 */
const EVENT_CALENDAR_GHOST = {
  move: "border border-dashed border-(--ec-event-color)/50 bg-(--ec-event-color)/8",
  resize:
    "border border-dashed border-(--ec-event-color)/70 overflow-hidden",
  invalid: "border-destructive/70 bg-destructive/10",
  invalidResize: "border-destructive/70",
  /** Applied to the clone inside an invalid resize ghost. */
  invalidContent: "opacity-60",
} as const;

interface EventCalendarEventProps<TData = unknown>
  extends Omit<useRender.ComponentProps<"button">, "children"> {
  segment: EventCalendarSegment<TData>;
  /** Replaces the default chip CONTENT; the wrapper stays calendar-owned. */
  children?: ReactNode;
  /**
   * Static drag clone: renders the chip exactly as-is but inert - no gestures,
   * resize handles, selection/drag state, focus, or pointer events. Used for
   * the full-fidelity ghost that tracks the proposed slot during a move.
   */
  preview?: boolean;
}

/**
 * The one interactive event element used by every view. The wrapper owns
 * positioning hooks, a11y, selection, drag/resize listeners, and data
 * attributes; content comes from children, the root renderEvent override,
 * or the built-in default.
 */
function EventCalendarEvent<TData = unknown>({
  segment,
  className,
  render,
  children,
  preview = false,
  ...props
}: EventCalendarEventProps<TData>) {
  const instance = useEventCalendar<TData>();
  const renderEvent = useEventCalendarRenderEvent<TData>();
  const { settings } = instance;
  const occurrence = segment.occurrence;
  const event = occurrence.event;

  const isDraggingRaw = useEventCalendarSelector<TData, boolean>(
    (state) => state.drag?.occurrence.key === occurrence.key,
    { calendar: instance },
  );
  // A preview clone must never inherit the source's selected/dragging state
  // (the drag key matches, which would dim the clone itself).
  const isSelected = false;
  const isDragging = preview ? false : isDraggingRaw;

  const interactive = !preview;
  const dragOn = true;
  const moveDrag = useEventCalendarDrag(
    segment,
    !interactive || !dragOn || event.readOnly || event.draggable === false,
  );
  const moveDisabled =
    !interactive || !dragOn || event.readOnly || event.draggable === false;
  const defaultContent = (
    <>
      {/* leading color dot for single-row chips (month cells, all-day bars);
          time-grid blocks read their color from the tinted surface instead -
          in the stacked layout a dot would sit alone on the first line */}
      <span
        aria-hidden
        data-slot="event-calendar-event-dot"
        className="-me-0.5 size-1.5 shrink-0 rounded-full bg-(--ec-event-color)"
      />
      <span
        className={cn(
          "font-medium",
          "truncate",
        )}
      >
        {event.title}
      </span>
      {/* month cells are narrow: a compact never-shrinking start time keeps
          the title readable; grid views show the full range */}
      {!occurrence.allDay &&
        segment.isStart &&
        <span className="shrink-0 text-muted-foreground">
          {format(
            toZoned(occurrence.start, settings.timeZone),
            settings.i18n.formats.eventTime,
            { locale: settings.locale },
          )}
        </span>}
    </>
  );

  const content = children ?? renderEvent?.({ occurrence, segment }) ?? defaultContent;

  const timeLabel = settings.i18n.functions.formatEventTime(
    toZoned(occurrence.start, settings.timeZone),
    toZoned(occurrence.end, settings.timeZone),
    occurrence.allDay,
    { locale: settings.locale },
  );
  // native hover tooltip text; a consumer formatter returning undefined
  // drops the title attribute entirely (e.g. when it renders its own tooltip)
  const label = settings.i18n.functions.formatEventLabel
    ? settings.i18n.functions.formatEventLabel(event.title, timeLabel)
    : `${event.title}, ${timeLabel}`;


  const defaultProps = {
    type: "button" as const,
    ref: moveDrag.setNodeRef,
    ...moveDrag.attributes,
    ...moveDrag.listeners,
    "data-slot": "event-calendar-event",
    "data-all-day": occurrence.allDay || undefined,
    "data-selected": isSelected || undefined,
    "data-dragging": isDragging || undefined,
    "data-preview": preview || undefined,
    "data-past": occurrence.end.getTime() < Date.now() || undefined,
    title: preview ? undefined : label,
    "aria-label":
      settings.i18n.functions.formatEventAriaLabel?.(
        event.title,
        timeLabel,
        segment.continuesBefore || segment.continuesAfter,
      ) ??
      `${event.title}, ${timeLabel}${
        segment.continuesBefore || segment.continuesAfter
          ? `, ${settings.i18n.labels.continues}`
          : ""
      }`,
    "aria-hidden": preview || undefined,
    tabIndex: preview ? -1 : undefined,
    style: {
      "--ec-event-color": event.color ?? "var(--color-primary)",
    } as CSSProperties,
    onPointerDownCapture: () => {
      // suppress the trailing slot-create click if this press does not turn
      // into a drag (e.g. a locked chip) - see markChipPress
      markChipPress();
    },
    onPointerDown: (e: React.PointerEvent) => {
      if (moveDisabled && interactive) {
        beginBlockedEventCalendarGesture(instance, e.nativeEvent, segment);
      } else {
        moveDrag.listeners?.onPointerDown?.(e);
      }
    },
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      if (wasRecentDrag()) return;
      settings.onEventClick?.(occurrence, segment, e);
    },
    className: cn(
      "group/ec-event relative flex w-full min-w-0 cursor-pointer touch-none select-none items-center overflow-hidden text-start text-foreground",
      "outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1",
      preview && "pointer-events-none",
      "@container gap-1.5 rounded-sm px-1.5 py-1 leading-normal",
      "bg-(--ec-event-color)/15 hover:bg-(--ec-event-color)/25",
      "dark:bg-(--ec-event-color)/20 dark:hover:bg-(--ec-event-color)/30",
      "inset-ring inset-ring-(--ec-event-color)/15",
      "transition-[background-color,box-shadow] duration-150",
      "data-dragging:opacity-40",
      "data-selected:inset-ring-(--ec-event-color)/40 data-selected:bg-(--ec-event-color)/30",
      segment.continuesBefore && "rounded-s-none",
      segment.continuesAfter && "rounded-e-none",
      event.className,
      className,
    ),
    children: content,
  };

  const chip = useRender({
    defaultTagName: "button",
    render,
    props: mergeProps<"button">(defaultProps, props),
  });

  return chip;
}

function EventCalendarDropPlaceholder({
  color,
  valid,
  className,
}: {
  color?: string;
  valid: boolean;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      data-slot="event-calendar-drop-placeholder"
      data-drop-invalid={!valid || undefined}
      className={cn(
        "shrink-0 border border-dashed",
        valid
          ? "border-(--ec-event-color)/50 bg-(--ec-event-color)/8"
          : "border-destructive/70 bg-destructive/10",
        className,
      )}
      style={
        {
          "--ec-event-color": color ?? "var(--color-primary)",
        } as CSSProperties
      }
    />
  );
}

export {
  EVENT_CALENDAR_GHOST,
  EventCalendarDropPlaceholder,
  EventCalendarEvent,
};
