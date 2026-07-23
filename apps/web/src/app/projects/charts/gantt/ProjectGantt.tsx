/**
 * Surface B — a single project's Gantt, mounted on its detail page.
 *
 * Presentational: the detail page owns the fetching (the whole live subtree's
 * projects + tasks) and hands the arrays down. Everything here is row-model
 * assembly (`buildProjectRows`), critical-chain math (`longestChains`), and
 * window/expand state; the drawing lives in the shared `GanttChart`.
 *
 * The chain stat is computed over the *visible* rows, so it tracks what the
 * viewer is actually looking at as sub-projects expand and collapse. It's
 * hidden entirely when nothing in view has a dependency edge — a chain of one
 * is not a chain.
 */

import type { ProjectOut, TaskOut } from "@cubby/schemas/project";
import { Link } from "@tanstack/react-router";
import { CalendarOff } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { Row, Stack } from "~/components/layout";
import { GanttChart } from "./GanttChart";
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
  const defaultExpanded = useMemo(() => {
    const all = new Set(subtreeProjects.map((p) => p.id));
    const expandedRowCount = buildProjectRows(
      projectId,
      subtreeProjects,
      tasks,
      all,
    ).rows.length;
    return expandedRowCount <= MAX_AUTO_EXPAND_ROWS ? all : new Set<string>();
  }, [projectId, subtreeProjects, tasks]);
  const [expandedOverride, setExpandedOverride] =
    useState<ReadonlySet<string> | null>(null);
  const expanded = expandedOverride ?? defaultExpanded;

  const onToggleExpand = useCallback(
    (id: string) => {
      setExpandedOverride((prev) => {
        const next = new Set(prev ?? defaultExpanded);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [defaultExpanded],
  );

  const { rows, unscheduled, extent } = useMemo(
    () => buildProjectRows(projectId, subtreeProjects, tasks, expanded),
    [projectId, subtreeProjects, tasks, expanded],
  );

  const defaultWindow = useMemo(() => paddedWindow(extent), [extent]);
  const [windowOverride, setWindowOverride] = useState<DayRange | null>(null);
  const viewWindow = windowOverride ?? defaultWindow;

  const chain = useMemo(() => longestChains(chainNodesOf(rows))[0], [rows]);
  const chainIds = useMemo(
    () => (chain ? new Set(chain.ids) : undefined),
    [chain],
  );

  const renderName = useCallback((row: GanttRow): ReactNode => {
    // Group rows are portfolio-only and never reach `renderName` anyway
    // (the chart's NameCell renders them itself).
    if (row.kind === "group") return row.label;
    const to = row.kind === "project" ? "/projects/$id" : "/tasks/$id";
    return (
      <Link to={to} params={{ id: row.id }} className="hover:underline">
        {row.name}
      </Link>
    );
  }, []);

  return (
    <Stack gap="sm">
      {chain != null && (
        <Row align="center" gap="xs" className="font-mono text-2xs text-slate">
          <span className="uppercase tracking-wider">chain</span>
          <span className="text-foreground">
            {chain.workDays}d work / {chain.elapsedDays}d elapsed
          </span>
          <span>
            ({chain.ids.length} {chain.ids.length === 1 ? "item" : "items"})
          </span>
        </Row>
      )}

      <GanttChart
        rows={rows}
        window={viewWindow}
        onWindowChange={setWindowOverride}
        extent={extent}
        defaultWindow={defaultWindow}
        onToggleExpand={onToggleExpand}
        renderName={renderName}
        chainIds={chainIds}
        edges={chain?.edges}
        emptyMessage="No dated tasks or sub-projects yet."
      />

      {unscheduled.length > 0 && (
        <Stack gap="xs">
          <Row align="center" gap="xs" className="text-muted-foreground">
            <CalendarOff className="size-3 shrink-0" />
            <span className="font-mono text-2xs uppercase tracking-wider">
              Unscheduled · {unscheduled.length}
            </span>
          </Row>
          <Row wrap gap="xs">
            {unscheduled.map((task) => (
              <Link
                key={task.id}
                to="/tasks/$id"
                params={{ id: task.id }}
                className="max-w-64 truncate rounded-sm bg-muted px-2 py-1 text-xs hover:underline"
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
