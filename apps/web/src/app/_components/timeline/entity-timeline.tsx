import { entitySchema } from "@cubby/schemas/entity";
import type {
  EntityTimelineEvent,
  EntityTimelineGroup,
  EntityTimelineOrder,
  EntityTimelineOut,
  EntityTimelineRow,
} from "@cubby/schemas/entity-timeline";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  CalendarClock,
  CalendarRange,
  Clock3,
} from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";

import { DatePickerInput } from "~/app/_components/date-picker-input";
import { ChartEmpty } from "~/app/projects/charts/chart-empty";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { EnumPill } from "~/components/ui/enum-pill";
import { Skeleton } from "~/components/ui/skeleton";
import { StatGrid, StatTile } from "~/components/ui/stat-tile";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { ViewSwitcher } from "~/components/ui/view-switcher";
import { entityDetailLink, isBrowserRoutedEntity } from "~/entities/entities";
import {
  entityTimeline,
  type EntityTimelineFiltersByEntity,
  entityTimelineFor,
  type EntityTimelineParams,
  type EntityTimelineWindowByEntity,
} from "~/entities/entity-timeline.functions";
import type { TimelineEntity } from "~/entities/generated/entity-timelines.gen";
import { parsePlainDate } from "~/lib/plain-date";
import { cn, formatCurrency } from "~/lib/utils";

type EntityTimelineMode = "events" | "lifecycles";

interface EntityTimelineControls {
  from?: string | undefined;
  to?: string | undefined;
  order?: EntityTimelineOrder | undefined;
  mode?: EntityTimelineMode | undefined;
}

/** The read the component performs; a test substitutes a transport-less descriptor. */
export interface EntityTimelineOperations {
  readonly timeline: typeof entityTimeline.timeline;
}

export interface EntityTimelineProps<
  E extends TimelineEntity,
> extends EntityTimelineControls {
  entity: E;
  operations?: EntityTimelineOperations | undefined;
  /** The entity's list filters; the list page passes its current filter state. */
  filters?: EntityTimelineFiltersByEntity[E] | undefined;
  /** Narrows to specific records; a detail page passes `[record.id]`. */
  ids?: readonly string[] | undefined;
  /**
   * Controlled mode: the caller owns the window/order/mode (search params on
   * a list page). Without it the controls keep local state seeded from props.
   */
  onControlsChange?: ((patch: EntityTimelineControls) => void) | undefined;
}

const MODE_OPTIONS = [
  { value: "events", label: "Events", icon: Clock3 },
  { value: "lifecycles", label: "Lifecycles", icon: CalendarRange },
] as const satisfies readonly {
  value: EntityTimelineMode;
  label: string;
  icon: typeof Clock3;
}[];

/**
 * Kind → mark colour. Product movements keep their ledger tones; audit and
 * declared-date kinds use condition colours only where a condition exists
 * (create/delete), else the neutral mark.
 */
const KIND_COLOR = {
  acquired: "var(--positive)",
  exited: "var(--destructive)",
  discarded: "var(--warning)",
  // Money-only: nothing left the house on this row.
  adjusted: "var(--muted-foreground)",
  unknown: "var(--muted-foreground)",
  "audit:create": "var(--positive)",
  "audit:update": "var(--muted-foreground)",
  "audit:delete": "var(--destructive)",
} as const satisfies Record<string, string>;
const KIND_LABEL = {
  acquired: "Acquired",
  exited: "Exited",
  discarded: "Discarded",
  adjusted: "Price adjusted",
  unknown: "Unknown",
  "audit:create": "Created",
  "audit:update": "Updated",
  "audit:delete": "Deleted",
} as const satisfies Record<string, string>;

const known = <T extends Record<string, string>>(
  table: T,
  kind: string,
): string | undefined =>
  Object.hasOwn(table, kind)
    ? // SAFETY: `Object.hasOwn` proves `kind` is one of the table's own keys.
      table[kind as keyof T]
    : undefined;
const kindColor = (kind: string) =>
  known(KIND_COLOR, kind) ?? "var(--foreground)";
const kindLabel = (kind: string) =>
  known(KIND_LABEL, kind) ??
  (kind.startsWith("field:") ? kind.slice("field:".length) : kind);

const formatDate = (date: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parsePlainDate(date));

/** A routed entity link, or plain text when the target has no browser route. */
function TimelineLink({
  link,
  className,
  children,
}: {
  link: EntityTimelineEvent["link"];
  className?: string;
  children: ReactNode;
}) {
  const parsed = link ? entitySchema.safeParse(link.entity) : undefined;
  if (
    !link ||
    !parsed?.success ||
    parsed.data === "usda-food" ||
    !isBrowserRoutedEntity(parsed.data)
  )
    return <span className={className}>{children}</span>;
  return (
    <Link
      {...entityDetailLink(parsed.data, link.id)}
      className={cn("text-primary hover:underline", className)}
    >
      {children}
    </Link>
  );
}

function Controls({
  from,
  to,
  order,
  mode,
  hasRows,
  onChange,
}: {
  from: string | undefined;
  to: string | undefined;
  order: EntityTimelineOrder;
  mode: EntityTimelineMode;
  hasRows: boolean;
  onChange: (patch: EntityTimelineControls) => void;
}) {
  const fromId = useId();
  const toId = useId();
  return (
    <Row align="end" justify="between" wrap gap="sm">
      <Row align="end" wrap gap="sm">
        <label htmlFor={fromId} className="text-xs text-muted-foreground">
          From
          <DatePickerInput
            id={fromId}
            value={from ?? null}
            max={to}
            clearable
            onChange={(value) => onChange({ from: value ?? undefined })}
            className="mt-1 w-40"
          />
        </label>
        <label htmlFor={toId} className="text-xs text-muted-foreground">
          To
          <DatePickerInput
            id={toId}
            value={to ?? null}
            min={from}
            clearable
            onChange={(value) => onChange({ to: value ?? undefined })}
            className="mt-1 w-40"
          />
        </label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange({ order: order === "desc" ? "asc" : "desc" })}
        >
          {order === "desc" ? <ArrowDown /> : <ArrowUp />}
          {order === "desc" ? "Newest first" : "Oldest first"}
        </Button>
      </Row>
      {hasRows && (
        <ViewSwitcher
          ariaLabel="Timeline mode"
          options={MODE_OPTIONS}
          value={mode}
          compactOnMobile
          onValueChange={(value) => onChange({ mode: value })}
        />
      )}
    </Row>
  );
}

function Amount({ amount }: { amount: number | null | undefined }) {
  if (amount === undefined) return null;
  if (amount === null)
    return <Description size="xs">Amount unknown</Description>;
  if (amount < 0)
    return (
      <span className="font-mono text-xs text-positive tabular-nums">
        {formatCurrency(-amount)} recovered
      </span>
    );
  return (
    <span className="font-mono text-xs tabular-nums">
      {formatCurrency(amount)}
    </span>
  );
}

function EventLine({ event }: { event: EntityTimelineEvent }) {
  return (
    <li className="relative grid gap-x-3 gap-y-0.5 py-2 pl-5 md:grid-cols-[minmax(12rem,1fr)_8rem_minmax(0,1fr)_8rem] md:items-center">
      <span
        aria-hidden
        className="absolute top-3.5 left-0 size-2.5 -translate-x-[calc(50%-1px)] rounded-full border-2 border-background"
        style={{ backgroundColor: kindColor(event.kind) }}
      />
      <TimelineLink link={event.link} className="min-w-0 truncate text-sm">
        {event.label}
      </TimelineLink>
      <EnumPill color={kindColor(event.kind)} className="text-xs">
        {kindLabel(event.kind)}
      </EnumPill>
      {event.detail ? (
        <Description size="xs" className="min-w-0 truncate">
          {event.detail}
        </Description>
      ) : (
        <span />
      )}
      <span className="md:text-right">
        <Amount amount={event.amount} />
      </span>
    </li>
  );
}

function EventGroup({
  group,
  showDate = true,
}: {
  group: EntityTimelineGroup;
  showDate?: boolean;
}) {
  return (
    <section>
      <Row align="baseline" wrap gap="sm" className="pb-1">
        {showDate ? (
          <span className="font-mono text-sm tabular-nums">
            {group.date === null ? "Date unknown" : formatDate(group.date)}
          </span>
        ) : null}
        {group.label && (
          <TimelineLink link={group.link} className="text-sm">
            {group.label}
          </TimelineLink>
        )}
      </Row>
      {/* A 2px rail carries data meaning here: the dots sit on it. */}
      <ul className="ml-1 border-l-2 border-border">
        {group.events.map((event) => (
          <EventLine key={event.id} event={event} />
        ))}
      </ul>
    </section>
  );
}

function EventsView({ groups }: { groups: EntityTimelineGroup[] }) {
  if (groups.length === 0)
    return (
      <ChartEmpty icon={CalendarClock} title="Nothing dated in this window." />
    );
  return (
    <Stack gap="md">
      {groups
        .filter((group) => group.date !== null)
        .map((group) => (
          <EventGroup key={group.key} group={group} />
        ))}
      {groups.some((group) => group.date === null) ? (
        <section aria-label="Date unknown">
          <h3 className="mb-2 text-sm font-medium">Date unknown</h3>
          <Stack gap="md">
            {groups
              .filter((group) => group.date === null)
              .map((group) => (
                <EventGroup key={group.key} group={group} showDate={false} />
              ))}
          </Stack>
        </section>
      ) : null}
    </Stack>
  );
}

function LifecyclesView({
  rows,
  extent,
}: {
  rows: EntityTimelineRow[];
  extent: EntityTimelineOut["extent"];
}) {
  const kinds = useMemo(
    () => [...new Set(rows.flatMap((row) => row.markers.map((m) => m.kind)))],
    [rows],
  );
  if (!extent || rows.length === 0)
    return (
      <ChartEmpty icon={CalendarClock} title="Nothing dated in this window." />
    );
  const start = parsePlainDate(extent.from).getTime();
  const end = parsePlainDate(extent.to).getTime();
  const span = Math.max(end - start, 86_400_000);
  const position = (date: string) =>
    Math.max(
      0,
      Math.min(100, ((parsePlainDate(date).getTime() - start) / span) * 100),
    );
  return (
    <Stack gap="sm">
      <div className="overflow-x-auto rounded-[8px] border border-border">
        <div className="min-w-[48rem]">
          <div className="grid grid-cols-[14rem_1fr] border-b border-border bg-muted/40">
            <div className="sticky left-0 z-10 border-r border-border bg-muted p-2 font-mono text-xs">
              Record
            </div>
            <Row justify="between" className="p-2 font-mono text-xs">
              <span>{formatDate(extent.from)}</span>
              <span>{formatDate(extent.to)}</span>
            </Row>
          </div>
          {rows.map((row) => (
            <div
              key={row.id}
              className="grid grid-cols-[14rem_1fr] border-b border-border last:border-b-0"
            >
              <Row
                align="center"
                gap="sm"
                className="sticky left-0 z-10 min-w-0 border-r border-border bg-background p-2"
              >
                {row.imageUrl && (
                  <img
                    src={row.imageUrl}
                    alt=""
                    className="size-6 shrink-0 rounded-[5px] border border-border object-cover"
                  />
                )}
                <TimelineLink
                  link={row.link}
                  className="min-w-0 truncate text-sm"
                >
                  {row.name}
                </TimelineLink>
              </Row>
              <div className="relative h-12 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px)] bg-[length:25%_100%]">
                {row.intervals.map((interval) => {
                  const clippedStart =
                    interval.start < extent.from ? extent.from : interval.start;
                  const clippedEnd =
                    !interval.end || interval.end > extent.to
                      ? extent.to
                      : interval.end;
                  if (clippedEnd < clippedStart) return null;
                  const left = position(clippedStart);
                  const right = position(clippedEnd);
                  return (
                    <div
                      key={`${interval.start}:${interval.end ?? "open"}`}
                      title={
                        interval.confident
                          ? `${formatDate(interval.start)} – ${interval.end ? formatDate(interval.end) : "open"}`
                          : `Uncertain after ${formatDate(interval.start)}`
                      }
                      className={cn(
                        "absolute top-5 h-2 rounded-full",
                        interval.confident
                          ? "bg-positive/30"
                          : "border border-dashed border-muted-foreground bg-transparent",
                      )}
                      style={{
                        left: `${left}%`,
                        width: `${Math.max(right - left, 0.5)}%`,
                      }}
                    />
                  );
                })}
                {row.markers.map((marker) => (
                  <Tooltip
                    key={`${marker.date}:${marker.kind}:${marker.link?.entity ?? ""}:${marker.link?.id ?? ""}`}
                  >
                    <TooltipTrigger
                      render={
                        <span
                          className="absolute top-3.5 size-3 -translate-x-1/2 rounded-full border-2 border-background"
                          style={{
                            left: `${position(marker.date)}%`,
                            backgroundColor: kindColor(marker.kind),
                          }}
                        />
                      }
                    />
                    <TooltipContent>
                      {formatDate(marker.date)} · {kindLabel(marker.kind)}
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <Row wrap gap="md" className="text-xs">
        {kinds.map((kind) => (
          <EnumPill key={kind} color={kindColor(kind)}>
            {kindLabel(kind)}
          </EnumPill>
        ))}
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="h-2 w-6 rounded-full bg-positive/30" />
          Confirmed span
        </span>
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden
            className="h-2 w-6 rounded-full border border-dashed border-muted-foreground"
          />
          Inferred
        </span>
      </Row>
    </Stack>
  );
}

/**
 * `resources.<entity>.timeline` rendered for one entity: summary tiles, the
 * declared or custom events grouped by date, and lifecycle rows when the
 * capability supplies them. A list page mounts it with its filters and the
 * `timelineFrom/To/Order/Mode` search keys; a detail page with `ids`.
 */
interface ResolvedControls {
  from: string | undefined;
  to: string | undefined;
  order: EntityTimelineOrder;
  mode: EntityTimelineMode;
}
interface TimelineControlsState {
  state: ResolvedControls;
  onChange: (patch: EntityTimelineControls) => void;
}

/** Controlled when the caller owns the controls; otherwise local state seeded from the props. */
function useTimelineControls({
  from,
  to,
  order,
  mode,
  onControlsChange,
}: {
  from: string | undefined;
  to: string | undefined;
  order: EntityTimelineOrder | undefined;
  mode: EntityTimelineMode | undefined;
  onControlsChange: EntityTimelineProps<TimelineEntity>["onControlsChange"];
}): TimelineControlsState {
  const [local, setLocal] = useState<EntityTimelineControls>({});
  if (onControlsChange)
    return {
      state: { from, to, order: order ?? "desc", mode: mode ?? "events" },
      onChange: onControlsChange,
    };
  return {
    state: {
      from: "from" in local ? local.from : from,
      to: "to" in local ? local.to : to,
      order: local.order ?? order ?? "desc",
      mode: local.mode ?? mode ?? "events",
    },
    onChange: (patch) => setLocal((previous) => ({ ...previous, ...patch })),
  };
}

function timelineParams<E extends TimelineEntity>(
  filters: EntityTimelineFiltersByEntity[E] | undefined,
  ids: readonly string[] | undefined,
  state: ResolvedControls,
): EntityTimelineParams<E> {
  const window: EntityTimelineWindowByEntity[E] = { order: state.order };
  if (ids && ids.length > 0) window.ids = [...ids];
  if (state.from) window.from = state.from;
  if (state.to) window.to = state.to;
  // SAFETY: every entity's filter fields are optional, so `{}` is a valid
  // input for each of them, and `filters`/`window` are this entity's own
  // members; TypeScript cannot correlate the two mapped types through the
  // generic `E` back into the per-entity params object.
  return {
    filters: filters ?? ({} as EntityTimelineFiltersByEntity[E]),
    window,
  } as EntityTimelineParams<E>;
}

export function EntityTimeline<E extends TimelineEntity>({
  entity,
  filters,
  ids,
  from,
  to,
  order,
  mode,
  onControlsChange,
  operations = { timeline: entityTimeline.timeline },
}: EntityTimelineProps<E>) {
  const { state, onChange } = useTimelineControls({
    from,
    to,
    order,
    mode,
    onControlsChange,
  });
  const query = useQuery(
    entityTimelineFor(entity, operations.timeline).queryOptions(
      timelineParams(filters, ids, state),
    ),
  );
  const { data, isError, isLoading } = query;

  if (isError)
    return (
      <ErrorDisplay
        error={query.error}
        title="the timeline"
        onRetry={() => void query.refetch()}
      />
    );
  if (isLoading || !data)
    return (
      <Stack gap="md">
        <Skeleton className="h-10 w-full" />
        <StatGrid>
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-14 w-full" />
          ))}
        </StatGrid>
        <Skeleton className="h-64 w-full" />
      </Stack>
    );

  const hasRows = data.rows !== undefined;
  const activeMode: EntityTimelineMode = hasRows ? state.mode : "events";
  return (
    <Stack gap="md">
      <Controls
        from={state.from}
        to={state.to}
        order={state.order}
        mode={activeMode}
        hasRows={hasRows}
        onChange={onChange}
      />
      {data.stats.length > 0 && (
        <StatGrid>
          {data.stats.map((stat) => (
            <StatTile key={stat.key} label={stat.label}>
              {stat.value}
            </StatTile>
          ))}
        </StatGrid>
      )}
      {data.notes.length > 0 && (
        <Description>{data.notes.join(" ")}</Description>
      )}
      {activeMode === "lifecycles" && data.rows ? (
        <>
          <LifecyclesView rows={data.rows} extent={data.extent} />
          {data.groups.some((group) => group.date === null) ? (
            <EventsView
              groups={data.groups.filter((group) => group.date === null)}
            />
          ) : null}
        </>
      ) : (
        <EventsView groups={data.groups} />
      )}
    </Stack>
  );
}
