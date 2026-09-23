import type {
  CalendarDaySummary,
  CalendarItem,
  CalendarItemKind,
  CalendarRangeInput,
} from "@cubby/schemas/calendar";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { addDays, format } from "date-fns";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import {
  type CSSProperties,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { toast } from "sonner";

import { showErrorToast } from "~/components/feedback/error-details";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Row, Stack } from "~/components/layout";
import {
  type EventCalendarRenderEventProps,
  type EventCalendarRenderEventRoot,
  FortnightEventCalendar,
  MonthEventCalendar,
  WeekEventCalendar,
} from "~/components/reui/event-calendar/event-calendar";
import type {
  CalendarEvent,
  EventCalendarProposedUpdate,
} from "~/components/reui/event-calendar/event-calendar-types";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { createPopoverHandle, PopoverTrigger } from "~/components/ui/popover";
import { ResponsiveSheet } from "~/components/ui/responsive-sheet";
import { ChoiceSwitcher } from "~/components/ui/view-switcher";
import { useEntityCommands } from "~/entities/editing/use-entity-commands";
import { HOUSEHOLD_TIMEZONE, householdLocalDate } from "~/lib/household-date";
import { formatEstimate } from "~/lib/nutrition-format";
import { formatPlainDate, parsePlainDate } from "~/lib/plain-date";
import { formatCurrency } from "~/lib/utils";

import { CalendarAgenda } from "./calendar-agenda";
import type { CalendarFilters } from "./calendar-filters";
import { KIND_ICONS } from "./calendar-icons";
import { CalendarItemInspector } from "./calendar-item-inspector";
import {
  CalendarItemPresentation,
  calendarItemTriggerClassName,
} from "./calendar-item-row";
import { calendarItemPresentation } from "./calendar-kind-registry";
import {
  formatCalendarPeriodTitle,
  getCalendarPeriodRange,
  householdCalendarDate,
  shiftCalendarPeriod,
  type CalendarViewPeriod,
} from "./calendar-period";
import { CalendarSchedule } from "./calendar-schedule";
import { EMPTY_DAY_SUMMARY, WeekSummaryGrid } from "./calendar-week-summary";
import { calendar } from "./calendar.functions";

const CALENDAR_ACTIVATION = {
  touchDelayMs: 350,
  touchTolerancePx: 12,
} as const;
const ALL_KINDS: CalendarItemKind[] = ["meal", "task", "expense", "project"];
const NO_ITEMS: CalendarItem[] = [];
const NO_DAY_SUMMARIES: Record<string, CalendarDaySummary> = {};
const GRID_PERIOD_OPTIONS = [
  { value: "month", label: "Month" },
  { value: "fortnight", label: "Fortnight" },
  { value: "week", label: "Week" },
] as const;
const PERIOD_OPTIONS = [
  ...GRID_PERIOD_OPTIONS,
  { value: "schedule", label: "Schedule" },
] as const;
/**
 * Fortnight density, built on ONE vertical unit: 1.75rem, the month's bar
 * height and the system's control height. A crossing bar is one line of text
 * and takes one unit; a single-day chip carries two lines and takes two. The
 * row floor is four chip lanes, so a quiet fortnight is not two screens of
 * empty paper and a busy one still grows.
 */
// SAFETY: React CSSProperties has no index signature for the calendar's
// custom properties; these three values are consumed only by event-calendar CSS.
const FORTNIGHT_DENSITY = {
  "--ec-month-row-min-h": "14rem",
  "--ec-month-bar-h": "3.5rem",
  "--ec-month-span-h": "1.75rem",
} as CSSProperties;

const LazyCalendarCreateDialog = lazy(() =>
  import("./calendar-create-dialog").then(({ CalendarCreateDialog }) => ({
    default: CalendarCreateDialog,
  })),
);

const KIND_LABELS = {
  meal: "Meals",
  task: "Tasks",
  expense: "Expenses",
  project: "Projects",
  // Never indexed at runtime: `ALL_KINDS` (this file's day-sheet
  // creatable-kind list) never includes "planting" — see the `create`-field
  // note on `CalendarKindSpec` in calendar-kind-registry.tsx. Present only so
  // this `satisfies Record<CalendarItemKind, string>` still compiles.
  planting: "Plantings",
} satisfies Record<CalendarItemKind, string>;

// No second color map. A calendar chip and the entity's own chrome are the
// same claim about the same record, and keeping two hand-written maps let them
// drift: before this, `task` and `project` were exactly swapped between them
// and only `expense` agreed. DESIGN.md sanctions one categorical hue channel
// (the project Gantt); this is the entity accent ladder, not a second one.

type CreateKind = CalendarItemKind | null;

interface UnifiedCalendarProps {
  period: CalendarViewPeriod;
  date?: string;
  day?: string;
  /**
   * Server-side filters, already built from the URL by `buildCalendarFilters`.
   * Omitted by embedded surfaces that pin their own kinds.
   */
  filters?: CalendarFilters;
  /**
   * A kind set imposed by the surrounding page (the /meals calendar tab).
   * Sent to the SERVER as `kinds` rather than filtered in React: a
   * renderer-intrinsic omission has to be server-enforced, and the old
   * behaviour fetched four kinds a month to throw three away.
   */
  lockedKinds?: CalendarItemKind[];
  onPeriodChange: (period: CalendarViewPeriod) => void;
  onDateChange: (date?: string) => void;
  onDayChange?: (day?: string) => void;
}

const canDropCalendarEvent = (
  update: EventCalendarProposedUpdate<CalendarItem>,
) => update.event.data?.interaction === "move";

const toEvent = (
  item: CalendarItem,
  today: string,
): CalendarEvent<CalendarItem> => ({
  ...calendarItemPresentation(item, today).event,
  id: `${item.kind}:${item.id}`,
  title: item.title,
  start: householdCalendarDate(item.startDate),
  end: householdCalendarDate(item.endDateExclusive),
  allDay: true,
  readOnly: item.interaction === "read-only",
  draggable: item.interaction === "move",
  data: item,
});

function CalendarMonthChip({
  occurrence,
}: EventCalendarRenderEventProps<CalendarItem>) {
  const item = occurrence.event.data;
  if (!item) return occurrence.event.title;
  return <CalendarItemPresentation item={item} variant="month" />;
}

const spansDays = (item: CalendarItem) =>
  item.endDateExclusive !==
  formatPlainDate(addDays(parsePlainDate(item.startDate), 1));

function CalendarWeekCard({
  occurrence,
}: EventCalendarRenderEventProps<CalendarItem>) {
  const item = occurrence.event.data;
  if (!item) return occurrence.event.title;
  return (
    <CalendarItemPresentation
      item={item}
      variant={spansDays(item) ? "month" : "rich"}
    />
  );
}

// Same rule the week card uses: a bar repeated across a row stays one compact
// line, and only single-day chips spend the extra height on a second line.
function CalendarFortnightChip({
  occurrence,
}: EventCalendarRenderEventProps<CalendarItem>) {
  const item = occurrence.event.data;
  if (!item) return occurrence.event.title;
  return (
    <CalendarItemPresentation
      item={item}
      variant={spansDays(item) ? "month" : "detail"}
    />
  );
}

const itemIncludesDay = (item: CalendarItem, day: string) =>
  item.startDate <= day && item.endDateExclusive > day;

const scheduleQueryInput = (
  startDate: string,
  endDateExclusive: string,
  filters?: CalendarFilters,
  lockedKinds?: CalendarItemKind[],
): CalendarRangeInput => {
  const selectedKinds = (lockedKinds ?? filters?.kinds)?.filter(
    (kind) => kind === "task" || kind === "planting",
  );
  const input: CalendarRangeInput = {
    startDate,
    endDateExclusive,
    projectId: filters?.projectId,
    projectPresenceFilter: filters?.projectPresenceFilter,
    includeSubProjects: filters?.includeSubProjects,
    taskStatus: filters?.taskStatus,
    taskTrade: filters?.taskTrade,
  };
  if (selectedKinds?.length) {
    input.kinds = [selectedKinds[0]!, ...selectedKinds.slice(1)];
  }
  return input;
};

function CalendarScheduleRead({ input }: { input: CalendarRangeInput }) {
  const { data, isError, error, refetch } = useQuery(
    calendar.schedule.queryOptions(input),
  );
  if (isError) {
    return <CalendarRangeError error={error} onRetry={() => void refetch()} />;
  }
  if (!data) return <Description>Loading schedule…</Description>;
  return (
    <CalendarSchedule
      data={data}
      window={{
        startDate: input.startDate,
        endDate: formatPlainDate(
          addDays(parsePlainDate(input.endDateExclusive), -1),
        ),
      }}
    />
  );
}

export function UnifiedCalendar({
  period,
  date,
  day,
  filters,
  lockedKinds,
  onPeriodChange,
  onDateChange,
  onDayChange,
}: UnifiedCalendarProps) {
  const today = householdLocalDate();
  const anchorDate = date ?? today;
  const anchor = useMemo(() => householdCalendarDate(anchorDate), [anchorDate]);
  const periodRange = useMemo(
    () => getCalendarPeriodRange(anchor, period),
    [anchor, period],
  );
  const activePeriod = useMemo(() => {
    return {
      start: periodRange.activeStart,
      end: periodRange.activeEnd,
      startDate: formatPlainDate(periodRange.activeStart),
      endDateExclusive: formatPlainDate(periodRange.activeEnd),
    };
  }, [periodRange]);
  const visibleRange = useMemo(() => {
    return {
      start: periodRange.visibleStart,
      end: periodRange.visibleEnd,
      startDate: formatPlainDate(periodRange.visibleStart),
      endDateExclusive: formatPlainDate(periodRange.visibleEnd),
    };
  }, [periodRange]);
  const periodDays = useMemo(
    () =>
      period === "week"
        ? Array.from({ length: 7 }, (_, offset) =>
            formatPlainDate(addDays(activePeriod.start, offset)),
          )
        : [],
    [activePeriod.start, period],
  );
  const range = useMemo(
    () => ({
      startDate: visibleRange.startDate,
      endDateExclusive: visibleRange.endDateExclusive,
      ...(lockedKinds ? { kinds: lockedKinds } : filters),
    }),
    [filters, lockedKinds, visibleRange],
  );
  const scheduleRange = useMemo(
    () =>
      scheduleQueryInput(
        activePeriod.startDate,
        activePeriod.endDateExclusive,
        filters,
        lockedKinds,
      ),
    [activePeriod, filters, lockedKinds],
  );
  const { data, isLoading, isError, error, refetch } = useQuery({
    ...calendar.range.queryOptions(range),
    enabled: period !== "schedule",
    // Without this every chip toggle blanks the month grid mid-flight.
    placeholderData: keepPreviousData,
  });
  const items = data?.items ?? NO_ITEMS;
  const editorHandle = useMemo(() => createPopoverHandle<CalendarItem>(), []);

  const sourceEvents = useMemo(
    () => items.map((item) => toEvent(item, today)),
    [items, today],
  );
  const [events, setEvents] =
    useState<CalendarEvent<CalendarItem>[]>(sourceEvents);
  useEffect(() => setEvents(sourceEvents), [sourceEvents]);

  const mealCommands = useEntityCommands("meal");
  const taskCommands = useEntityCommands("task");
  const expenseCommands = useEntityCommands("expense");

  const persistMove = useCallback(
    (update: EventCalendarProposedUpdate<CalendarItem>) => {
      const item = update.event.data;
      if (item?.interaction !== "move") return false;
      const nextStart = formatPlainDate(update.start);
      const nextEndExclusive = formatPlainDate(update.end);
      let request: Promise<unknown>;
      let label: string;
      if (item.kind === "meal") {
        label = "Meal";
        request = mealCommands.submit({
          operation: "update",
          intent: "calendar",
          id: item.id,
          data: { date: nextStart },
        });
      } else if (item.kind === "task") {
        label = "Task";
        const wasRange = spansDays(item);
        request = taskCommands.submit({
          operation: "update",
          intent: "schedule",
          id: item.id,
          data: {
            dueDate: nextStart,
            dueEndDate: wasRange
              ? formatPlainDate(addDays(parsePlainDate(nextEndExclusive), -1))
              : null,
          },
        });
      } else if (item.kind === "expense" && item.future) {
        label = "Expense";
        request = expenseCommands.submit({
          operation: "update",
          intent: "planned",
          id: item.id,
          data: { date: nextStart },
        });
      } else {
        return false;
      }
      void request
        .then(() => toast.success(`${label} updated`))
        .catch((cause: unknown) => {
          showErrorToast(cause);
          setEvents(sourceEvents);
        });
      return true;
    },
    [expenseCommands, mealCommands, sourceEvents, taskCommands],
  );

  const renderEventRoot = useCallback<
    EventCalendarRenderEventRoot<CalendarItem>
  >(
    ({ occurrence }) => (
      <PopoverTrigger handle={editorHandle} payload={occurrence.event.data} />
    ),
    [editorHandle],
  );

  const renderAgendaItem = useCallback(
    (item: CalendarItem) => (
      <PopoverTrigger
        handle={editorHandle}
        payload={item}
        className={calendarItemTriggerClassName(item)}
      >
        <CalendarItemPresentation item={item} variant="rich" />
      </PopoverTrigger>
    ),
    [editorHandle],
  );

  const [internalDay, setInternalDay] = useState<string>();
  const selectedDay = day ?? internalDay;
  const setSelectedDay = useCallback(
    (nextDay?: string) => {
      if (onDayChange) onDayChange(nextDay);
      else setInternalDay(nextDay);
    },
    [onDayChange],
  );
  const [createKind, setCreateKind] = useState<CreateKind>(null);
  const onCreateOpenChange = useCallback((open: boolean) => {
    if (!open) setCreateKind(null);
  }, []);
  const selectedItems = useMemo(
    () =>
      selectedDay
        ? items.filter((item) => itemIncludesDay(item, selectedDay))
        : NO_ITEMS,
    [items, selectedDay],
  );
  const selectedSummary = selectedDay
    ? (data?.days[selectedDay] ?? EMPTY_DAY_SUMMARY)
    : EMPTY_DAY_SUMMARY;
  // Returning false keeps the engine's own "+N more" popover closed: the day
  // sheet is the one overflow surface on this page.
  const openDay = (moreDay: Date) => {
    setSelectedDay(formatPlainDate(moreDay));
    return false as const;
  };
  const calendarInteractionProps = {
    events,
    date: anchor,
    timeZone: HOUSEHOLD_TIMEZONE,
    activation: CALENDAR_ACTIVATION,
    loading: isLoading,
    renderEventRoot,
    onEventsChange: setEvents,
    onEventUpdate: persistMove,
    canDropEvent: canDropCalendarEvent,
    onSlotClick: (slot: { date: Date }) =>
      setSelectedDay(formatPlainDate(slot.date)),
  };
  const periodTitle = formatCalendarPeriodTitle(
    period === "month" ? anchor : activePeriod.start,
    period,
    activePeriod.end,
  );
  const shiftAnchor = (direction: -1 | 1) =>
    onDateChange(
      formatPlainDate(
        shiftCalendarPeriod(parsePlainDate(anchorDate), period, direction),
      ),
    );

  return (
    <>
      <Stack gap="sm">
        <Row align="center" wrap gap="xs">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={`Previous ${period}`}
            onClick={() => shiftAnchor(-1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onDateChange(undefined)}
          >
            Today
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={`Next ${period}`}
            onClick={() => shiftAnchor(1)}
          >
            <ChevronRight />
          </Button>
          <h2 className="font-heading text-base font-semibold">
            {periodTitle}
          </h2>
          <ChoiceSwitcher
            className="ml-auto"
            ariaLabel="Calendar period"
            options={lockedKinds ? GRID_PERIOD_OPTIONS : PERIOD_OPTIONS}
            value={period}
            onValueChange={onPeriodChange}
          />
        </Row>

        {period === "schedule" ? (
          <CalendarScheduleRead input={scheduleRange} />
        ) : isError ? (
          <CalendarRangeError error={error} onRetry={() => void refetch()} />
        ) : null}

        {/* Both trees render; the BREAKPOINT decides, not JS. `useIsMobile`
            reports false on the server, so a JS-only switch would paint the
            seven-column grid on a phone until hydration — the same trap
            `RTable` documents at length. */}
        {period !== "schedule" && !isError && (
          <>
            <div className="md:hidden">
              <CalendarAgenda
                items={items}
                includesDay={itemIncludesDay}
                range={activePeriod}
                today={today}
                showAllDays={period !== "month"}
                onDayClick={setSelectedDay}
                renderItem={renderAgendaItem}
                emptyMessage={
                  <Description>
                    Nothing planned this {period}.{" "}
                    <button
                      type="button"
                      className="inline-flex min-h-11 items-center underline hover:text-primary md:min-h-0"
                      onClick={() =>
                        setCreateKind(
                          (lockedKinds ?? filters?.kinds ?? ALL_KINDS)[0] ??
                            "meal",
                        )
                      }
                    >
                      Add something
                    </button>
                    .
                  </Description>
                }
              />
            </div>

            {period === "month" ? (
              <MonthEventCalendar<CalendarItem>
                {...calendarInteractionProps}
                renderEvent={CalendarMonthChip}
                className="hidden min-h-[620px] overflow-hidden border md:block"
                onMoreClick={openDay}
              />
            ) : period === "fortnight" ? (
              <FortnightEventCalendar<CalendarItem>
                {...calendarInteractionProps}
                renderEvent={CalendarFortnightChip}
                className="hidden overflow-hidden border md:block"
                style={FORTNIGHT_DENSITY}
                onMoreClick={openDay}
              />
            ) : (
              <div className="hidden overflow-hidden border md:block">
                <WeekSummaryGrid
                  days={periodDays}
                  summaries={data?.days ?? NO_DAY_SUMMARIES}
                  today={today}
                  onDayClick={setSelectedDay}
                />
                <WeekEventCalendar<CalendarItem>
                  {...calendarInteractionProps}
                  renderEvent={CalendarWeekCard}
                  className="border-0 border-t"
                />
              </div>
            )}
          </>
        )}
      </Stack>

      {period !== "schedule" && (
        <CalendarDaySheet
          day={selectedDay}
          items={selectedItems}
          summary={selectedSummary}
          onOpenChange={(open) => {
            if (!open) setSelectedDay(undefined);
          }}
          onCreate={setCreateKind}
          renderItem={(item) => (
            <PopoverTrigger
              handle={editorHandle}
              payload={item}
              className={calendarItemTriggerClassName(item)}
              onClick={() => {
                requestAnimationFrame(() => setSelectedDay(undefined));
              }}
            >
              <CalendarItemPresentation item={item} variant="rich" />
            </PopoverTrigger>
          )}
        />
      )}

      <CalendarItemInspector handle={editorHandle} />

      {createKind ? (
        <Suspense fallback={null}>
          <LazyCalendarCreateDialog
            kind={createKind}
            date={selectedDay}
            onOpenChange={onCreateOpenChange}
          />
        </Suspense>
      ) : null}
    </>
  );
}

function CalendarDaySheet({
  day,
  items,
  summary,
  onOpenChange,
  onCreate,
  renderItem,
}: {
  day?: string;
  items: CalendarItem[];
  summary: CalendarDaySummary;
  onOpenChange: (open: boolean) => void;
  onCreate: (kind: CalendarItemKind) => void;
  renderItem: (item: CalendarItem) => ReactNode;
}) {
  return (
    <ResponsiveSheet
      open={Boolean(day)}
      onOpenChange={onOpenChange}
      title={
        day
          ? format(householdCalendarDate(day), "EEEE, MMMM d")
          : "Calendar day"
      }
      description={
        items.length === 0
          ? "Nothing planned yet."
          : `${items.length} calendar ${items.length === 1 ? "item" : "items"}`
      }
      className="sm:max-w-md"
    >
      <Stack gap="md">
        <div className="grid grid-cols-2 gap-2 border-y py-2 text-xs">
          <SummaryValue
            label="Actual spend"
            value={formatCurrency(summary.actualSpend)}
          />
          <SummaryValue
            label="Planned spend"
            value={formatCurrency(summary.plannedSpend)}
          />
          <SummaryValue label="Tasks" value={String(summary.taskCount)} />
          <SummaryValue
            label="Calories"
            value={formatEstimate(
              summary.mealTotals.nutrition.kcal,
              (value) => `${Math.round(value).toLocaleString()} kcal`,
            )}
          />
        </div>

        <Stack gap="xs">
          <span className="font-mono text-xs tracking-wider text-slate uppercase">
            Add
          </span>
          <Row wrap gap="xs">
            {ALL_KINDS.map((kind) => {
              const Icon = KIND_ICONS[kind];
              return (
                <Button
                  key={kind}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onCreate(kind)}
                >
                  <Plus />
                  <Icon />
                  {kind === "expense" ? "Planned expense" : KIND_LABELS[kind]}
                </Button>
              );
            })}
          </Row>
        </Stack>

        <Stack gap="xs">
          {items.map((item) => (
            <div key={`${item.kind}:${item.id}`}>{renderItem(item)}</div>
          ))}
        </Stack>
      </Stack>
    </ResponsiveSheet>
  );
}

function CalendarRangeError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <ErrorDisplay
      error={error}
      title="the calendar"
      onRetry={onRetry}
      className="border border-destructive/40 bg-destructive/5 px-2 py-2 md:px-3 md:py-1.5"
    />
  );
}

function SummaryValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono tracking-wider text-slate uppercase">
        {label}
      </div>
      <div className="font-semibold tabular-nums">{value}</div>
    </div>
  );
}
