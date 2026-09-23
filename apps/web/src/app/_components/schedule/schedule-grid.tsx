import { ChevronDown, ChevronRight } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { householdLocalDate } from "~/lib/household-date";
import { cn } from "~/lib/utils";

/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Pinned labels and independently scrolling dates require flex layout; native table layout cannot preserve those regions. */

export interface ScheduleSegment {
  id: string;
  label: string;
  /** Inclusive household calendar dates. */
  startDate: string;
  endDate?: string;
  variant: "range" | "milestone" | "reference";
  color?: string;
}

export interface ScheduleRow {
  id: string;
  name: string;
  depth: number;
  group?: boolean;
  expandable?: boolean;
  expanded?: boolean;
  meta?: string;
  /** Compact rail text; meta remains the complete accessible description. */
  metaShort?: string;
  segments: ScheduleSegment[];
  noDateLabel?: string;
}

export interface ScheduleWindow {
  /** Inclusive household calendar dates. */
  startDate: string;
  endDate: string;
}

export type ScheduleScale = "day" | "week" | "month";

interface ScheduleGridProps {
  rows: readonly ScheduleRow[];
  window: ScheduleWindow;
  scale?: ScheduleScale;
  ariaLabel: string;
  renderLabel?: (row: ScheduleRow) => ReactNode;
  onToggle?: (id: string) => void;
  onRowActivate?: (row: ScheduleRow) => void;
}

const DAY_MS = 86_400_000;
const LABEL_WIDTH = 368;
const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 56;
const SCALE_WIDTH = {
  day: 24,
  week: 12,
  month: 4,
} satisfies Record<ScheduleScale, number>;

/** Center a date in the space left after the pinned label column. */
export function scheduleScrollLeft(
  day: number,
  startDay: number,
  dayWidth: number,
  viewportWidth: number,
  timelineWidth: number,
): number {
  const dateArea = Math.max(0, viewportWidth - LABEL_WIDTH);
  return Math.max(
    0,
    Math.min(
      (day - startDay + 0.5) * dayWidth - dateArea / 2,
      Math.max(0, LABEL_WIDTH + timelineWidth - viewportWidth),
    ),
  );
}

/** Date-only arithmetic in UTC avoids browser locale and daylight-saving drift. */
export function scheduleDayIndex(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return date.getTime() / DAY_MS;
}

function dateAt(index: number): Date {
  return new Date(index * DAY_MS);
}

function formatDay(index: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(dateAt(index));
}

function segmentDescription(segment: ScheduleSegment): string {
  const start = scheduleDayIndex(segment.startDate);
  const end = scheduleDayIndex(segment.endDate ?? segment.startDate);
  if (start == null || end == null) return segment.label;
  return `${segment.label}, ${formatDay(start)}${end === start ? "" : ` to ${formatDay(end)}`}`;
}

function defaultScale(span: number): ScheduleScale {
  if (span <= 35) return "day";
  if (span <= 180) return "week";
  return "month";
}

function monthTicks(start: number, end: number) {
  const first = dateAt(start);
  const cursor = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1),
  );
  const ticks: Array<{ day: number; label: string; year: number }> = [];
  while (cursor.getTime() / DAY_MS <= end) {
    const day = cursor.getTime() / DAY_MS;
    ticks.push({
      day,
      label: new Intl.DateTimeFormat(undefined, {
        month: "short",
        timeZone: "UTC",
      }).format(cursor),
      year: cursor.getUTCFullYear(),
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return ticks;
}

function minorTicks(start: number, end: number, scale: ScheduleScale) {
  const step = scale === "day" ? 1 : 7;
  const ticks: Array<{ day: number; label: string }> = [];
  for (let day = start; day <= end; day += step) {
    ticks.push({
      day,
      label:
        scale === "week" ? formatDay(day) : String(dateAt(day).getUTCDate()),
    });
  }
  return ticks;
}

function isInteractive(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest("a,button,input,select,textarea") !== null
  );
}

function toggleOnArrow(
  event: KeyboardEvent<HTMLDivElement>,
  row: ScheduleRow | undefined,
  onToggle?: (id: string) => void,
) {
  if (!row?.expandable || !onToggle) return;
  const shouldExpand = event.key === "ArrowRight" && !row.expanded;
  const shouldCollapse = event.key === "ArrowLeft" && row.expanded;
  if (shouldExpand || shouldCollapse) {
    event.preventDefault();
    onToggle(row.id);
  }
}

function onRowKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  index: number,
  rows: readonly ScheduleRow[],
  refs: { current: Array<HTMLDivElement | null> },
  onToggle?: (id: string) => void,
  onRowActivate?: (row: ScheduleRow) => void,
) {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const next = index + (event.key === "ArrowDown" ? 1 : -1);
    refs.current[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
  } else if (event.key === "Home") {
    event.preventDefault();
    refs.current[0]?.focus();
  } else if (event.key === "End") {
    event.preventDefault();
    refs.current[rows.length - 1]?.focus();
  } else if (event.key === "Enter" && !isInteractive(event.target)) {
    onRowActivate?.(rows[index]!);
  } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
    toggleOnArrow(event, rows[index], onToggle);
  }
}

/** A read-only schedule surface shared by calendar, project, and garden adapters. */
export function ScheduleGrid({
  rows,
  window,
  scale,
  ariaLabel,
  renderLabel,
  onToggle,
  onRowActivate,
}: ScheduleGridProps) {
  const start = scheduleDayIndex(window.startDate);
  const end = scheduleDayIndex(window.endDate);
  const validWindow = start != null && end != null && end >= start;
  const startDay = start ?? 0;
  const endDay = end ?? -1;
  const span = validWindow ? endDay - startDay + 1 : 0;
  const [localScale, setLocalScale] = useState<ScheduleScale | null>(null);
  const activeScale = localScale ?? scale ?? defaultScale(span);
  const dayWidth = SCALE_WIDTH[activeScale];
  const timelineWidth = Math.max(640, span * dayWidth);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const previousWindow = useRef<string | null>(null);
  const previousScale = useRef<ScheduleScale | null>(null);
  const scaleAnchor = useRef<number | null>(null);
  const desktopRowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const today = scheduleDayIndex(householdLocalDate());
  const todayInRange = today != null && today >= startDay && today <= endDay;
  const windowKey = `${window.startDate}:${window.endDate}`;

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid || !validWindow) return;
    const changedWindow = previousWindow.current !== windowKey;
    if (changedWindow || previousScale.current !== activeScale) {
      const focusDay = changedWindow
        ? todayInRange
          ? today!
          : startDay
        : (scaleAnchor.current ?? startDay);
      grid.scrollLeft = scheduleScrollLeft(
        focusDay,
        startDay,
        dayWidth,
        grid.clientWidth,
        timelineWidth,
      );
      previousWindow.current = windowKey;
      previousScale.current = activeScale;
      scaleAnchor.current = null;
    }
  }, [
    activeScale,
    dayWidth,
    startDay,
    timelineWidth,
    today,
    todayInRange,
    validWindow,
    windowKey,
  ]);

  const chooseScale = (choice: ScheduleScale) => {
    const grid = gridRef.current;
    if (grid && choice !== activeScale) {
      const dateArea = Math.max(0, grid.clientWidth - LABEL_WIDTH);
      scaleAnchor.current = Math.min(
        endDay,
        Math.max(
          startDay,
          startDay + (grid.scrollLeft + dateArea / 2) / dayWidth,
        ),
      );
    }
    setLocalScale(choice);
  };

  const scrollToToday = () => {
    const grid = gridRef.current;
    if (grid && todayInRange) {
      grid.scrollLeft = scheduleScrollLeft(
        today!,
        startDay,
        dayWidth,
        grid.clientWidth,
        timelineWidth,
      );
    }
  };
  const months = useMemo(
    () => (validWindow ? monthTicks(startDay, endDay) : []),
    [endDay, startDay, validWindow],
  );
  const minors = useMemo(
    () => (validWindow ? minorTicks(startDay, endDay, activeScale) : []),
    [activeScale, endDay, startDay, validWindow],
  );

  if (!validWindow) {
    return <p role="alert">The schedule date range is invalid.</p>;
  }

  const rowLabel = (row: ScheduleRow) => renderLabel?.(row) ?? row.name;

  return (
    <div className="min-w-0 border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1 md:min-h-8">
        <span className="truncate text-xs font-medium text-muted-foreground">
          {ariaLabel}
        </span>
        <div
          className="hidden items-center gap-0.5 md:flex"
          aria-label="Schedule scale"
        >
          {todayInRange && (
            <button
              type="button"
              onClick={scrollToToday}
              className="mr-2 min-h-7 rounded-sm px-2 text-xs font-medium text-primary hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Today
            </button>
          )}
          {(["day", "week", "month"] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              aria-pressed={activeScale === choice}
              onClick={() => chooseScale(choice)}
              className={cn(
                "min-h-7 rounded-sm px-2 text-xs capitalize focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                activeScale === choice
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              {choice}
            </button>
          ))}
        </div>
      </div>

      <ul className="divide-y divide-border md:hidden" aria-label={ariaLabel}>
        {rows.map((row) => (
          <li key={row.id} className="min-h-11 px-3 py-2">
            <div
              className="flex items-center gap-2 font-medium"
              style={{ paddingInlineStart: `${Math.min(row.depth, 6) * 12}px` }}
            >
              {row.expandable && onToggle && (
                <button
                  type="button"
                  aria-label={`${row.expanded ? "Collapse" : "Expand"} ${row.name}`}
                  aria-expanded={row.expanded ?? false}
                  onClick={() => onToggle(row.id)}
                  className="-m-2 inline-flex size-11 shrink-0 items-center justify-center"
                >
                  {row.expanded ? (
                    <ChevronDown className="size-4" />
                  ) : (
                    <ChevronRight className="size-4" />
                  )}
                </button>
              )}
              <span className="min-w-0 flex-1 [&_a]:inline-flex [&_a]:min-h-11 [&_a]:max-w-full [&_a]:items-center">
                {rowLabel(row)}
              </span>
            </div>
            {row.meta && (
              <div
                className="text-xs break-words text-muted-foreground"
                style={{
                  paddingInlineStart: `${Math.min(row.depth, 6) * 12}px`,
                }}
              >
                {row.meta}
              </div>
            )}
            {!row.group && (
              <div
                className="mt-1 text-xs text-muted-foreground"
                style={{
                  paddingInlineStart: `${Math.min(row.depth, 6) * 12}px`,
                }}
              >
                {row.segments.length > 0
                  ? row.segments.map(segmentDescription).join(" · ")
                  : (row.noDateLabel ?? "No date")}
              </div>
            )}
          </li>
        ))}
      </ul>

      <div
        ref={gridRef}
        className="hidden max-h-[min(70vh,48rem)] overflow-auto md:block"
        role="grid"
        aria-label={ariaLabel}
      >
        <div style={{ width: LABEL_WIDTH + timelineWidth }}>
          <div
            className="sticky top-0 z-30 flex border-b border-border bg-card"
            style={{ height: HEADER_HEIGHT }}
            role="row"
          >
            <div
              className="sticky left-0 z-40 flex shrink-0 items-end border-r border-border bg-card px-2 pb-1 text-xs font-medium text-muted-foreground"
              style={{ width: LABEL_WIDTH }}
              role="columnheader"
            >
              Activity
            </div>
            <div
              className="relative shrink-0 bg-card"
              style={{ width: timelineWidth }}
              role="columnheader"
              aria-label={`${formatDay(startDay)} to ${formatDay(endDay)}`}
            >
              <div className="absolute inset-x-0 top-0 h-7 border-b border-border">
                {months.map((tick) => (
                  <span
                    key={tick.day}
                    className="absolute top-1 truncate pl-1 text-xs font-medium"
                    style={{
                      left: Math.max(0, (tick.day - startDay) * dayWidth),
                    }}
                  >
                    {tick.label} {tick.year}
                  </span>
                ))}
              </div>
              <div className="absolute inset-x-0 bottom-0 h-7">
                {minors.map((tick) => (
                  <span
                    key={tick.day}
                    className="absolute top-1 border-l border-border pl-1 text-[10px] text-muted-foreground"
                    style={{ left: (tick.day - startDay) * dayWidth }}
                  >
                    {tick.label}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="relative">
            <div
              className="pointer-events-none absolute top-0 bottom-0"
              style={{ left: LABEL_WIDTH, width: timelineWidth }}
              aria-hidden="true"
            >
              {months.map((tick) => (
                <span
                  key={tick.day}
                  className="absolute top-0 bottom-0 border-l border-border"
                  style={{ left: (tick.day - startDay) * dayWidth }}
                />
              ))}
              {(() => {
                return todayInRange ? (
                  <span
                    data-testid="schedule-today-line"
                    className="absolute top-0 bottom-0 z-10 border-l-2 border-primary/70"
                    style={{ left: (today! - startDay) * dayWidth }}
                  />
                ) : null;
              })()}
            </div>
            {rows.map((row, index) => (
              <div
                key={row.id}
                ref={(node) => {
                  desktopRowRefs.current[index] = node;
                }}
                role="row"
                tabIndex={0}
                aria-label={`${row.name}${row.meta ? `, ${row.meta}` : ""}${!row.group && row.segments.length === 0 ? `, ${row.noDateLabel ?? "No date"}` : ""}`}
                onKeyDown={(event) =>
                  onRowKeyDown(
                    event,
                    index,
                    rows,
                    desktopRowRefs,
                    onToggle,
                    onRowActivate,
                  )
                }
                className={cn(
                  "relative flex border-b border-border/70 text-sm focus-visible:z-20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  row.group ? "bg-muted/50 font-semibold" : "hover:bg-muted/40",
                )}
                style={{ height: ROW_HEIGHT }}
              >
                <div
                  className={cn(
                    "sticky left-0 z-20 flex shrink-0 items-center gap-1 border-r border-border px-2",
                    row.group ? "bg-muted" : "bg-card",
                  )}
                  style={{ width: LABEL_WIDTH }}
                  role="rowheader"
                >
                  <span
                    className="shrink-0"
                    style={{ width: Math.min(row.depth, 8) * 12 }}
                    aria-hidden="true"
                  />
                  {row.expandable && onToggle ? (
                    <button
                      type="button"
                      aria-label={`${row.expanded ? "Collapse" : "Expand"} ${row.name}`}
                      aria-expanded={row.expanded ?? false}
                      onClick={() => onToggle(row.id)}
                      className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      {row.expanded ? (
                        <ChevronDown className="size-3.5" />
                      ) : (
                        <ChevronRight className="size-3.5" />
                      )}
                    </button>
                  ) : (
                    <span className="w-7 shrink-0" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1 truncate [&_a]:max-w-full">
                    {rowLabel(row)}
                  </span>
                  {row.meta && (
                    <span
                      className="max-w-24 shrink-0 truncate text-xs text-muted-foreground"
                      title={row.meta}
                      aria-label={row.meta}
                    >
                      {row.metaShort ?? row.meta}
                    </span>
                  )}
                </div>
                <div
                  className="relative z-0 shrink-0 overflow-hidden"
                  style={{ width: timelineWidth }}
                  role="gridcell"
                >
                  {!row.group && row.segments.length === 0 && (
                    <span className="absolute top-1.5 left-2 text-xs text-muted-foreground">
                      {row.noDateLabel ?? "No date"}
                    </span>
                  )}
                  {row.segments.map((segment) => {
                    const first = scheduleDayIndex(segment.startDate);
                    const last = scheduleDayIndex(
                      segment.endDate ?? segment.startDate,
                    );
                    if (
                      first == null ||
                      last == null ||
                      last < startDay ||
                      first > endDay ||
                      last < first
                    )
                      return null;
                    const left =
                      (Math.max(first, startDay) - startDay) * dayWidth;
                    const width = Math.max(
                      dayWidth,
                      (Math.min(last, endDay) - Math.max(first, startDay) + 1) *
                        dayWidth,
                    );
                    const color =
                      segment.color ??
                      (segment.variant === "reference"
                        ? "var(--muted-foreground)"
                        : "var(--primary)");
                    const style: CSSProperties = {
                      left,
                      backgroundColor: color,
                      borderColor: color,
                    };
                    return segment.variant === "milestone" ? (
                      <span
                        key={segment.id}
                        role="img"
                        aria-label={segmentDescription(segment)}
                        title={segmentDescription(segment)}
                        className="absolute top-3 size-2 rotate-45 border bg-card"
                        style={{
                          ...style,
                          left: left + Math.max(0, dayWidth / 2 - 4),
                        }}
                      />
                    ) : (
                      <span
                        key={segment.id}
                        role="img"
                        aria-label={segmentDescription(segment)}
                        title={segmentDescription(segment)}
                        className={cn(
                          "absolute top-[8px] flex h-4 max-w-none items-center overflow-hidden rounded-[2px] border px-1 text-[10px] leading-none font-medium whitespace-nowrap text-white",
                          segment.variant === "reference" &&
                            "border-dashed bg-transparent! text-foreground",
                        )}
                        style={{ ...style, width }}
                      >
                        {width >= 96 ? (
                          <span className="block min-w-0 truncate">
                            {segment.label}
                          </span>
                        ) : null}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {rows.length === 0 && (
        <p className="px-3 py-4 text-sm text-muted-foreground">
          No schedule rows in this view.
        </p>
      )}
    </div>
  );
}
