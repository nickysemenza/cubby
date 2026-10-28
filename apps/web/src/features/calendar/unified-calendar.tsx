import {
  calendarItemKey,
  calendarSourceEntity,
  type CalendarSourceKind,
  type CalendarDaySummary,
  type CalendarItem,
  type CalendarItemKind,
  type CalendarRangeInput,
} from "@cubby/schemas/calendar";
import type { EntityRef } from "@cubby/schemas/entity";
import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { useQuery } from "@tanstack/react-query";
import { addDays } from "date-fns";
import type { ComponentProps } from "react";
import {
  type CSSProperties,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { toast } from "sonner";
import { z } from "zod";

import { useEntityCommands } from "~/entity/editing/use-entity-commands";
import {
  EntityDisplayImagesProvider,
  entityDisplayImageKey,
} from "~/entity/entity-media/entity-display-images";
import { useEntityPreview } from "~/entity/hooks/use-entity-preview";
import { calendar } from "~/integrations/tanstack-query/domains/calendar";
import { browserOnlyLazy } from "~/lib/browser-only-lazy";
import { formatCalendarDay } from "~/lib/date-format";
import { HOUSEHOLD_TIMEZONE, householdLocalDate } from "~/lib/household-date";
import { formatCurrency } from "~/lib/number-format";
import { formatEstimate } from "~/lib/nutrition-format";
import { formatPlainDate, parsePlainDate } from "~/lib/plain-date";
import { Picker } from "~/ui/combobox/picker";
import { showErrorToast } from "~/ui/feedback/error-details";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useHouseholdToday } from "~/ui/hooks/use-household-today";
import { useHydratedLoading } from "~/ui/hooks/use-hydrated";
import { useLocalStorage } from "~/ui/hooks/use-local-storage";
import { useIsMobile } from "~/ui/hooks/use-mobile";
import { Row, Stack } from "~/ui/layout";
import { Overlay } from "~/ui/overlays/overlay";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/primitives/description";
import { createPopoverHandle, PopoverTrigger } from "~/ui/primitives/popover";
import { Spinner } from "~/ui/primitives/spinner";
import { Switch } from "~/ui/primitives/switch";
import {
  type EventCalendarRenderEventProps,
  type EventCalendarRenderEventRoot,
  FortnightEventCalendar,
  MonthEventCalendar,
  WeekEventCalendar,
} from "~/ui/reui/event-calendar/event-calendar";
import type {
  CalendarEvent,
  EventCalendarProposedUpdate,
} from "~/ui/reui/event-calendar/event-calendar-types";

import { CalendarAgenda } from "./calendar-agenda";
import type { CalendarCreateDialog as CalendarCreateDialogComponent } from "./calendar-create-dialog";
import type { CalendarFilters } from "./calendar-filters";
import { KIND_ICONS } from "./calendar-icons";
import { CalendarItemInspector } from "./calendar-item-inspector";
import {
  CalendarItemPresentation,
  calendarItemTriggerClassName,
} from "./calendar-item-row";
import { calendarItemPresentation } from "./calendar-kind-registry";
import { CalendarOverview } from "./calendar-overview";
import {
  formatCalendarPeriodTitle,
  getCalendarPeriodRange,
  householdCalendarDate,
  isLongCalendarPeriod,
  shiftCalendarPeriod,
  type CalendarViewPeriod,
} from "./calendar-period";
import { CalendarSchedule } from "./calendar-schedule";
import { EMPTY_DAY_SUMMARY, WeekSummaryGrid } from "./calendar-week-summary";

const CALENDAR_ACTIVATION = {
  touchDelayMs: 350,
  touchTolerancePx: 12,
} as const;
const CREATE_KINDS = ["meal", "task", "expense", "project"] as const;
type CreatableKind = (typeof CREATE_KINDS)[number];

function defaultCreateKind(source?: CalendarSourceKind): CreatableKind {
  const entity = calendarSourceEntity(source ?? "meal");
  return entity === "planting" ? "task" : entity;
}
const NO_ITEMS: CalendarItem[] = [];
const NO_DAY_SUMMARIES: Record<string, CalendarDaySummary> = {};
const GRID_PERIOD_OPTIONS = [
  { value: "week", label: "Week" },
  { value: "fortnight", label: "Fortnight" },
  { value: "month", label: "Month" },
] as const;
const ALIGN_WEEKDAYS_SCHEMA = z.boolean();
const DATE_PERIOD_GROUP = { id: "dates", label: "Date grid", order: 0 };
const PERIOD_OPTIONS = [
  ...GRID_PERIOD_OPTIONS.map((option) => ({
    ...option,
    group: DATE_PERIOD_GROUP,
  })),
  { value: "quarter", label: "3 months", group: DATE_PERIOD_GROUP },
  { value: "half-year", label: "6 months", group: DATE_PERIOD_GROUP },
  { value: "year", label: "Year", group: DATE_PERIOD_GROUP },
  {
    value: "schedule",
    label: "Schedule",
    group: { id: "schedule", label: "Timeline", order: 1 },
  },
] as const;
// SAFETY: the calendar's custom properties also drive lane placement and drag
// geometry; compact styling must not scale the painted chips independently.
const MONTH_DENSITY = {
  "--ec-month-row-min-h": "6rem",
  "--ec-month-bar-h": "1.375rem",
} as CSSProperties;
/**
 * Fortnight keeps a taller unit for two-line metadata. A crossing bar is one
 * line of text and takes one unit; a single-day chip carries two lines and takes two. The
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

const LazyCalendarCreateDialog = browserOnlyLazy<
  ComponentProps<typeof CalendarCreateDialogComponent>
>(
  import.meta.env.SSR
    ? null
    : () =>
        import("./calendar-create-dialog").then(({ CalendarCreateDialog }) => ({
          default: CalendarCreateDialog,
        })),
);

const KIND_LABELS = {
  meal: "Meals",
  task: "Tasks",
  expense: "Expenses",
  purchase: "Purchases",
  project: "Projects",
  // Never indexed at runtime: `CREATE_KINDS` (this file's day-sheet
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

type CreateKind = CreatableKind | null;

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
  lockedKinds?: CalendarSourceKind[];
  onPeriodChange: (period: CalendarViewPeriod) => void;
  onDateChange: (date?: string) => void;
  onDayChange?: (day?: string) => void;
  /** Surface-specific toolbar controls for the period being shown. */
  periodActions?: (range: {
    startDate: string;
    endDateExclusive: string;
  }) => ReactNode;
}

function PeriodActions({
  render,
  range,
}: {
  render: UnifiedCalendarProps["periodActions"];
  range: { startDate: string; endDateExclusive: string };
}) {
  return render?.(range) ?? null;
}

const canDropCalendarEvent = (
  update: EventCalendarProposedUpdate<CalendarItem>,
) => update.event.data?.interaction === "move";

const toEvent = (
  item: CalendarItem,
  today: string,
): CalendarEvent<CalendarItem> => ({
  ...calendarItemPresentation(item, today).event,
  id: calendarItemKey(item),
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

const scheduleQueryInput = (
  startDate: string,
  endDateExclusive: string,
  filters?: CalendarFilters,
  lockedKinds?: CalendarSourceKind[],
): CalendarRangeInput => {
  const selectedKinds = (lockedKinds ?? filters?.kinds)?.filter(
    (kind) => kind === "task" || kind === "planting",
  );
  const input: CalendarRangeInput = {
    startDate,
    endDateExclusive,
    filters: {
      task: filters?.filters?.task,
      planting: filters?.filters?.planting,
    },
  };
  if (selectedKinds?.length) {
    input.kinds = [selectedKinds[0]!, ...selectedKinds.slice(1)];
  }
  return input;
};

function CalendarScheduleRead({ input }: { input: CalendarRangeInput }) {
  const { data, isPending, isError, error, refetch } = useQuery(
    calendar.schedule.queryOptions(input),
  );
  const loading = useHydratedLoading(isPending);
  if (loading) return <CalendarLoading label="Loading schedule…" />;
  return (
    <>
      {isError && (
        <CalendarRangeError error={error} onRetry={() => void refetch()} />
      )}
      {data && (
        <CalendarSchedule
          data={data}
          window={{
            startDate: input.startDate,
            endDate: formatPlainDate(
              addDays(parsePlainDate(input.endDateExclusive), -1),
            ),
          }}
        />
      )}
    </>
  );
}

export function UnifiedCalendar({
  period: requestedPeriod,
  date,
  day,
  filters,
  lockedKinds,
  onPeriodChange,
  onDateChange,
  onDayChange,
  periodActions,
}: UnifiedCalendarProps) {
  const isMobile = useIsMobile();
  const alignmentId = useId();
  const period =
    isMobile && isLongCalendarPeriod(requestedPeriod)
      ? "month"
      : requestedPeriod;
  const longPeriod = isLongCalendarPeriod(period);
  const [alignWeekdays, setAlignWeekdays] = useLocalStorage(
    "calendar.align-weekdays",
    ALIGN_WEEKDAYS_SCHEMA,
    true,
  );
  const { inspectRow, PreviewSheet } = useEntityPreview();
  const today = householdLocalDate();
  useHouseholdToday(today);
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
      ...filters,
      ...(lockedKinds ? { kinds: lockedKinds } : {}),
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
  const { data, isPending, isError, error, refetch } = useQuery({
    ...calendar.range.queryOptions(range),
    enabled: period !== "schedule",
  });
  // Query keys own date/filter scope. Same-scope refetches retain their data;
  // another range must never masquerade as the newly selected calendar.
  const isLoading = useHydratedLoading(isPending);
  const items = data?.items ?? NO_ITEMS;
  const imageRefs = useMemo<EntityRef[]>(
    () => items.map((item) => ({ entityKind: item.kind, entityId: item.id })),
    [items],
  );
  const seededImages = useMemo(
    () =>
      Object.fromEntries(
        items.map((item) => [
          entityDisplayImageKey({ entityKind: item.kind, entityId: item.id }),
          fieldValueOf(item.source.fields.displayImages)?.[0] ?? null,
        ]),
      ),
    [items],
  );
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
            due: {
              start: nextStart,
              end: wasRange
                ? formatPlainDate(addDays(parsePlainDate(nextEndExclusive), -1))
                : null,
            },
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
  // Which items a day holds is the server's `days[day].itemIds`, not a span
  // comparison here — native renders the same buckets.
  const itemIncludesDay = useCallback(
    (item: CalendarItem, day: string) =>
      data?.days[day]?.itemIds.includes(calendarItemKey(item)) ?? false,
    [data],
  );
  const selectedItems = useMemo(
    () =>
      selectedDay
        ? items.filter((item) => itemIncludesDay(item, selectedDay))
        : NO_ITEMS,
    [items, selectedDay, itemIncludesDay],
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
    <EntityDisplayImagesProvider refs={imageRefs} seeded={seededImages}>
      <Stack gap="sm">
        <Row align="center" wrap gap="xs">
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            aria-label={`Previous ${period}`}
            onClick={() => shiftAnchor(-1)}
          >
            <CaretLeftIcon />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="text-xs"
            onClick={() => onDateChange(undefined)}
          >
            Today
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            aria-label={`Next ${period}`}
            onClick={() => shiftAnchor(1)}
          >
            <CaretRightIcon />
          </Button>
          <h2 className="font-heading text-sm font-semibold">{periodTitle}</h2>
          <Row align="center" gap="xs" className="ml-auto">
            <PeriodActions render={periodActions} range={activePeriod} />
            {longPeriod && (
              <label
                htmlFor={alignmentId}
                className="hidden items-center gap-2 text-xs md:flex"
              >
                <Switch
                  id={alignmentId}
                  checked={alignWeekdays}
                  onCheckedChange={setAlignWeekdays}
                />
                Align weekdays
              </label>
            )}
            <Picker
              mode="choose"
              label="Calendar period"
              options={
                lockedKinds
                  ? GRID_PERIOD_OPTIONS
                  : isMobile
                    ? PERIOD_OPTIONS.filter(
                        (option) => !isLongCalendarPeriod(option.value),
                      )
                    : PERIOD_OPTIONS
              }
              value={period}
              onValueChange={(v) => {
                const next = PERIOD_OPTIONS.find(
                  (option) => option.value === v,
                );
                if (next) onPeriodChange(next.value);
              }}
            />
          </Row>
        </Row>

        {period === "schedule" ? (
          <CalendarScheduleRead input={scheduleRange} />
        ) : isLoading ? (
          <CalendarLoading label="Loading calendar…" />
        ) : isError ? (
          <CalendarRangeError error={error} onRetry={() => void refetch()} />
        ) : null}

        {period !== "schedule" && !isLoading && data && items.length === 0 && (
          <output className="text-sm text-muted-foreground">
            No events in this period.
          </output>
        )}

        {/* Both trees render; the BREAKPOINT decides, not JS. `useIsMobile`
            reports false on the server, so a JS-only switch would paint the
            seven-column grid on a phone until hydration — the same trap
            `RTable` documents at length. */}
        {period !== "schedule" && !isLoading && data && (
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
                          defaultCreateKind(
                            (lockedKinds ?? filters?.kinds)?.[0],
                          ),
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

            {longPeriod ? (
              <CalendarOverview
                start={activePeriod.start}
                end={activePeriod.end}
                events={sourceEvents}
                summaries={data.days}
                today={today}
                aligned={alignWeekdays}
                selectedDay={selectedDay}
                onDayChange={setSelectedDay}
                onInspect={(item) =>
                  inspectRow({
                    original: { id: item.id, entityKind: item.kind },
                  })
                }
              />
            ) : period === "month" ? (
              <MonthEventCalendar<CalendarItem>
                {...calendarInteractionProps}
                renderEvent={CalendarMonthChip}
                className="hidden min-h-[620px] overflow-hidden border md:block [&_[data-slot=event-calendar-event]]:gap-1 [&_[data-slot=event-calendar-event]]:px-1 [&_[data-slot=event-calendar-event]]:py-0.5 [&_[data-slot=event-calendar-event]]:leading-4 [&_[data-slot=event-calendar-month-bar-overlay]]:pt-1 [&_[data-slot=event-calendar-month-cell-content]]:min-h-0 [&_[data-slot=event-calendar-month-cell-content]]:pt-1 [&_[data-slot=event-calendar-month-day-number]]:size-4 [&_[data-slot=event-calendar-month-day-number]]:text-2xs [&_[role=columnheader]]:py-1 [&_[role=columnheader]]:text-2xs"
                style={MONTH_DENSITY}
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

      {period !== "schedule" && !longPeriod && !isLoading && data && (
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
      <PreviewSheet />

      {createKind ? (
        <Suspense fallback={null}>
          <LazyCalendarCreateDialog
            kind={createKind}
            date={selectedDay}
            onOpenChange={onCreateOpenChange}
          />
        </Suspense>
      ) : null}
    </EntityDisplayImagesProvider>
  );
}

function CalendarLoading({ label }: { label: string }) {
  return (
    <output
      className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground"
      aria-live="polite"
    >
      <Spinner aria-hidden="true" className="motion-reduce:animate-none" />
      {label}
    </output>
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
  onCreate: (kind: CreatableKind) => void;
  renderItem: (item: CalendarItem) => ReactNode;
}) {
  return (
    <Overlay
      placement="panel"
      open={Boolean(day)}
      onOpenChange={onOpenChange}
      title={
        day
          ? formatCalendarDay(householdCalendarDate(day), "weekdayLongMonthDay")
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
              "kcal",
              "kcal",
            )}
          />
        </div>

        <Stack gap="xs">
          <span className="text-xs font-medium text-slate">Add</span>
          <Row wrap gap="xs">
            {CREATE_KINDS.map((kind) => {
              const Icon = KIND_ICONS[kind];
              return (
                <Button
                  key={kind}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onCreate(kind)}
                >
                  <PlusIcon />
                  <Icon />
                  {kind === "expense" ? "Planned expense" : KIND_LABELS[kind]}
                </Button>
              );
            })}
          </Row>
        </Stack>

        <Stack gap="xs">
          {items.map((item) => (
            <div key={calendarItemKey(item)}>{renderItem(item)}</div>
          ))}
        </Stack>
      </Stack>
    </Overlay>
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
      <div className="text-xs font-medium text-slate">{label}</div>
      <div className="font-semibold tabular-nums">{value}</div>
    </div>
  );
}
