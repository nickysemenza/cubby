import type {
  CalendarDaySummary,
  CalendarItem,
  CalendarItemKind,
} from "@cubby/schemas/calendar";
import { MEAL_KIND_LABELS } from "@cubby/schemas/meal-classification";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { addDays, format } from "date-fns";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { CreateExpenseDialog } from "~/app/expenses/create-expense-dialog";
import { CreateMealDialog } from "~/app/meals/create-meal-dialog";
import { mealKindIcon } from "~/app/meals/meal-options";
import { CreateProjectDialog } from "~/app/projects/create-project-dialog";
import { CreateTaskDialog } from "~/app/tasks/create-task-dialog";
import { Row, Stack } from "~/components/layout";
import {
  type EventCalendarRenderEventProps,
  MonthEventCalendar,
  WeekEventCalendar,
} from "~/components/reui/event-calendar/event-calendar";
import type {
  CalendarEvent,
  CalendarPeriod,
  EventCalendarOccurrence,
  EventCalendarProposedUpdate,
  EventCalendarSegment,
} from "~/components/reui/event-calendar/event-calendar-types";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";
import { ChoiceSwitcher } from "~/components/ui/view-switcher";
import { ENTITY_ACCENTS } from "~/entities/entity-accents";
import { useTRPC } from "~/integrations/trpc/react";
import { HOUSEHOLD_TIMEZONE, householdLocalDate } from "~/lib/household-date";
import { formatPlainDate, parsePlainDate } from "~/lib/plain-date";
import {
  expenseMutationInvalidateKeys,
  mealMutationInvalidateKeys,
  taskMutationInvalidateKeys,
} from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import { CalendarAgenda } from "./calendar-agenda";
import type { CalendarFilters } from "./calendar-filters";
import { itemIcon, KIND_ICONS } from "./calendar-icons";
import { CalendarItemLink } from "./calendar-item-row";
import {
  formatCalendarPeriodTitle,
  getCalendarPeriodRange,
  householdCalendarDate,
  shiftCalendarPeriod,
} from "./calendar-period";
import { itemSpanLabel } from "./calendar-span";
import { EMPTY_DAY_SUMMARY, WeekSummaryGrid } from "./calendar-week-summary";

const CALENDAR_ACTIVATION = {
  touchDelayMs: 350,
  touchTolerancePx: 12,
} as const;
const ALL_KINDS: CalendarItemKind[] = ["meal", "task", "expense", "project"];
const NO_ITEMS: CalendarItem[] = [];
const PERIOD_OPTIONS = [
  { value: "month", label: "Month" },
  { value: "week", label: "Week" },
] as const;

const KIND_LABELS: Record<CalendarItemKind, string> = {
  meal: "Meals",
  task: "Tasks",
  expense: "Expenses",
  project: "Projects",
};

// No second color map. A calendar chip and the entity's own chrome are the
// same claim about the same record, and keeping two hand-written maps let them
// drift: before this, `task` and `project` were exactly swapped between them
// and only `expense` agreed. DESIGN.md sanctions one categorical hue channel
// (the project Gantt); this is the entity accent ladder, not a second one.

type CreateKind = CalendarItemKind | null;

interface UnifiedCalendarProps {
  period: CalendarPeriod;
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
  onPeriodChange: (period: CalendarPeriod) => void;
  onDateChange: (date?: string) => void;
  onDayChange?: (day?: string) => void;
}

const eventClassName = (item: CalendarItem, today: string) => {
  if (item.kind === "project") {
    return "bg-muted py-1 hover:bg-muted dark:bg-muted dark:hover:bg-muted";
  }
  // A meal you aren't cooking reads as provisional at a glance, the same way a
  // not-yet-real expense does directly below. Dashed, not recolored: the fill
  // still has to say "meal" against tasks and expenses.
  if (item.kind === "meal" && item.mealKind !== "cooked") {
    return "border border-dashed border-slate";
  }
  if (item.kind === "expense" && item.future) {
    return item.startDate < today
      ? "border border-dashed border-destructive bg-destructive/10 hover:bg-destructive/15 dark:bg-destructive/10 dark:hover:bg-destructive/15"
      : "border border-dashed border-warning bg-warning/10 hover:bg-warning/15 dark:bg-warning/10 dark:hover:bg-warning/15";
  }
  return undefined;
};

const canDropCalendarEvent = (
  update: EventCalendarProposedUpdate<CalendarItem>,
) => update.event.data?.interaction === "move";

const toEvent = (
  item: CalendarItem,
  today: string,
): CalendarEvent<CalendarItem> => ({
  id: `${item.kind}:${item.id}`,
  title: item.title,
  start: householdCalendarDate(item.startDate),
  end: householdCalendarDate(item.endDateExclusive),
  allDay: true,
  readOnly: item.interaction === "read-only",
  draggable: item.interaction === "move",
  priority:
    item.kind === "project"
      ? 100
      : item.kind === "task" && item.endDateExclusive > item.startDate
        ? 50
        : 10,
  color:
    item.kind === "expense" && item.future
      ? item.startDate < today
        ? "var(--destructive)"
        : "var(--warning)"
      : ENTITY_ACCENTS[item.kind],
  className: eventClassName(item, today),
  data: item,
});

function CalendarChip({
  occurrence,
  segment,
}: EventCalendarRenderEventProps<CalendarItem>) {
  const item = occurrence.event.data;
  if (!item) return occurrence.event.title;
  const Icon = itemIcon(item);
  // Only non-cooked meals get one — see MEAL_KIND_ICONS.
  const kind = item.kind === "meal" ? item.mealKind : null;
  const KindIcon = kind ? mealKindIcon(kind) : null;
  const span = itemSpanLabel(item);
  // Repeated on EVERY week row of a span, not just the one carrying its start:
  // a bar is re-drawn per week, so gating on `segment.isStart` would leave five
  // of a six-week project's rows saying nothing. Dropped on bars too narrow to
  // hold it — `colSpan` is the merged week-row width from `packWeekRowLanes`.
  const spanLabel = span && (segment.colSpan ?? 1) >= 3 ? span : null;
  return (
    <>
      <Icon className="size-3 shrink-0" aria-hidden />
      <span
        className="truncate"
        title={span ? `${item.title} (${span})` : item.title}
      >
        {item.title}
      </span>
      {spanLabel && (
        <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
          {spanLabel}
        </span>
      )}
      {KindIcon && kind && (
        <KindIcon
          className="ml-auto size-3 shrink-0"
          aria-label={MEAL_KIND_LABELS[kind]}
        />
      )}
      {item.kind === "expense" && item.cost != null && (
        <span className="ml-auto shrink-0 tabular-nums">
          {formatCurrency(item.cost, 0)}
        </span>
      )}
    </>
  );
}

const itemIncludesDay = (item: CalendarItem, day: string) =>
  item.startDate <= day && item.endDateExclusive > day;

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
  const api = useTRPC();
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
  const { data, isLoading, isError } = useQuery({
    ...api.calendar.range.queryOptions(range),
    // Without this every chip toggle blanks the month grid mid-flight.
    placeholderData: keepPreviousData,
  });
  const items = data?.items ?? NO_ITEMS;

  const sourceEvents = useMemo(
    () => items.map((item) => toEvent(item, today)),
    [items, today],
  );
  const [events, setEvents] =
    useState<CalendarEvent<CalendarItem>[]>(sourceEvents);
  useEffect(() => setEvents(sourceEvents), [sourceEvents]);

  const mealUpdate = useUpdateMutation({
    mutationFn: api.meal.update.mutationOptions,
    entity: "meal",
    invalidateKeys: mealMutationInvalidateKeys,
  });
  const taskUpdate = useUpdateMutation({
    mutationFn: api.task.update.mutationOptions,
    entity: "task",
    invalidateKeys: taskMutationInvalidateKeys,
  });
  const expenseUpdate = useUpdateMutation({
    mutationFn: api.expense.update.mutationOptions,
    entity: "expense",
    invalidateKeys: expenseMutationInvalidateKeys,
  });

  const persistMove = useCallback(
    (update: EventCalendarProposedUpdate<CalendarItem>) => {
      const item = update.event.data;
      if (item?.interaction !== "move") return false;
      const nextStart = formatPlainDate(update.start);
      const nextEndExclusive = formatPlainDate(update.end);
      let request: Promise<unknown>;
      if (item.kind === "meal") {
        request = mealUpdate.mutateAsync({
          id: item.id,
          data: { date: nextStart },
        });
      } else if (item.kind === "task") {
        const wasRange =
          item.endDateExclusive !==
          formatPlainDate(addDays(parsePlainDate(item.startDate), 1));
        request = taskUpdate.mutateAsync({
          id: item.id,
          data: {
            dueDate: nextStart,
            dueEndDate: wasRange
              ? formatPlainDate(addDays(parsePlainDate(nextEndExclusive), -1))
              : null,
          },
        });
      } else if (item.kind === "expense" && item.future) {
        request = expenseUpdate.mutateAsync({
          id: item.id,
          data: { date: nextStart },
        });
      } else {
        return false;
      }
      void request.catch(() => setEvents(sourceEvents));
      return true;
    },
    [mealUpdate, expenseUpdate, sourceEvents, taskUpdate],
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
  const calendarInteractionProps = {
    events,
    date: anchor,
    timeZone: HOUSEHOLD_TIMEZONE,
    activation: CALENDAR_ACTIVATION,
    loading: isLoading,
    renderEvent: CalendarChip,
    onEventsChange: setEvents,
    onEventUpdate: persistMove,
    canDropEvent: canDropCalendarEvent,
    onEventClick: (
      _occurrence: EventCalendarOccurrence<CalendarItem>,
      segment: EventCalendarSegment<CalendarItem>,
      event: ReactMouseEvent,
    ) => {
      event.preventDefault();
      setSelectedDay(formatPlainDate(segment.day));
    },
    onSlotClick: (slot: { date: Date }) =>
      setSelectedDay(formatPlainDate(slot.date)),
  };
  const periodTitle = formatCalendarPeriodTitle(
    period === "week" ? activePeriod.start : anchor,
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
          <h2 className="font-heading font-semibold text-base">
            {periodTitle}
          </h2>
          <ChoiceSwitcher
            className="ml-auto"
            ariaLabel="Calendar period"
            options={PERIOD_OPTIONS}
            value={period}
            onValueChange={onPeriodChange}
          />
        </Row>

        {isError && (
          <Description>
            The calendar could not be loaded. Try refreshing this page.
          </Description>
        )}

        {/* Both trees render; the BREAKPOINT decides, not JS. `useIsMobile`
            reports false on the server, so a JS-only switch would paint the
            seven-column grid on a phone until hydration — the same trap
            `RTable` documents at length. */}
        <div className="md:hidden">
          <CalendarAgenda
            items={items}
            includesDay={itemIncludesDay}
            range={activePeriod}
            today={today}
            showAllDays={period === "week"}
            onDayClick={setSelectedDay}
            emptyMessage={
              <Description>
                Nothing planned this {period}.{" "}
                <button
                  type="button"
                  className="underline hover:text-primary"
                  onClick={() =>
                    setCreateKind(
                      (lockedKinds ?? filters?.kinds ?? ALL_KINDS)[0] ?? "meal",
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
            className="hidden min-h-[620px] overflow-hidden border md:block"
            onMoreClick={(moreDay) => {
              setSelectedDay(formatPlainDate(moreDay));
              return false;
            }}
          />
        ) : (
          <div className="hidden overflow-hidden border md:block">
            <WeekSummaryGrid
              days={periodDays}
              summaries={data?.days ?? {}}
              today={today}
              onDayClick={setSelectedDay}
            />
            <WeekEventCalendar<CalendarItem>
              {...calendarInteractionProps}
              className="border-0 border-t"
            />
          </div>
        )}
      </Stack>

      <CalendarDaySheet
        day={selectedDay}
        items={selectedItems}
        summary={selectedSummary}
        onOpenChange={(open) => {
          if (!open) setSelectedDay(undefined);
        }}
        onCreate={setCreateKind}
      />

      <CreateMealDialog
        open={createKind === "meal"}
        onOpenChange={(open) => {
          if (!open) setCreateKind(null);
        }}
        presetDate={selectedDay}
      />
      <CreateTaskDialog
        open={createKind === "task"}
        onOpenChange={(open) => {
          if (!open) setCreateKind(null);
        }}
        presetDate={selectedDay}
      />
      <CreateExpenseDialog
        open={createKind === "expense"}
        onOpenChange={(open) => {
          if (!open) setCreateKind(null);
        }}
        presetDate={selectedDay}
        presetFuture
      />
      <CreateProjectDialog
        open={createKind === "project"}
        onOpenChange={(open) => {
          if (!open) setCreateKind(null);
        }}
        presetDate={selectedDay}
      />
    </>
  );
}

function CalendarDaySheet({
  day,
  items,
  summary,
  onOpenChange,
  onCreate,
}: {
  day?: string;
  items: CalendarItem[];
  summary: CalendarDaySummary;
  onOpenChange: (open: boolean) => void;
  onCreate: (kind: CalendarItemKind) => void;
}) {
  return (
    <Sheet open={Boolean(day)} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>
            {day
              ? format(householdCalendarDate(day), "EEEE, MMMM d")
              : "Calendar day"}
          </SheetTitle>
          <SheetDescription>
            {items.length === 0
              ? "Nothing planned yet."
              : `${items.length} calendar ${items.length === 1 ? "item" : "items"}`}
          </SheetDescription>
        </SheetHeader>

        <Stack className="px-6 pb-6" gap="md">
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
              value={`${Math.round(summary.calories).toLocaleString()}${summary.nutritionPending ? "+" : ""}`}
            />
          </div>

          <Stack gap="xs">
            <span className="font-mono text-slate text-xs uppercase tracking-wider">
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
              <CalendarItemLink key={`${item.kind}:${item.id}`} item={item} />
            ))}
          </Stack>
        </Stack>
      </SheetContent>
    </Sheet>
  );
}

function SummaryValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-slate uppercase tracking-wider">
        {label}
      </div>
      <div className="font-semibold tabular-nums">{value}</div>
    </div>
  );
}
