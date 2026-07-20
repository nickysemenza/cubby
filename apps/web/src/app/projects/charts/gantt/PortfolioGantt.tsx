/**
 * PortfolioGantt — the projects dashboard's Gantt surface (Surface A). A
 * thin state/wiring shell around the shared `GanttChart` renderer and the
 * `buildPortfolioRows` row model: owns expand state, the visible window, and
 * the zoom-preset / swimlane controls. Renders no chart geometry itself —
 * that's `GanttChart`'s job.
 */

import type { ProjectOut } from "@cubby/schemas/project";
import { Link } from "@tanstack/react-router";
import { GanttChartSquare } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { match } from "ts-pattern";
import { Row, Stack } from "~/components/layout";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { ChartEmpty } from "../chart-empty";
import { GanttChart } from "./GanttChart";
import { toDayIndex, todayPlain } from "./gantt-date";
import {
  buildPortfolioRows,
  type DayRange,
  type GanttRow,
} from "./gantt-model";

type ZoomPreset = "active" | "year" | "all";
type GroupMode = "none" | "kind";

const ZOOM_OPTIONS: ViewSwitcherOption<ZoomPreset>[] = [
  { value: "active", label: "Active" },
  { value: "year", label: "Year" },
  { value: "all", label: "All" },
];

const GROUP_OPTIONS: ViewSwitcherOption<GroupMode>[] = [
  { value: "none", label: "Flat" },
  { value: "kind", label: "By Kind" },
];

/** How far the Active preset reaches on either side of today. */
const ACTIVE_PAD_BEFORE_DAYS = 60;
const ACTIVE_PAD_AFTER_DAYS = 300;
/**
 * Fallback ~2020-2028 span for the All preset, only used when there's no
 * dated extent to derive it from (an empty/all-unscheduled portfolio).
 */
const ALL_FALLBACK_WINDOW: DayRange = {
  startDay: toDayIndex("2020-01-01"),
  endDay: toDayIndex("2028-12-31"),
};

function activeWindowOf(activeExtent: DayRange | null): DayRange {
  const today = toDayIndex(todayPlain());
  const lo = today - ACTIVE_PAD_BEFORE_DAYS;
  const hi = today + ACTIVE_PAD_AFTER_DAYS;
  if (activeExtent == null) return { startDay: lo, endDay: hi };
  const startDay = Math.max(activeExtent.startDay, lo);
  const endDay = Math.min(activeExtent.endDay, hi);
  // The clamp can invert when every active project falls entirely outside
  // the +/- window (e.g. all active work starts >300d out) — fall back to
  // the plain today-centered window rather than emit startDay > endDay.
  return startDay <= endDay
    ? { startDay, endDay }
    : { startDay: lo, endDay: hi };
}

function yearWindowOf(): DayRange {
  const year = todayPlain().slice(0, 4);
  return {
    startDay: toDayIndex(`${year}-01-01`),
    endDay: toDayIndex(`${year}-12-31`),
  };
}

/** All = the full dated extent when there is one, else the ~2020-2028 fallback. */
function allWindowOf(extent: DayRange | null): DayRange {
  return extent ?? ALL_FALLBACK_WINDOW;
}

/**
 * Project rows get a router link; group lane headers never reach here —
 * `GanttChart`'s `NameCell` renders those itself before calling `renderName`.
 */
function renderProjectName(row: GanttRow): ReactNode {
  return match(row)
    .with({ kind: "project" }, (r) => (
      <Link
        to="/projects/$id"
        params={{ id: r.id }}
        className="hover:underline"
      >
        {r.name}
      </Link>
    ))
    .with({ kind: "task" }, (r) => r.name)
    .with({ kind: "group" }, (r) => r.label)
    .exhaustive();
}

export function PortfolioGantt({ projects }: { projects: ProjectOut[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [groupBy, setGroupBy] = useState<GroupMode>("none");
  const [preset, setPreset] = useState<ZoomPreset>("active");
  // `null` = follow the Active preset live: recomputed from `activeExtent`
  // on every render, so a dashboard filter change moves the window with it
  // instead of leaving it pinned to a now-stale range. The moment the user
  // zooms, pans, or picks any preset (including re-picking Active), the
  // window becomes an explicit, frozen `DayRange`.
  const [explicitWindow, setExplicitWindow] = useState<DayRange | null>(null);

  const onToggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Toggling `groupBy` only changes how the same `expanded` ids are nested
  // under group headers — expand state and window state are independent
  // pieces of state and survive the toggle for free.
  const { rows, unscheduled, extent, activeExtent } = useMemo(
    () => buildPortfolioRows(projects, expanded, { groupBy }),
    [projects, expanded, groupBy],
  );

  const activeWindow = useMemo(
    () => activeWindowOf(activeExtent),
    [activeExtent],
  );
  const visibleWindow = explicitWindow ?? activeWindow;

  const handlePreset = useCallback(
    (next: ZoomPreset) => {
      setPreset(next);
      setExplicitWindow(
        match(next)
          .with("active", () => activeWindowOf(activeExtent))
          .with("year", () => yearWindowOf())
          .with("all", () => allWindowOf(extent))
          .exhaustive(),
      );
    },
    [activeExtent, extent],
  );

  if (extent == null) {
    return (
      <Stack gap="sm">
        <ChartEmpty
          icon={GanttChartSquare}
          title="No projects with dates yet."
        />
        <UnscheduledList projects={unscheduled} />
      </Stack>
    );
  }

  return (
    <Stack gap="sm">
      <Row justify="between" wrap gap="sm">
        <ViewSwitcher
          ariaLabel="Zoom range"
          options={ZOOM_OPTIONS}
          value={preset}
          onValueChange={handlePreset}
        />
        <ViewSwitcher
          ariaLabel="Group by"
          options={GROUP_OPTIONS}
          value={groupBy}
          onValueChange={setGroupBy}
        />
      </Row>

      <GanttChart
        rows={rows}
        window={visibleWindow}
        onWindowChange={setExplicitWindow}
        extent={extent}
        defaultWindow={activeWindow}
        onToggleExpand={onToggleExpand}
        renderName={renderProjectName}
        emptyMessage="No projects with dates yet."
      />

      <UnscheduledList projects={unscheduled} />
    </Stack>
  );
}

function UnscheduledList({ projects }: { projects: ProjectOut[] }) {
  if (projects.length === 0) return null;
  return (
    <Stack gap="sm">
      <span className="font-mono text-2xs text-muted-foreground uppercase tracking-wider">
        Unscheduled ({projects.length})
      </span>
      <Row wrap gap="sm">
        {projects.map((project) => (
          <Link
            key={project.id}
            to="/projects/$id"
            params={{ id: project.id }}
            className="rounded-sm bg-muted px-2 py-1 text-xs hover:bg-muted/70 hover:underline"
          >
            {project.name}
          </Link>
        ))}
      </Row>
    </Stack>
  );
}
