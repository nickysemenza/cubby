import type {
  ExpenseOut,
  ProjectDashboardSummaryOut,
  ProjectOut,
  ProjectPortfolioAnalyticsOut,
  TaskOut,
} from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { format } from "date-fns";
import { partition, uniq } from "es-toolkit";
import {
  Calendar,
  DollarSign,
  Hammer,
  History as HistoryIcon,
  Wallet,
} from "lucide-react";
import { lazy, Suspense, useMemo, useState } from "react";
import { useEntityPreview } from "~/app/_components/hooks/useEntityPreview";
import type { SummaryItem } from "~/app/_components/SummaryCard";
import { Grid, Row, Section, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyHeader,
  EmptyIcon,
  EmptyTitle,
} from "~/components/ui/empty";
import { Image } from "~/components/ui/image";
import { Skeleton } from "~/components/ui/skeleton";
import { StatGrid, StatTile } from "~/components/ui/stat-tile";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { entities, entityDetailParams } from "~/entities/entities";
import { type RouterOutputs, useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import { formatCurrency } from "~/lib/utils";

import {
  type Filters,
  filtersFromSearch,
  filtersToScopeInput,
  filtersToSearch,
} from "./dashboard-filter-state";
import { DashboardFilters } from "./dashboard-filters";
import { SingleSelectChipGroup } from "./filter-chips";
import { NeedsAttention } from "./needs-attention";
import { ProjectActions } from "./project-actions";
import {
  capitalize,
  ExpenseList,
  formatDate,
  formatDateRange,
  PROJECT_STATUS_LABELS,
  ProjectTable,
  StatusIcon,
  TaskList,
} from "./shared";

// Charts are Nivo/d3-heavy and each tab's panel is unmounted until selected, so
// lazy-load them to keep their code out of the dashboard chunk until a tab opens.
const CostVsEstimate = lazy(() =>
  import("./charts/cost-vs-estimate").then((m) => ({
    default: m.CostVsEstimate,
  })),
);
const MonthlyTrend = lazy(() =>
  import("./charts/monthly-trend").then((m) => ({ default: m.MonthlyTrend })),
);
const TradeActivity = lazy(() =>
  import("./charts/trade-activity").then((m) => ({
    default: m.TradeActivity,
  })),
);
const PlannedVsActualByMonth = lazy(() =>
  import("./charts/planned-vs-actual-by-month").then((m) => ({
    default: m.PlannedVsActualByMonth,
  })),
);
const SpendingByProject = lazy(() =>
  import("./charts/spending-by-project").then((m) => ({
    default: m.SpendingByProject,
  })),
);
const OpenTasksByProject = lazy(() =>
  import("./charts/open-tasks-by-project").then((m) => ({
    default: m.OpenTasksByProject,
  })),
);
const TaskStatusBoard = lazy(() =>
  import("./charts/task-status-board").then((m) => ({
    default: m.TaskStatusBoard,
  })),
);

type DashboardView = "overview" | "analytics" | "data" | "gallery" | "history";

const DASHBOARD_VIEW_OPTIONS: ViewSwitcherOption<DashboardView>[] = [
  { value: "overview", label: "Overview" },
  { value: "analytics", label: "Analytics" },
  { value: "data", label: "Data" },
  { value: "gallery", label: "Gallery" },
  { value: "history", label: "History" },
];

/** Cover image (first attached image) per project id — keyed lookup for the gallery/overview cards. */
type CoverImages = RouterOutputs["image"]["imagesByProjectIds"];

const NO_PROJECT_IDS: string[] = [];
const NO_PROJECTS: ProjectOut[] = [];
const NO_TASKS: TaskOut[] = [];
const NO_EXPENSES: ExpenseOut[] = [];
const NO_KINDS: string[] = [];
const NO_LOCATIONS: string[] = [];
const NO_YEARS: string[] = [];

const route = getRouteApi("/_authenticated/projects/");

export function ProjectsDashboard() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const view: DashboardView = search.view ?? "overview";

  const onViewChange = (v: DashboardView) =>
    navigate({ search: (prev) => ({ ...prev, view: v }), replace: true });

  // History has its own scope (forced to `status: done`) and its own local
  // kind/location/completion-year filters — it doesn't share the
  // statuses/kinds/locations/date chips the other four views use, so it gets
  // its own top-level branch rather than one more `view === ...` block deep
  // inside MainDashboard.
  if (view === "history") {
    return <HistoryView onViewChange={onViewChange} />;
  }

  return <MainDashboard view={view} onViewChange={onViewChange} />;
}

// -- Toolbar (shared across every view) --

function DashboardToolbar({
  view,
  onViewChange,
}: {
  view: DashboardView;
  onViewChange: (v: DashboardView) => void;
}) {
  return (
    <Row justify="between" align="center" wrap gap="sm">
      <ViewSwitcher
        ariaLabel="Dashboard view"
        options={DASHBOARD_VIEW_OPTIONS}
        value={view}
        onValueChange={onViewChange}
      />
      <ProjectActions />
    </Row>
  );
}

function DashboardErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyIcon icon={Hammer} />
        <EmptyTitle>Couldn't load the project dashboard</EmptyTitle>
        <EmptyDescription>{getErrorMessage(error)}</EmptyDescription>
      </EmptyHeader>
      <EmptyActions>
        <Button type="button" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </EmptyActions>
    </Empty>
  );
}

// -- Main dashboard: overview / analytics / data / gallery --

/**
 * `dashboardSummary` is fetched for all four of these views — it's the
 * bounded, cheap Overview read (summary counts, active-project list w/
 * rollups, task-status breakdown, upcoming tasks, Needs Attention, filter
 * options), and Data/Gallery reuse its `projects` list rather than issuing
 * their own query. Only `portfolioAnalytics` (chart aggregates) and the
 * Data view's raw task/expense fetch-alls are gated behind their own view,
 * per the whole point of splitting the old fetch-all `project.dashboard`.
 */
function MainDashboard({
  view,
  onViewChange,
}: {
  view: Exclude<DashboardView, "history">;
  onViewChange: (v: DashboardView) => void;
}) {
  const api = useTRPC();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const projectPreview = useEntityPreview("project");

  // Keyed on the joined primitive values (not the array references
  // themselves) so a fresh-array-per-parse from validateSearch doesn't
  // rebuild the Sets — and every downstream memo keyed on `filters` — on
  // every render.
  const statusesKey = search.statuses?.join(",");
  const kindsKey = search.kinds?.join(",");
  const locationsKey = search.locations?.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the joined-string primitives above, not the array references, on purpose
  const filters = useMemo<Filters>(
    () => filtersFromSearch(search),
    [statusesKey, kindsKey, locationsKey, search.date],
  );

  const handleFiltersChange = (next: Filters) => {
    const nextSearch = filtersToSearch(next);
    navigate({
      // `filtersToSearch` types `statuses`/`kinds` generically as `string[]`
      // — `dashboard-filter-state.ts` treats `Filters` values generically
      // throughout, deliberately not coupled to the branded schema enums.
      search: (prev) => ({ ...prev, ...nextSearch }),
      replace: true,
    });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the joined-string primitives, not the Set references
  const scopeInput = useMemo(
    () => filtersToScopeInput(filters),
    [statusesKey, kindsKey, locationsKey, search.date],
  );
  const dashboardQuery = useQuery({
    ...api.project.dashboardSummary.queryOptions(scopeInput),
    staleTime: 5 * 60 * 1000,
  });

  // Chart aggregates are ONLY fetched once the Analytics tab is actually
  // selected — the whole point of splitting `project.dashboard` in two. Date
  // bounds now live in `scopeInput` itself (via `filtersToScopeInput`), so
  // there's no separate dateFrom/dateTo spread here anymore.
  const analyticsQuery = useQuery({
    ...api.project.portfolioAnalytics.queryOptions(scopeInput),
    staleTime: 5 * 60 * 1000,
    enabled: view === "analytics",
  });

  // Data view's raw task/expense tables — also gated to their own tab, not
  // fetched on every dashboard load. Date bounds apply server-side; the
  // kind/location/status chips (which only project.dashboardSummary
  // understands) are applied client-side below via the resulting project id
  // set, same as the old client-side filtering.
  const dataViewActive = view === "data";
  const { data: allTasks = NO_TASKS } = useQuery({
    ...api.task.chartData.queryOptions({
      dueFrom: scopeInput.dateFrom,
      dueTo: scopeInput.dateTo,
    }),
    enabled: dataViewActive,
  });
  const { data: allExpenses = NO_EXPENSES } = useQuery({
    ...api.expense.chartData.queryOptions({
      dateFrom: scopeInput.dateFrom,
      dateTo: scopeInput.dateTo,
    }),
    enabled: dataViewActive,
  });

  const projects = dashboardQuery.data?.projects ?? NO_PROJECTS;

  const { scopedTasks, scopedExpenses } = useMemo(() => {
    if (!dataViewActive) {
      return { scopedTasks: NO_TASKS, scopedExpenses: NO_EXPENSES };
    }
    // Keyed by id, not name — project names aren't unique, so a name-keyed
    // join here would cross-contaminate tasks/expenses across same-named
    // projects.
    const projectIds = new Set(projects.map((p) => p.id));
    return {
      scopedTasks: allTasks.filter(
        (t) => !t.projectId || projectIds.has(t.projectId),
      ),
      scopedExpenses: allExpenses.filter(
        (p) => !p.projectId || projectIds.has(p.projectId),
      ),
    };
  }, [dataViewActive, projects, allTasks, allExpenses]);

  // Overview's project cards and Gallery both show cover images; the other
  // views don't render any project cards, so skip the query entirely there.
  const showImages = view === "overview" || view === "gallery";
  const imageProjectIds = showImages
    ? projects.map((p) => p.id)
    : NO_PROJECT_IDS;
  const { data: coverImages } = useQuery({
    ...api.image.imagesByProjectIds.queryOptions({
      projectIds: imageProjectIds,
    }),
    staleTime: 5 * 60 * 1000,
    enabled: imageProjectIds.length > 0,
  });

  if (dashboardQuery.isError) {
    return (
      <DashboardErrorState
        error={dashboardQuery.error}
        onRetry={() => dashboardQuery.refetch()}
      />
    );
  }

  const data = dashboardQuery.data;

  // <DashboardFilters> is hoisted above the loading gate below — it reflects
  // URL state that's already known before the query resolves, so it
  // shouldn't pop in after the rest of the page. `filterOptions` falls back
  // to the stable empty arrays while `data` is still undefined.
  return (
    <Stack>
      <DashboardToolbar view={view} onViewChange={onViewChange} />

      <DashboardFilters
        filters={filters}
        onFiltersChange={handleFiltersChange}
        availableKinds={data?.filterOptions.kinds ?? NO_KINDS}
        availableLocations={data?.filterOptions.locations ?? NO_LOCATIONS}
        availableYears={data?.filterOptions.years ?? NO_YEARS}
      />

      {dashboardQuery.isLoading || !data ? (
        <DashboardSkeleton />
      ) : (
        <>
          {view === "overview" && (
            <OverviewView data={data} coverImages={coverImages} />
          )}

          {view === "analytics" && (
            <AnalyticsView
              data={analyticsQuery.data}
              isLoading={analyticsQuery.isLoading}
            />
          )}

          {view === "data" && (
            <DataViewContent
              projects={projects}
              tasks={scopedTasks}
              expenses={scopedExpenses}
              projectPreview={projectPreview}
              hiddenByDate={data.hiddenByDate}
              onClearDate={() =>
                handleFiltersChange({ ...filters, dateRange: null })
              }
            />
          )}

          {view === "gallery" && (
            <div className="pt-4">
              <ProjectCards projects={projects} coverImages={coverImages} />
            </div>
          )}
        </>
      )}
    </Stack>
  );
}

// -- Overview --

function OverviewView({
  data,
  coverImages,
}: {
  data: ProjectDashboardSummaryOut;
  coverImages: CoverImages | undefined;
}) {
  const summaryItems = useMemo<SummaryItem[]>(
    () => [
      { label: "Active Projects", value: data.summary.activeProjectCount },
      { label: "Open Tasks", value: data.summary.openTaskCount },
      {
        label: "Spend",
        value: data.summary.actualSpend,
        formatter: (v) => formatCurrency(Number(v), 0),
        caption:
          data.summary.committedSpend > 0
            ? `+${formatCurrency(data.summary.committedSpend, 0)} committed`
            : undefined,
      },
    ],
    [data.summary],
  );

  return (
    <Stack className="pt-4">
      <StatGrid>
        {summaryItems.map((item) => (
          <StatTile key={item.label} item={item} />
        ))}
      </StatGrid>

      <NeedsAttention items={data.attention} />

      {/* "Projects", not "Active Projects" — the summary tile above already
          says that; identical text on both would be a strict-mode-locator
          collision in e2e tests and a redundant label for a real reader. */}
      <Section title="Projects">
        <ProjectCards projects={data.projects} coverImages={coverImages} />
        {data.completedCount > 0 && (
          <Link
            to="/projects"
            search={{ view: "history" }}
            className="text-muted-foreground text-xs hover:text-foreground hover:underline"
          >
            {data.completedCount} completed project
            {data.completedCount !== 1 ? "s" : ""} — view history →
          </Link>
        )}
      </Section>

      <Section
        title="Task Status"
        description="Projects with the most open work first"
      >
        <Suspense fallback={<Skeleton className="h-48 w-full" />}>
          <TaskStatusBoard
            breakdown={data.taskStatusByProject}
            projects={data.projects}
          />
        </Suspense>
      </Section>

      <NextWork tasks={data.nextTasks} />
    </Stack>
  );
}

function NextWork({ tasks }: { tasks: TaskOut[] }) {
  if (tasks.length === 0) return null;

  return (
    <Section
      title="Next Work"
      description="Upcoming actionable tasks across your projects"
    >
      <Stack gap="xs">
        {tasks.map((task) => (
          <Row key={task.id} align="center" gap="sm" className="text-sm">
            <StatusIcon status={task.status} />
            <Link
              to={entities.task.routes.detail}
              params={entityDetailParams(task.id)}
              className="truncate hover:underline"
            >
              {task.name}
            </Link>
            {task.projectName && (
              <span className="shrink-0 text-muted-foreground text-xs">
                {task.projectName}
              </span>
            )}
            {task.dueDate && (
              <span className="ml-auto shrink-0 text-muted-foreground text-xs">
                {formatDate(task.dueDate)}
              </span>
            )}
          </Row>
        ))}
      </Stack>
    </Section>
  );
}

// -- Analytics --

/**
 * Every chart here is sourced from `portfolioAnalytics`'s pre-aggregated
 * fields (see repo/project/portfolio-analytics.ts) — never raw
 * projects/tasks/expenses, which this endpoint deliberately doesn't return.
 * Charts whose old raw-data shape has no server aggregate equivalent
 * (Project Timeline/Gantt, Project Dependencies, Category Breakdown,
 * Spending Heatmap, Spend-by-Trade pivot matrix) were dropped rather than
 * inventing new server aggregates — see the task report.
 */
function AnalyticsView({
  data,
  isLoading,
}: {
  data: ProjectPortfolioAnalyticsOut | undefined;
  isLoading: boolean;
}) {
  if (isLoading || !data) {
    return <Skeleton className="h-[400px] w-full" />;
  }

  return (
    <Suspense fallback={<Skeleton className="h-[400px] w-full" />}>
      <Stack className="pt-4">
        <Section
          title="Cost vs Estimate"
          description="% of budget spent — projects with an estimate only"
        >
          <CostVsEstimate data={data.costVsEstimate} />
        </Section>

        <Section
          title="Top 10 Projects by Spending"
          description="Raw dollar totals, regardless of whether a project has an estimate"
        >
          <SpendingByProject data={data.spendingByProject} />
        </Section>

        <Section
          title="Monthly Spending Trend"
          description="Actual vs committed spend, by month"
        >
          <MonthlyTrend data={data.monthlySpend} />
        </Section>

        <Section
          title="Planned vs Actual"
          description="Committed spend vs future-flagged expenses, by month"
        >
          <PlannedVsActualByMonth data={data.plannedVsActual} />
        </Section>

        <Section
          title="Spend by Trade"
          description="Actual + committed spend per trade"
        >
          <TradeActivity data={data.tradeActivity} />
        </Section>

        <Section
          title="Open Tasks by Project"
          description="Where open work is concentrated"
        >
          <OpenTasksByProject data={data.taskHeatmap} />
        </Section>
      </Stack>
    </Suspense>
  );
}

// -- Data --

function DataViewContent({
  projects,
  tasks,
  expenses,
  projectPreview,
  hiddenByDate,
  onClearDate,
}: {
  projects: ProjectOut[];
  tasks: TaskOut[];
  expenses: ExpenseOut[];
  projectPreview: ReturnType<typeof useEntityPreview>;
  hiddenByDate: ProjectDashboardSummaryOut["hiddenByDate"];
  onClearDate: () => void;
}) {
  return (
    <Stack className="pt-4">
      <Stack as="section">
        <h2 className="font-heading font-semibold text-xl">Projects</h2>
        <ProjectTable
          projects={projects}
          onRowClick={projectPreview.onRowClick}
          onRowHover={projectPreview.onRowHover}
          PreviewSheet={projectPreview.PreviewSheet}
        />
        <HiddenByDateNote
          count={hiddenByDate.projects}
          label="projects"
          onClear={onClearDate}
        />
      </Stack>

      <Stack as="section">
        <h2 className="font-heading font-semibold text-xl">Tasks</h2>
        <TaskList tasks={tasks} />
        <HiddenByDateNote
          count={hiddenByDate.tasks}
          label="tasks"
          onClear={onClearDate}
        />
      </Stack>

      <Stack as="section">
        <h2 className="font-heading font-semibold text-xl">Expenses</h2>
        <ExpenseList expenses={expenses} />
        <HiddenByDateNote
          count={hiddenByDate.expenses}
          label="expenses"
          onClear={onClearDate}
        />
      </Stack>
    </Stack>
  );
}

/**
 * Honesty footnote for the Data view: the active date window
 * (`dateFrom`/`dateTo`) silently drops rows with no date at all, per entity
 * (see `ProjectDashboardSummaryOut.hiddenByDate`). Renders nothing at count
 * 0 — most loads have no date filter applied. Same dotted-underline
 * "click to reveal more" idiom as `BoardColumn`'s hidden-done-tasks note
 * (`~/app/tasks/board/BoardColumn.tsx`), but clicking here clears the Date
 * chip instead of expanding a list, since there's no "show them anyway"
 * short of dropping the filter.
 */
function HiddenByDateNote({
  count,
  label,
  onClear,
}: {
  count: number;
  /** Plural entity noun, e.g. "tasks", "expenses", "projects". */
  label: string;
  onClear: () => void;
}) {
  if (count === 0) return null;

  return (
    <button
      type="button"
      onClick={onClear}
      className="w-full px-1 text-left text-2xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
    >
      {count} {label} without dates hidden by the date filter — clear it to show
      them
    </button>
  );
}

// -- History --

/** `project.dates.effectiveEnd` (a plain "YYYY-MM-DD" date — the derived
 * rollup, or the manual override when set) when non-null; otherwise the
 * household-local year the project was last touched (a reasonable proxy for
 * "completed" — there's no dedicated `completedAt` column). */
function completionYear(project: ProjectOut): string {
  return (
    project.dates.effectiveEnd ?? format(project.updatedAt, "yyyy-MM-dd")
  ).slice(0, 4);
}

/**
 * Completed top-level projects — its own scope (`statusScope: ["done"]`,
 * unfiltered by the shared statuses/kinds/locations/date chips) and its own
 * local kind/location/completion-year filters, reusing `ProjectTable` (same
 * component the Data view uses) for the actual browsing surface.
 */
function HistoryView({
  onViewChange,
}: {
  onViewChange: (v: DashboardView) => void;
}) {
  const api = useTRPC();
  const projectPreview = useEntityPreview("project");
  const { data, isLoading, isError, error, refetch } = useQuery({
    ...api.project.dashboardSummary.queryOptions({ statusScope: ["done"] }),
    staleTime: 5 * 60 * 1000,
  });

  const [kind, setKind] = useState<string | null>(null);
  const [location, setLocation] = useState<string | null>(null);
  const [year, setYear] = useState<string | null>(null);

  const topLevelDone = useMemo(
    () => (data?.projects ?? NO_PROJECTS).filter((p) => !p.parentProjectId),
    [data],
  );

  // Kind/location rosters come from the server's `filterOptions` (already
  // scoped to `statusScope: ["done"]`) rather than being re-derived from the
  // fetched rows here — the server is the single source of truth for what
  // options exist, per `dashboardSummary`.
  const availableCompletionYears = useMemo(
    () => uniq(topLevelDone.map(completionYear)).sort().reverse(),
    [topLevelDone],
  );

  const filtered = useMemo(
    () =>
      topLevelDone.filter(
        (p) =>
          (!kind || p.kind === kind) &&
          (!location || p.locations.includes(location)) &&
          (!year || completionYear(p) === year),
      ),
    [topLevelDone, kind, location, year],
  );

  if (isError) {
    return <DashboardErrorState error={error} onRetry={() => refetch()} />;
  }

  if (isLoading || !data) {
    return <DashboardSkeleton />;
  }

  return (
    <Stack>
      <DashboardToolbar view="history" onViewChange={onViewChange} />

      <Row wrap gap="lg">
        <SingleSelectChipGroup
          label="Kind"
          options={data.filterOptions.kinds}
          value={kind}
          onChange={setKind}
          formatLabel={capitalize}
        />
        <SingleSelectChipGroup
          label="Location"
          options={data.filterOptions.locations}
          value={location}
          onChange={setLocation}
        />
        <SingleSelectChipGroup
          label="Completed"
          options={availableCompletionYears}
          value={year}
          onChange={setYear}
        />
      </Row>

      {filtered.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyIcon icon={HistoryIcon} />
            <EmptyTitle>No completed projects</EmptyTitle>
            <EmptyDescription>
              {topLevelDone.length === 0
                ? "Nothing has wrapped up yet."
                : "Adjust your filters."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ProjectTable
          projects={filtered}
          onRowClick={projectPreview.onRowClick}
          onRowHover={projectPreview.onRowHover}
          PreviewSheet={projectPreview.PreviewSheet}
        />
      )}
    </Stack>
  );
}

// -- Project Cards (Overview + Gallery) --

function ProjectCards({
  projects,
  coverImages,
}: {
  projects: ProjectOut[];
  coverImages: CoverImages | undefined;
}) {
  // Top-level only — sub-projects show on their parent's own detail page
  // (Sub-projects section), not as independent cards here.
  const topLevelProjects = projects.filter((p) => !p.parentProjectId);
  const [active, done] = partition(
    topLevelProjects,
    (p) => p.status !== "done",
  );

  if (active.length === 0 && done.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyIcon icon={Hammer} />
          <EmptyTitle>No projects found</EmptyTitle>
          <EmptyDescription>Adjust your filters.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Stack>
      {active.length > 0 && (
        <Grid cols="cards3">
          {active.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              coverUrl={coverImages?.[project.id]?.[0]?.url}
            />
          ))}
        </Grid>
      )}
      {done.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-muted-foreground text-sm hover:text-foreground">
            Completed ({done.length})
          </summary>
          <Grid cols="cards3" className="mt-4">
            {done.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                coverUrl={coverImages?.[project.id]?.[0]?.url}
              />
            ))}
          </Grid>
        </details>
      )}
    </Stack>
  );
}

function ProjectCard({
  project,
  coverUrl,
}: {
  project: ProjectOut;
  coverUrl: string | undefined;
}) {
  // subtree degenerates to the project's own numbers for a leaf project (see
  // subtree.ts), so this is safe to use uniformly rather than branching on
  // subtree.projectCount. `actualSpent` (money out, excluding planned +
  // contributions) mirrors the detail hero / table "Actual" — using the net
  // `spent` here would fold planned spend and negative contributions into the
  // badge (e.g. a −$75k contribution reading as "-$65,000 spent").
  const spent = project.rollup.subtree.actualSpent;
  // Compare against the subtree estimate to match the subtree spend scope. No
  // `?? project.costEstimate` fallback: the subtree estimate is seeded FROM
  // the project's own, so it is null only when the own estimate is too.
  const estimate = project.rollup.subtree.costEstimate;
  const hasEstimate = estimate != null;
  const overBudget = estimate != null && spent > estimate;

  return (
    <Link
      to={entities.project.routes.detail}
      params={entityDetailParams(project.id)}
      className="block"
    >
      <Card
        size="sm"
        className="overflow-hidden transition-colors hover:bg-muted/50"
      >
        {coverUrl && (
          <div className="relative aspect-[16/9] w-full overflow-hidden">
            <Image
              src={coverUrl}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
            />
          </div>
        )}
        <CardHeader>
          <CardTitle>
            {project.icon && <span>{project.icon}</span>}
            <span className="truncate">{project.name}</span>
          </CardTitle>
          <CardDescription className="flex items-center gap-2">
            <StatusIcon status={project.status} />
            {PROJECT_STATUS_LABELS[project.status]}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Row wrap gap="sm">
            {project.kind && (
              <Badge variant="secondary">{capitalize(project.kind)}</Badge>
            )}
            {project.locations.map((loc) => (
              <Badge
                key={loc}
                variant="outline"
                // Free-form location names — opt out of the mono-uppercase stamp.
                className="font-sans normal-case tracking-normal"
              >
                {loc}
              </Badge>
            ))}
            {hasEstimate && (
              <Badge variant="outline">
                <DollarSign className="size-3" />
                {formatCurrency(estimate ?? 0, 0)}
              </Badge>
            )}
            {spent !== 0 && (
              <Badge
                variant={
                  hasEstimate
                    ? overBudget
                      ? "destructive"
                      : "positive"
                    : "outline"
                }
              >
                <Wallet className="size-3" />
                {formatCurrency(spent, 0)} spent
              </Badge>
            )}
            {(project.dates.effectiveStart || project.dates.effectiveEnd) && (
              <Badge variant="outline">
                <Calendar className="size-3" />
                {formatDateRange(
                  project.dates.effectiveStart,
                  project.dates.effectiveEnd,
                )}
              </Badge>
            )}
          </Row>
        </CardContent>
      </Card>
    </Link>
  );
}

function DashboardSkeleton() {
  return (
    <Stack>
      <Skeleton className="h-8 w-48" />
      <div className="grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder cards have no stable identity
          <Skeleton key={i} className="h-24 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-lg" />
    </Stack>
  );
}
