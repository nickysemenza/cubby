import type {
  CalendarDaySummary,
  CalendarItem,
  CalendarItemKind,
} from "@cubby/schemas/calendar";
import { projectKindValues } from "@cubby/schemas/project";
import { TZDate } from "@date-fns/tz";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  addDays,
  addMonths,
  endOfMonth,
  format,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import {
  CalendarRange,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  CookingPot,
  Plus,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { CreateExpenseDialog } from "~/app/expenses/create-expense-dialog";
import { CreateMealDialog } from "~/app/meals/create-meal-dialog";
import { CreateProjectDialog } from "~/app/projects/create-project-dialog";
import { capitalize } from "~/app/projects/project-formatting";
import { CreateTaskDialog } from "~/app/tasks/create-task-dialog";
import { Row, Stack } from "~/components/layout";
import {
  EventCalendar,
  type EventCalendarRenderEventProps,
} from "~/components/reui/event-calendar/event-calendar";
import { EventCalendarMonthView } from "~/components/reui/event-calendar/event-calendar-month-view";
import type {
  CalendarEvent,
  CalendarView,
  EventCalendarProposedUpdate,
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
import { useTRPC } from "~/integrations/trpc/react";
import { householdLocalDate } from "~/lib/household-date";
import { formatPlainDate, parsePlainDate } from "~/lib/plain-date";
import {
  expenseMutationInvalidateKeys,
  mealMutationInvalidateKeys,
  taskMutationInvalidateKeys,
} from "~/lib/query-keys";
import { cn, formatCurrency } from "~/lib/utils";

const HOUSEHOLD_TIME_ZONE = "America/Los_Angeles";
const CALENDAR_VIEWS: CalendarView[] = ["month"];
const CALENDAR_INTERACTIONS = {
  drag: true,
  resize: false,
  selectSlot: false,
} as const;
const CALENDAR_ACTIVATION = {
  touchDelayMs: 350,
  touchTolerancePx: 12,
} as const;
const CALENDAR_CLASS_NAMES = {
  monthHeader: "bg-muted",
  monthDayHeader: "font-mono uppercase tracking-wider",
  monthCellContent: "min-h-24 sm:min-h-28",
  monthBar: "z-10",
} as const;
const ALL_KINDS: CalendarItemKind[] = ["meal", "task", "expense", "project"];
const NO_ITEMS: CalendarItem[] = [];

const KIND_LABELS: Record<CalendarItemKind, string> = {
  meal: "Meals",
  task: "Tasks",
  expense: "Expenses",
  project: "Projects",
};

const KIND_ICONS: Record<CalendarItemKind, typeof CookingPot> = {
  meal: CookingPot,
  task: CheckSquare,
  expense: CircleDollarSign,
  project: CalendarRange,
};

const KIND_COLORS: Record<CalendarItemKind, string> = {
  meal: "var(--positive)",
  task: "var(--plum)",
  expense: "var(--primary)",
  project: "var(--slate)",
};

type CreateKind = CalendarItemKind | null;

interface UnifiedCalendarProps {
  date?: string;
  day?: string;
  kinds?: string;
  projectKinds?: string;
  lockedKinds?: CalendarItemKind[];
  onDateChange: (date?: string) => void;
  onDayChange?: (day?: string) => void;
  onKindsChange?: (kinds?: string) => void;
  onProjectKindsChange?: (projectKinds?: string) => void;
}

const parseSelection = <T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): T[] => {
  if (!value) return [...allowed];
  const selected = value
    .split(",")
    .filter((entry): entry is T => allowed.includes(entry as T));
  return selected.length > 0 ? selected : [...allowed];
};

const calendarDate = (plainDate: string) => {
  const parsed = parsePlainDate(plainDate);
  return new TZDate(
    parsed.getFullYear(),
    parsed.getMonth(),
    parsed.getDate(),
    HOUSEHOLD_TIME_ZONE,
  );
};

const eventClassName = (item: CalendarItem, today: string) => {
  if (item.kind === "project") {
    return "bg-muted py-1 hover:bg-muted dark:bg-muted dark:hover:bg-muted";
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
  start: calendarDate(item.startDate),
  end: calendarDate(item.endDateExclusive),
  allDay: true,
  readOnly: item.interaction === "read-only",
  draggable: item.interaction === "move",
  resizable: false,
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
      : KIND_COLORS[item.kind],
  className: eventClassName(item, today),
  data: item,
});

function CalendarChip({
  occurrence,
}: EventCalendarRenderEventProps<CalendarItem>) {
  const item = occurrence.event.data;
  if (!item) return occurrence.event.title;
  const Icon = KIND_ICONS[item.kind];
  return (
    <>
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="truncate" title={item.title}>
        {item.title}
      </span>
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

const summarizeDay = (items: CalendarItem[]): CalendarDaySummary => {
  const summary: CalendarDaySummary = {
    actualSpend: 0,
    plannedSpend: 0,
    calories: 0,
    nutritionPending: false,
    taskCount: 0,
    expenseCount: 0,
    mealCount: 0,
    projectCount: 0,
  };
  for (const item of items) {
    if (item.kind === "meal") {
      summary.mealCount += 1;
      summary.calories += item.calories;
      summary.nutritionPending ||= item.nutritionPending;
    } else if (item.kind === "task") {
      summary.taskCount += 1;
    } else if (item.kind === "expense") {
      summary.expenseCount += 1;
      if (item.future) summary.plannedSpend += item.cost ?? 0;
      else summary.actualSpend += item.cost ?? 0;
    } else {
      summary.projectCount += 1;
    }
  }
  return summary;
};

export function UnifiedCalendar({
  date,
  day,
  kinds,
  projectKinds,
  lockedKinds,
  onDateChange,
  onDayChange,
  onKindsChange,
  onProjectKindsChange,
}: UnifiedCalendarProps) {
  const api = useTRPC();
  const today = householdLocalDate();
  const anchorDate = date ?? today;
  const anchor = calendarDate(anchorDate);
  const monthGridStart = startOfWeek(startOfMonth(anchor), {
    weekStartsOn: 0,
  });
  const monthGridEnd = addDays(
    startOfWeek(endOfMonth(anchor), { weekStartsOn: 0 }),
    7,
  );
  const range = useMemo(
    () => ({
      startDate: formatPlainDate(monthGridStart),
      endDateExclusive: formatPlainDate(monthGridEnd),
    }),
    [monthGridEnd, monthGridStart],
  );
  const { data, isLoading, isError } = useQuery(
    api.calendar.range.queryOptions(range),
  );
  const items = data?.items ?? NO_ITEMS;

  const activeKinds = useMemo(
    () => lockedKinds ?? parseSelection(kinds, ALL_KINDS),
    [kinds, lockedKinds],
  );
  const activeProjectKinds = useMemo(
    () => parseSelection(projectKinds, projectKindValues),
    [projectKinds],
  );
  const visibleItems = useMemo(
    () =>
      items.filter(
        (item) =>
          activeKinds.includes(item.kind) &&
          (item.kind !== "project" ||
            item.projectKind == null ||
            activeProjectKinds.includes(item.projectKind)),
      ),
    [activeKinds, activeProjectKinds, items],
  );
  const sourceEvents = useMemo(
    () => visibleItems.map((item) => toEvent(item, today)),
    [today, visibleItems],
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
        ? visibleItems.filter((item) => itemIncludesDay(item, selectedDay))
        : NO_ITEMS,
    [selectedDay, visibleItems],
  );

  const toggleKind = (kind: CalendarItemKind) => {
    if (!onKindsChange) return;
    const next = activeKinds.includes(kind)
      ? activeKinds.filter((value) => value !== kind)
      : [...activeKinds, kind];
    onKindsChange(
      next.length === ALL_KINDS.length || next.length === 0
        ? undefined
        : ALL_KINDS.filter((value) => next.includes(value)).join(","),
    );
  };

  const toggleProjectKind = (kind: (typeof projectKindValues)[number]) => {
    if (!onProjectKindsChange) return;
    const next = activeProjectKinds.includes(kind)
      ? activeProjectKinds.filter((value) => value !== kind)
      : [...activeProjectKinds, kind];
    onProjectKindsChange(
      next.length === projectKindValues.length || next.length === 0
        ? undefined
        : projectKindValues.filter((value) => next.includes(value)).join(","),
    );
  };

  return (
    <>
      <Stack gap="sm">
        <Row align="center" wrap gap="xs">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Previous month"
            onClick={() =>
              onDateChange(
                formatPlainDate(addMonths(parsePlainDate(anchorDate), -1)),
              )
            }
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
            aria-label="Next month"
            onClick={() =>
              onDateChange(
                formatPlainDate(addMonths(parsePlainDate(anchorDate), 1)),
              )
            }
          >
            <ChevronRight />
          </Button>
          <h2 className="font-heading font-semibold text-base">
            {format(anchor, "MMMM yyyy")}
          </h2>
          {!lockedKinds && (
            <Row className="ml-auto" align="center" wrap gap="xs">
              {ALL_KINDS.map((kind) => {
                const Icon = KIND_ICONS[kind];
                const active = activeKinds.includes(kind);
                return (
                  <Button
                    key={kind}
                    type="button"
                    size="sm"
                    variant={active ? "secondary" : "outline"}
                    aria-pressed={active}
                    onClick={() => toggleKind(kind)}
                  >
                    <Icon />
                    {KIND_LABELS[kind]}
                  </Button>
                );
              })}
            </Row>
          )}
        </Row>

        {!lockedKinds && activeKinds.includes("project") && (
          <Row align="center" wrap gap="xs">
            <Description as="span">Project kind</Description>
            {projectKindValues.map((kind) => {
              const active = activeProjectKinds.includes(kind);
              return (
                <Button
                  key={kind}
                  type="button"
                  size="xs"
                  variant={active ? "secondary" : "ghost"}
                  aria-pressed={active}
                  onClick={() => toggleProjectKind(kind)}
                >
                  {capitalize(kind)}
                </Button>
              );
            })}
          </Row>
        )}

        {isError && (
          <Description>
            The calendar could not be loaded. Try refreshing this page.
          </Description>
        )}

        <EventCalendar<CalendarItem>
          events={events}
          view="month"
          views={CALENDAR_VIEWS}
          date={anchor}
          timeZone={HOUSEHOLD_TIME_ZONE}
          fixedWeeks
          interactions={CALENDAR_INTERACTIONS}
          activation={CALENDAR_ACTIVATION}
          loading={isLoading}
          maxEventsPerCell={5}
          showOutsideDays
          showDayAddButton
          scrollMode="page"
          className="min-h-[620px] overflow-hidden rounded-md border"
          classNames={CALENDAR_CLASS_NAMES}
          renderEvent={CalendarChip}
          onEventsChange={setEvents}
          onEventUpdate={persistMove}
          canDropEvent={canDropCalendarEvent}
          onEventClick={(occurrence, event) => {
            event.preventDefault();
            setSelectedDay(formatPlainDate(occurrence.start));
          }}
          onSlotClick={(slot) => setSelectedDay(formatPlainDate(slot.date))}
          onMoreClick={(moreDay) => {
            setSelectedDay(formatPlainDate(moreDay));
            return false;
          }}
        >
          <EventCalendarMonthView maxEventsPerCell={5} />
        </EventCalendar>
      </Stack>

      <CalendarDaySheet
        day={selectedDay}
        items={selectedItems}
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
  onOpenChange,
  onCreate,
}: {
  day?: string;
  items: CalendarItem[];
  onOpenChange: (open: boolean) => void;
  onCreate: (kind: CalendarItemKind) => void;
}) {
  const summary = summarizeDay(items);
  return (
    <Sheet open={Boolean(day)} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>
            {day ? format(calendarDate(day), "EEEE, MMMM d") : "Calendar day"}
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

function CalendarItemLink({ item }: { item: CalendarItem }) {
  const Icon = KIND_ICONS[item.kind];
  const content: ReactNode = (
    <>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate" title={item.title}>
        {item.title}
      </span>
      {item.kind === "expense" && item.cost != null && (
        <span className="shrink-0 tabular-nums">
          {formatCurrency(item.cost)}
        </span>
      )}
    </>
  );
  const className = cn(
    "flex items-center gap-2 border-b py-2 text-sm last:border-b-0 hover:text-primary",
    item.kind === "expense" && item.future && "text-warning",
  );

  if (item.kind === "meal") {
    return (
      <Link to="/meals/$id" params={{ id: item.id }} className={className}>
        {content}
      </Link>
    );
  }
  if (item.kind === "task") {
    return (
      <Link to="/tasks/$id" params={{ id: item.id }} className={className}>
        {content}
      </Link>
    );
  }
  if (item.kind === "expense") {
    return (
      <Link to="/expenses/$id" params={{ id: item.id }} className={className}>
        {content}
      </Link>
    );
  }
  return (
    <Link to="/projects/$id" params={{ id: item.id }} className={className}>
      {content}
    </Link>
  );
}
