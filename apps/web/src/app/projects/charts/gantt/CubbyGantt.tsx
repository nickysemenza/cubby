import { TZDate } from "@date-fns/tz";
import { LinkIcon as Link2 } from "@phosphor-icons/react/dist/csr/Link";
import { XIcon as X } from "@phosphor-icons/react/dist/csr/X";
import { type ReactNode, useId, useMemo, useState } from "react";
import { match } from "ts-pattern";

import { ChartEmpty } from "~/app/projects/charts/chart-empty";
import {
  PROJECT_STATUS_LABELS,
  TASK_STATUS_LABELS,
  TradeIcon,
} from "~/app/projects/shared";
import { Row } from "~/components/layout";
import { Gantt } from "~/components/reui/gantt/gantt";
import { GanttNav } from "~/components/reui/gantt/gantt-nav";
import type {
  GanttDependencyEdge,
  GanttEvent,
  GanttResource,
  GanttScale,
} from "~/components/reui/gantt/gantt-types";
import { GanttView } from "~/components/reui/gantt/gantt-view";
import { HOUSEHOLD_TIMEZONE } from "~/lib/household-date";
import { getStatusChartColor } from "~/lib/status-colors";
import { cn } from "~/lib/utils";

import { fromDayIndex } from "./gantt-date";
import type { DayRange, GanttRow } from "./gantt-model";
import { getTradeColor } from "./trade-colors";

interface CubbyGanttData {
  rowId: string;
  kind: "project" | "task" | "envelope";
  critical: boolean;
  milestone: boolean;
  openEnded: boolean;
  status: string | null;
}

type GanttWorkRow = Exclude<GanttRow, { kind: "group" }>;

export type GanttDependencyDisclosure = {
  row: GanttWorkRow;
  blockedBy: GanttWorkRow[];
  blocking: GanttWorkRow[];
  missingBlockedByCount: number;
  missingBlockingCount: number;
};

interface CubbyGanttProps {
  rows: GanttRow[];
  window: DayRange;
  collapsedGroups?: string[];
  onCollapsedGroupsChange?: (ids: string[]) => void;
  renderName?: (row: GanttRow) => ReactNode;
  chainIds?: ReadonlySet<string>;
  edges?: ReadonlyArray<readonly [string, string]>;
  emptyMessage?: string;
}

/**
 * Stable empty defaults — both feed `useMemo` dependency arrays below, so an
 * inline `= new Set()` / `= []` would allocate a fresh reference every render
 * and recompute those memos unconditionally (see apps/web/AGENTS.md's
 * `unstable-hook-default` rule).
 */
const NO_CHAIN_IDS: ReadonlySet<string> = new Set<string>();
const NO_EDGES: ReadonlyArray<readonly [string, string]> = [];

const TREE_PANEL = {
  width: 340,
  minWidth: 240,
  maxWidth: 560,
  nameColumnWidth: 220,
  resizable: true,
} as const;

export function dateForDay(day: number): Date {
  const [year, month, date] = fromDayIndex(day).split("-").map(Number);
  return new TZDate(
    year ?? 1970,
    (month ?? 1) - 1,
    date ?? 1,
    HOUSEHOLD_TIMEZONE,
  );
}

function progressFor(row: GanttRow): number | undefined {
  return match(row)
    .with({ kind: "project" }, ({ progress }) => Math.round(progress * 100))
    .with({ kind: "task" }, ({ status }) =>
      status === "done" ? 100 : status === "in_progress" ? 50 : 0,
    )
    .with({ kind: "group" }, () => undefined)
    .exhaustive();
}

function colorFor(row: GanttRow): string {
  return match(row)
    .with({ kind: "task" }, ({ trade }) => getTradeColor(trade))
    .with({ kind: "project" }, ({ trade, status }) =>
      trade ? getTradeColor(trade) : getStatusChartColor(status),
    )
    .with({ kind: "group" }, () => "var(--chart-neutral)")
    .exhaustive();
}

function statusFor(row: GanttRow): string | null {
  return row.kind === "group" ? null : row.status;
}

function statusLabelFor(row: GanttRow): string | null {
  return match(row)
    .with({ kind: "project" }, ({ status }) => PROJECT_STATUS_LABELS[status])
    .with({ kind: "task" }, ({ status }) => TASK_STATUS_LABELS[status])
    .with({ kind: "group" }, () => null)
    .exhaustive();
}

function dependencyCount(row: GanttRow): number {
  return row.kind === "group"
    ? 0
    : row.blockedByIds.length + row.blockingIds.length;
}

/**
 * Resolve a selected row's graph neighbours into readable records. A
 * collapsed or filtered neighbour remains counted rather than silently
 * disappearing, which keeps the selected-row disclosure truthful.
 */
export function dependencyDisclosureFor(
  row: GanttRow | undefined,
  rowById: ReadonlyMap<string, GanttRow>,
): GanttDependencyDisclosure | null {
  if (!row || row.kind === "group" || dependencyCount(row) === 0) return null;

  const resolve = (ids: readonly string[]) => {
    const found: GanttWorkRow[] = [];
    let missing = 0;
    for (const id of ids) {
      const related = rowById.get(id);
      if (!related || related.kind === "group") missing += 1;
      else found.push(related);
    }
    return { found, missing };
  };
  const blockedBy = resolve(row.blockedByIds);
  const blocking = resolve(row.blockingIds);
  return {
    row,
    blockedBy: blockedBy.found,
    blocking: blocking.found,
    missingBlockedByCount: blockedBy.missing,
    missingBlockingCount: blocking.missing,
  };
}

function DependencyNames({
  label,
  rows,
  missingCount,
  renderName,
}: {
  label: string;
  rows: GanttWorkRow[];
  missingCount: number;
  renderName?: (row: GanttRow) => ReactNode;
}) {
  if (rows.length === 0 && missingCount === 0) return null;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      <span className="font-mono text-2xs tracking-wider text-slate uppercase">
        {label} · {rows.length + missingCount}
      </span>
      {rows.map((row) => (
        <span key={row.id} className="text-foreground">
          {renderName ? renderName(row) : row.name}
        </span>
      ))}
      {missingCount > 0 && (
        <span className="text-muted-foreground">
          {missingCount} unavailable
        </span>
      )}
    </span>
  );
}

export function buildResources(rows: GanttRow[]): GanttResource[] {
  const roots: GanttResource[] = [];
  const stack: GanttResource[] = [];
  let activeGroup: GanttResource | null = null;

  for (const row of rows) {
    if (row.kind === "group") {
      activeGroup = {
        id: row.id,
        title: `${row.label} (${row.count})`,
        children: [],
      };
      roots.push(activeGroup);
      stack.length = 0;
      continue;
    }

    const resource: GanttResource = {
      id: row.id,
      title: row.name,
      color: colorFor(row),
      children: [],
    };
    while (stack.length > row.depth) stack.pop();
    const parent = stack[row.depth - 1] ?? activeGroup;
    if (parent) {
      parent.children ??= [];
      parent.children.push(resource);
    } else {
      roots.push(resource);
    }
    stack[row.depth] = resource;
    stack.length = row.depth + 1;
  }

  const prune = (resource: GanttResource): GanttResource => ({
    ...resource,
    children:
      resource.children && resource.children.length > 0
        ? resource.children.map(prune)
        : undefined,
  });
  return roots.map(prune);
}

export function buildEvents(
  rows: GanttRow[],
  fallbackEndDay: number,
  chainIds: ReadonlySet<string>,
): GanttEvent<CubbyGanttData>[] {
  return rows.flatMap((row) => {
    if (row.kind === "group") return [];

    const events: GanttEvent<CubbyGanttData>[] = [];
    const status = statusFor(row);
    const critical = chainIds.has(row.id);

    const range =
      row.kind === "task"
        ? { start: row.startDay, end: row.endDay }
        : row.startDay != null || row.endDay != null
          ? {
              start: row.startDay ?? row.endDay!,
              end: row.openEnded
                ? fallbackEndDay
                : (row.endDay ?? row.startDay!),
            }
          : null;

    if (range) {
      events.push({
        id: `main:${row.id}`,
        resourceId: row.id,
        title: row.name,
        start: dateForDay(range.start),
        end: dateForDay(range.end + 1),
        allDay: true,
        color: colorFor(row),
        progress: progressFor(row),
        priority: 10,
        data: {
          rowId: row.id,
          kind: row.kind,
          critical,
          milestone: row.kind === "task" && row.startDay === row.endDay,
          openEnded: row.kind === "project" && row.openEnded,
          status,
        },
      });
    }

    if (row.kind === "project" && row.envelope) {
      events.push({
        id: `envelope:${row.id}`,
        resourceId: row.id,
        title: `${row.name} subtree span`,
        start: dateForDay(row.envelope.startDay),
        end: dateForDay(row.envelope.endDay + 1),
        allDay: true,
        color: "var(--chart-neutral)",
        priority: 0,
        zIndex: 1,
        data: {
          rowId: row.id,
          kind: "envelope",
          critical: false,
          milestone: false,
          openEnded: false,
          status: null,
        },
      });
    }

    return events;
  });
}

function scaleForWindow(window: DayRange): GanttScale {
  const span = window.endDay - window.startDay + 1;
  if (span <= 14) return "week";
  if (span <= 45) return "month";
  if (span <= 140) return "quarter";
  return "year";
}

export function CubbyGantt({
  rows,
  window,
  collapsedGroups,
  onCollapsedGroupsChange,
  renderName,
  chainIds = NO_CHAIN_IDS,
  edges = NO_EDGES,
  emptyMessage = "No dated work yet.",
}: CubbyGanttProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const disclosureId = useId();
  const rowById = useMemo(
    () => new Map(rows.map((row) => [row.id, row])),
    [rows],
  );
  const resources = useMemo(() => buildResources(rows), [rows]);
  const events = useMemo(
    () => buildEvents(rows, window.endDay, chainIds),
    [chainIds, rows, window.endDay],
  );
  const activeId = hoveredId ?? selectedId;
  const connectedIds = useMemo(() => {
    if (!activeId) return null;
    const row = rowById.get(activeId);
    if (!row || row.kind === "group") return new Set([activeId]);
    return new Set([activeId, ...row.blockedByIds, ...row.blockingIds]);
  }, [activeId, rowById]);
  const selectedDisclosure = useMemo(
    () =>
      dependencyDisclosureFor(
        selectedId ? rowById.get(selectedId) : undefined,
        rowById,
      ),
    [rowById, selectedId],
  );
  const dependencyEdges = useMemo<GanttDependencyEdge[]>(
    () =>
      edges.map(([fromId, toId]) => ({
        fromId,
        toId,
        className:
          connectedIds && !connectedIds.has(fromId) && !connectedIds.has(toId)
            ? "opacity-20"
            : undefined,
      })),
    [connectedIds, edges],
  );
  const columns = useMemo(
    () => [
      {
        id: "status",
        title: "Status",
        width: 92,
        render: ({ resource }: { resource: GanttResource }) => {
          const row = rowById.get(resource.id);
          const label = row ? statusLabelFor(row) : null;
          return label ? (
            <span className="truncate text-2xs text-muted-foreground uppercase">
              {label}
            </span>
          ) : null;
        },
      },
      {
        id: "deps",
        title: "Links",
        width: 52,
        align: "center" as const,
        render: ({ resource }: { resource: GanttResource }) => {
          const row = rowById.get(resource.id);
          const count = row ? dependencyCount(row) : 0;
          const rowName =
            row && row.kind !== "group" ? row.name : resource.title;
          return count > 0 ? (
            <button
              type="button"
              aria-controls={disclosureId}
              aria-expanded={selectedId === row?.id}
              aria-label={`Show ${count} dependency ${count === 1 ? "relationship" : "relationships"} for ${rowName}`}
              className="inline-flex size-7 items-center justify-center gap-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              onClick={() =>
                row &&
                setSelectedId((current) => (current === row.id ? null : row.id))
              }
            >
              <Link2 className="size-3" />
              <span className="font-mono text-2xs">{count}</span>
            </button>
          ) : null;
        },
      },
    ],
    [disclosureId, rowById, selectedId],
  );
  const centerDay = Math.floor((window.startDay + window.endDay) / 2);

  return (
    <>
      {selectedDisclosure && (
        <div
          id={disclosureId}
          aria-live="polite"
          className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 border-y bg-muted/40 px-2 py-1 text-xs"
        >
          <span className="font-medium text-foreground">
            {selectedDisclosure.row.name}
          </span>
          <DependencyNames
            label="Blocked by"
            rows={selectedDisclosure.blockedBy}
            missingCount={selectedDisclosure.missingBlockedByCount}
            renderName={renderName}
          />
          <DependencyNames
            label="Unblocks"
            rows={selectedDisclosure.blocking}
            missingCount={selectedDisclosure.missingBlockingCount}
            renderName={renderName}
          />
          <button
            type="button"
            aria-label={`Clear dependency summary for ${selectedDisclosure.row.name}`}
            className="ml-auto inline-flex size-7 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onClick={() => setSelectedId(null)}
          >
            <X className="size-3" />
          </button>
        </div>
      )}
      <Gantt<CubbyGanttData>
        events={events}
        resources={resources}
        defaultDate={dateForDay(centerDay)}
        defaultScale={scaleForWindow(window)}
        timeZone={HOUSEHOLD_TIMEZONE}
        rangeBounds={{
          min: dateForDay(window.startDay),
          max: dateForDay(window.endDay + 1),
        }}
        treePanel={TREE_PANEL}
        columns={columns}
        collapsedGroups={collapsedGroups}
        onCollapsedGroupsChange={onCollapsedGroupsChange}
        dependencyEdges={dependencyEdges}
        initialCenter={dateForDay(centerDay)}
        className="h-[34rem] overflow-hidden border border-[var(--border)] bg-background"
        getEventClassName={({ occurrence }) => {
          const data = occurrence.event.data;
          if (!data) return undefined;
          return cn(
            data.kind === "envelope" &&
              "h-1! self-center rounded-none! border-x border-(--gantt-event-color)/60 bg-(--gantt-event-color)/20! p-0!",
            data.milestone &&
              "mx-auto size-3! rotate-45 rounded-none! border border-(--gantt-event-color) bg-(--gantt-event-color)/60! p-0!",
            data.critical && "ring-2 ring-primary/60",
            data.openEnded && "border-e-dashed rounded-e-none! border-e-2",
            data.status === "blocked" && "ring-2 ring-destructive/70",
            data.status === "later" && "border border-dashed",
            connectedIds &&
              !connectedIds.has(data.rowId) &&
              "opacity-30 hover:opacity-100",
          );
        }}
        renderEvent={({ occurrence }) => {
          const data = occurrence.event.data;
          if (data?.kind === "envelope" || data?.milestone) {
            return <span className="sr-only">{occurrence.event.title}</span>;
          }
          return (
            <>
              <span className="relative truncate font-medium">
                {occurrence.event.title}
              </span>
              {data?.critical && (
                <Link2
                  className="relative size-3 shrink-0"
                  aria-label="Critical chain"
                />
              )}
            </>
          );
        }}
        renderResourceLabel={({ resource }) => {
          const row = rowById.get(resource.id);
          if (!row) return resource.title;
          if (row.kind === "group") return `${row.label} (${row.count})`;
          return (
            <Row
              align="center"
              gap="xs"
              className="min-w-0"
              title={row.name}
              onFocusCapture={() => setSelectedId(row.id)}
              onMouseEnter={() => setHoveredId(row.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              {row.trade && (
                <TradeIcon
                  trade={row.trade}
                  className="size-3 shrink-0 text-muted-foreground"
                />
              )}
              <span className="min-w-0 truncate">
                {renderName ? renderName(row) : row.name}
              </span>
            </Row>
          );
        }}
        renderSummary={({ progress }) => (
          <div className="relative h-2">
            <span className="absolute start-0 top-0 h-2 w-px bg-muted-foreground/60" />
            <span className="absolute end-0 top-0 h-2 w-px bg-muted-foreground/60" />
            <div className="absolute inset-x-0 top-1 h-1 bg-muted-foreground/20">
              {progress != null && (
                <div
                  className="h-full bg-muted-foreground/50"
                  style={{ width: `${progress}%` }}
                />
              )}
            </div>
          </div>
        )}
        renderNoResources={() => <ChartEmpty title={emptyMessage} />}
      >
        <GanttNav />
        <GanttView />
      </Gantt>
    </>
  );
}
