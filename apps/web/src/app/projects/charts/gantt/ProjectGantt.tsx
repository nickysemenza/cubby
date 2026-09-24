/**
 * Surface B — a single project's Gantt, mounted on its detail page.
 *
 * Presentational: the detail page owns the fetching (the whole live subtree's
 * projects + tasks) and hands the arrays down. Everything here is row-model
 * assembly (`buildProjectRows`), critical-chain math (`longestChains`), and
 * window/expand state; the drawing lives in the shared `CubbyGantt`.
 *
 * The chain stat is computed over the *visible* rows, so it tracks what the
 * viewer is actually looking at as sub-projects expand and collapse. It's
 * hidden entirely when nothing in view has a dependency edge — a chain of one
 * is not a chain.
 */

import type { ProjectOut, TaskOut } from "@cubby/schemas/project";
import { CalendarXIcon } from "@phosphor-icons/react/dist/csr/CalendarX";
import { Link } from "@tanstack/react-router";
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useMemo,
  useState,
} from "react";

import { Row, Stack } from "~/components/layout";
import { Skeleton } from "~/components/ui/skeleton";
import { entities, entityDetailParams } from "~/entities/entities";

import { ProjectMark } from "../../project-mark";
import { type ChainNode, longestChains } from "./gantt-chain";
import { toDayIndex, todayPlain } from "./gantt-date";
import { buildProjectRows, type DayRange, type GanttRow } from "./gantt-model";

/** Breathing room on each side of the data extent for the initial window. */
const WINDOW_PAD_DAYS = 7;
/** Fallback window when there's no dated content at all: a rolling quarter. */
const FALLBACK_LEAD_DAYS = 14;
const FALLBACK_TRAIL_DAYS = 75;
/** Row budget for auto-expanding sub-projects on first paint — roughly a
 * tall-but-scannable chart (~2000px at ROW_HEIGHT 32). */
const MAX_AUTO_EXPAND_ROWS = 60;
const LazyCubbyGantt = lazy(() =>
  import("./CubbyGantt").then(({ CubbyGantt }) => ({
    default: CubbyGantt,
  })),
);

function paddedWindow(extent: DayRange | null): DayRange {
  if (extent == null) {
    const today = toDayIndex(todayPlain());
    return {
      startDay: today - FALLBACK_LEAD_DAYS,
      endDay: today + FALLBACK_TRAIL_DAYS,
    };
  }
  return {
    startDay: extent.startDay - WINDOW_PAD_DAYS,
    endDay: extent.endDay + WINDOW_PAD_DAYS,
  };
}

/** Rows minus the group headers (portfolio-only), as chain-graph nodes. */
function chainNodesOf(rows: GanttRow[]): ChainNode[] {
  const nodes: ChainNode[] = [];
  for (const row of rows) {
    if (row.kind === "group") continue;
    nodes.push({
      id: row.id,
      startDay: row.startDay,
      endDay: row.endDay,
      blockedByIds: row.blockedByIds,
    });
  }
  return nodes;
}

export function ProjectGantt({
  projectId,
  tasks,
  subtreeProjects,
}: {
  /** The project whose page this is — its own bar isn't a row. */
  projectId: string;
  /** Every task in the subtree (dated ones become rows, the rest the bin). */
  tasks: TaskOut[];
  /** The whole live descendant subtree, root included (it's filtered out). */
  subtreeProjects: ProjectOut[];
}) {
  // Sub-projects start expanded only when the whole subtree still fits in a
  // readable chart: showing the work beats making the viewer click into it,
  // but a big renovation (Kitchen Remodel: 13 sub-projects, ~500 subtree
  // tasks) would otherwise open as a 16,000px-tall wall of rows that dwarfs
  // the rest of the page. Past the budget we collapse to sub-project summary
  // bars — the envelope whisker still shows each one's span — and let the
  // viewer drill in. `null` means "untouched"; the first toggle switches to
  // an explicit set.
  const allExpanded = useMemo(
    () => new Set(subtreeProjects.map((project) => project.id)),
    [subtreeProjects],
  );
  const allRowsResult = useMemo(
    () => buildProjectRows(projectId, subtreeProjects, tasks, allExpanded),
    [allExpanded, projectId, subtreeProjects, tasks],
  );
  const expandableIds = useMemo(
    () =>
      allRowsResult.rows.flatMap((row) =>
        row.kind === "project" && row.expandable ? [row.id] : [],
      ),
    [allRowsResult.rows],
  );
  const defaultExpanded = useMemo(() => {
    return allRowsResult.rows.length <= MAX_AUTO_EXPAND_ROWS
      ? new Set(expandableIds)
      : new Set<string>();
  }, [allRowsResult.rows.length, expandableIds]);
  const [expandedOverride, setExpandedOverride] =
    useState<ReadonlySet<string> | null>(null);
  const expanded = expandedOverride ?? defaultExpanded;

  const collapsedGroups = useMemo(
    () => expandableIds.filter((id) => !expanded.has(id)),
    [expandableIds, expanded],
  );
  const onCollapsedGroupsChange = useCallback(
    (collapsed: string[]) => {
      const collapsedSet = new Set(collapsed);
      setExpandedOverride(
        new Set(expandableIds.filter((id) => !collapsedSet.has(id))),
      );
    },
    [expandableIds],
  );

  const { rows, unscheduled, extent } = useMemo(
    () => buildProjectRows(projectId, subtreeProjects, tasks, expanded),
    [projectId, subtreeProjects, tasks, expanded],
  );

  const defaultWindow = useMemo(() => paddedWindow(extent), [extent]);

  const chain = useMemo(() => longestChains(chainNodesOf(rows))[0], [rows]);
  const chainIds = useMemo(
    () => (chain ? new Set(chain.ids) : undefined),
    [chain],
  );

  const renderName = useCallback((row: GanttRow): ReactNode => {
    // Group rows are portfolio-only and never reach `renderName` anyway
    // (the chart's NameCell renders them itself).
    if (row.kind === "group") return row.label;
    const entity = row.kind === "project" ? "project" : "task";
    return (
      <Link
        to={entities[entity].routes.detail}
        params={entityDetailParams(row.id)}
        className="hover:underline"
      >
        <span className="inline-flex min-w-0 items-center gap-1">
          {row.kind === "project" && <ProjectMark icon={row.icon} size={12} />}
          <span className="truncate">{row.name}</span>
        </span>
      </Link>
    );
  }, []);

  return (
    <Stack gap="sm">
      {chain != null && (
        <Row align="center" gap="xs" className="font-mono text-2xs text-slate">
          <span className="tracking-wider uppercase">chain</span>
          <span className="text-foreground">
            {chain.workDays}d work / {chain.elapsedDays}d elapsed
          </span>
          <span>
            ({chain.ids.length} {chain.ids.length === 1 ? "item" : "items"})
          </span>
        </Row>
      )}

      <Suspense fallback={<Skeleton className="h-[34rem] w-full" />}>
        <LazyCubbyGantt
          rows={allRowsResult.rows}
          window={defaultWindow}
          collapsedGroups={collapsedGroups}
          onCollapsedGroupsChange={onCollapsedGroupsChange}
          renderName={renderName}
          chainIds={chainIds}
          edges={chain?.edges}
          emptyMessage="No dated tasks or sub-projects yet."
        />
      </Suspense>

      {unscheduled.length > 0 && (
        <Stack gap="xs">
          <Row align="center" gap="xs" className="text-muted-foreground">
            <CalendarXIcon className="size-3 shrink-0" />
            <span className="font-mono text-2xs tracking-wider uppercase">
              Unscheduled · {unscheduled.length}
            </span>
          </Row>
          <Row wrap gap="xs">
            {unscheduled.map((task) => (
              <Link
                key={task.id}
                to={entities.task.routes.detail}
                params={entityDetailParams(task.id)}
                className="max-w-64 truncate rounded-sm bg-muted px-2 py-1 text-xs hover:underline"
                title={task.name}
              >
                {task.name}
              </Link>
            ))}
          </Row>
        </Stack>
      )}
    </Stack>
  );
}
