import type {
  EmbeddedProjectScope,
  ProjectDashboardSummaryOut,
  ProjectFilters,
  ProjectOut,
  ProjectPortfolioAnalyticsOut,
  ProjectStatus,
  TaskOut,
} from "@cubby/schemas/project";
import { projectStatusValues } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { Calendar, DollarSign, Hammer, Wallet } from "lucide-react";
import { lazy, type ReactNode, Suspense, useMemo } from "react";
import { SavedViewsMenu } from "~/app/_components/data-table/DataTableViews";
import { CreateDialogAction } from "~/app/_components/forms/create-dialog-action";
import { useEntityList } from "~/app/_components/hooks/useEntityList";
import { useFilterOptions } from "~/app/_components/hooks/useFilterOptions";
import { useProjectOptions } from "~/app/_components/hooks/useProjectOptions";
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
import { CreateProjectDialog } from "./create-project-dialog";
import {
  defaultFilters,
  type Filters,
  filtersFromSearch,
  filtersToScopeInput,
  filtersToSearch,
} from "./dashboard-filter-state";
import { DashboardFilters } from "./dashboard-filters";
import { NeedsAttention } from "./needs-attention";
import {
  ProjectDataExpenseList,
  ProjectDataTaskList,
} from "./project-data-lists";
import {
  capitalize,
  formatDate,
  formatDateRange,
  PROJECT_STATUS_LABELS,
  ProjectTable,
  StatusIcon,
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

type DashboardView = "overview" | "analytics" | "data" | "gallery";

const DASHBOARD_VIEW_OPTIONS: ViewSwitcherOption<DashboardView>[] = [
  { value: "overview", label: "Overview" },
  { value: "analytics", label: "Analytics" },
  { value: "data", label: "Data" },
  { value: "gallery", label: "Gallery" },
];

/** Cover image (first attached image) per project id — keyed lookup for the gallery/overview cards. */
type CoverImages = RouterOutputs["image"]["imagesByProjectIds"];

const NO_PROJECT_IDS: string[] = [];
const NO_PROJECTS: ProjectOut[] = [];
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

  return <MainDashboard view={view} onViewChange={onViewChange} />;
}

// -- Toolbar (shared across every view) --

function DashboardToolbar({
  view,
  onViewChange,
  savedViews,
}: {
  view: DashboardView;
  onViewChange: (v: DashboardView) => void;
  savedViews?: ReactNode;
}) {
  return (
    <Row justify="between" align="center" wrap gap="sm">
      <ViewSwitcher
        ariaLabel="Dashboard view"
        options={DASHBOARD_VIEW_OPTIONS}
        value={view}
        onValueChange={onViewChange}
      />
      <Row align="center" gap="sm">
        {savedViews}
        <CreateDialogAction Dialog={CreateProjectDialog}>
          New Project
        </CreateDialogAction>
      </Row>
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
 * bounded, cheap Overview read (summary counts, filtered project list w/
 * rollups, task-status breakdown, upcoming tasks, Needs Attention, filter
 * options), and Data/Gallery reuse its `projects` list rather than issuing
 * their own query. Only `portfolioAnalytics` (chart aggregates) and the
 * Data's three lists issue their own paginated server reads. The dashboard
 * summary is never used as a browser-side membership oracle for them.
 */
function MainDashboard({
  view,
  onViewChange,
}: {
  view: DashboardView;
  onViewChange: (v: DashboardView) => void;
}) {
  const api = useTRPC();
  const search = route.useSearch();
  const navigate = route.useNavigate();

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
    [statusesKey, kindsKey, locationsKey, search.date, search.completed],
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

  const savedViewFilters = useMemo(
    () => [
      ...(filters.statuses.size > 0
        ? [{ id: "status", value: [...filters.statuses] }]
        : []),
      ...(filters.kinds.size > 0
        ? [{ id: "kind", value: [...filters.kinds] }]
        : []),
      ...(filters.locations.size > 0
        ? [{ id: "locations", value: [...filters.locations] }]
        : []),
      ...(filters.dateRange
        ? [{ id: "dateRange", value: filters.dateRange }]
        : []),
      ...(filters.completionYear
        ? [{ id: "completionYear", value: filters.completionYear }]
        : []),
    ],
    [filters],
  );
  const savedViews = (
    <SavedViewsMenu
      entity="project"
      columnFilters={savedViewFilters}
      sorting={[]}
      onApplyFilters={(viewFilters) => {
        const status = viewFilters.find((filter) => filter.id === "status");
        const statuses = Array.isArray(status?.value)
          ? status.value.filter((value): value is ProjectStatus =>
              projectStatusValues.includes(value as ProjectStatus),
            )
          : [];
        handleFiltersChange({
          ...defaultFilters,
          statuses: new Set(statuses),
        });
      }}
      onApplySort={() => undefined}
    />
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the joined-string primitives, not the Set references
  const scopeInput = useMemo(
    () => filtersToScopeInput(filters),
    [statusesKey, kindsKey, locationsKey, search.date, search.completed],
  );
  const projectScope = useMemo<EmbeddedProjectScope>(
    () => ({
      statuses: scopeInput.statusScope,
      kinds: scopeInput.kinds,
      locations: scopeInput.locations,
      dateFrom: scopeInput.dateFrom,
      dateTo: scopeInput.dateTo,
      completionYear: scopeInput.completionYear,
    }),
    [scopeInput],
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

  const projects = dashboardQuery.data?.projects ?? NO_PROJECTS;

  // Overview's project cards and Gallery both show cover images; the other
  // views don't render any project cards, so skip the query entirely there.
  const showImages = view === "overview";
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
      <DashboardToolbar
        view={view}
        onViewChange={onViewChange}
        savedViews={savedViews}
      />

      <DashboardFilters
        filters={filters}
        onFiltersChange={handleFiltersChange}
        availableKinds={data?.filterOptions.kinds ?? NO_KINDS}
        availableLocations={data?.filterOptions.locations ?? NO_LOCATIONS}
        availableYears={data?.filterOptions.years ?? NO_YEARS}
        availableCompletionYears={
          data?.filterOptions.completionYears ?? NO_YEARS
        }
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
              projectScope={projectScope}
              locations={data.filterOptions.locations}
              completionYears={data.filterOptions.completionYears}
              hiddenByDate={data.hiddenByDate}
              onClearDate={() =>
                handleFiltersChange({ ...filters, dateRange: null })
              }
            />
          )}

          {view === "gallery" && (
            <div className="pt-4">
              <ServerProjectGallery
                locations={data.filterOptions.locations}
                completionYears={data.filterOptions.completionYears}
              />
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
            search={{ view: "data", statuses: ["done"] }}
            className="text-muted-foreground text-xs hover:text-foreground hover:underline"
          >
            {data.completedCount} completed project
            {data.completedCount !== 1 ? "s" : ""} — view completed →
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
          <TradeActivity
            data={data.tradeActivity}
            adjustments={data.adjustments.net}
          />
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
  projectScope,
  locations,
  completionYears,
  hiddenByDate,
  onClearDate,
}: {
  projectScope: EmbeddedProjectScope;
  locations: string[];
  completionYears: string[];
  hiddenByDate: ProjectDashboardSummaryOut["hiddenByDate"];
  onClearDate: () => void;
}) {
  return (
    <Stack className="pt-4">
      <Stack as="section">
        <h2 className="font-heading font-semibold text-xl">Projects</h2>
        <ProjectTable locations={locations} completionYears={completionYears} />
        <HiddenByDateNote
          count={hiddenByDate.projects}
          label="projects"
          onClear={onClearDate}
        />
      </Stack>

      <Stack as="section">
        <h2 className="font-heading font-semibold text-xl">Tasks</h2>
        <ProjectDataTaskList projectScope={projectScope} />
        <HiddenByDateNote
          count={hiddenByDate.tasks}
          label="tasks"
          onClear={onClearDate}
        />
      </Stack>

      <Stack as="section">
        <h2 className="font-heading font-semibold text-xl">Expenses</h2>
        <ProjectDataExpenseList projectScope={projectScope} />
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

// -- Project Cards (Overview + Gallery) --

function ProjectCards({
  projects,
  coverImages,
}: {
  projects: ProjectOut[];
  coverImages: CoverImages | undefined;
}) {
  if (projects.length === 0) {
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
    <Grid cols="cards3">
      {projects.map((project) => (
        <ProjectCard
          key={project.id}
          project={project}
          coverUrl={coverImages?.[project.id]?.[0]?.url}
        />
      ))}
    </Grid>
  );
}

/** Gallery is the ordinary paginated project list rendered as cards. */
function ServerProjectGallery({
  locations,
  completionYears,
}: {
  locations: string[];
  completionYears: string[];
}) {
  const api = useTRPC();
  const helper = useMemo(() => createColumnHelper<ProjectOut>(), []);
  const { options: projectOptions } = useProjectOptions();
  const filterOptions = useFilterOptions({
    project: projectOptions,
    projectLocations: locations.map((value) => ({ value, label: value })),
    projectCompletionYears: completionYears.map((value) => ({
      value,
      label: value,
    })),
  });
  const columns = useMemo(
    () => [
      helper.accessor("status", { id: "status" }),
      helper.accessor("kind", { id: "kind" }),
      helper.accessor("locations", { id: "locations" }),
      helper.accessor("parentProjectName", { id: "parent" }),
      helper.accessor("startDate", { id: "startDate" }),
    ],
    [helper],
  );
  const list = useEntityList<ProjectOut, ProjectFilters>({
    entity: "project",
    queryOptions: api.project.list.queryOptions,
    columns,
    filterOptions,
    columnVisibilityScope: "gallery",
  });
  const ids = useMemo(
    () => list.data.map((project) => project.id),
    [list.data],
  );
  const { data: images } = useQuery({
    ...api.image.imagesByProjectIds.queryOptions({ projectIds: ids }),
    enabled: ids.length > 0,
  });

  if (list.isLoading) return <Skeleton className="h-[400px] w-full" />;
  if (list.error) {
    return (
      <DashboardErrorState
        error={list.error}
        onRetry={() => void list.refreshControls.onRefresh()}
      />
    );
  }

  return (
    <Stack>
      <ProjectCards projects={list.data} coverImages={images} />
      {list.infiniteScroll.hasNextPage && (
        <Button
          type="button"
          variant="outline"
          disabled={list.infiniteScroll.isFetchingNextPage}
          onClick={list.infiniteScroll.fetchNextPage}
        >
          {list.infiniteScroll.isFetchingNextPage
            ? "Loading…"
            : "Load more projects"}
        </Button>
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
