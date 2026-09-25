import type {
  ProjectDashboardSummaryOut,
  ProjectOut,
  TaskOut,
} from "@cubby/schemas/project";
import { CalendarIcon } from "@phosphor-icons/react/dist/csr/Calendar";
import { CurrencyDollarIcon } from "@phosphor-icons/react/dist/csr/CurrencyDollar";
import { HammerIcon } from "@phosphor-icons/react/dist/csr/Hammer";
import { WalletIcon } from "@phosphor-icons/react/dist/csr/Wallet";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import {
  lazy,
  type MouseEvent,
  type ReactNode,
  Suspense,
  useMemo,
} from "react";

import { SavedViewsMenu } from "~/app/_components/data-table/DataTableViews";
import type { CubbyRow } from "~/app/_components/data-table/table-features";
import {
  entityDisplayImageKey,
  useEntityDisplayImages,
} from "~/app/_components/entity-media/entity-display-images";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import type { PreviewPresentation } from "~/app/_components/hooks/useEntityPreview";
import { ProjectMark } from "~/app/projects/project-mark";
import type { ProjectPortfolioAnalyticsViewProps } from "~/app/projects/project-portfolio-analytics-view";
import { DashboardSectionLoading } from "~/components/feedback/loading-skeletons";
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
import { Checkbox } from "~/components/ui/checkbox";
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
import type { SummaryItem } from "~/components/ui/stat-tile";
import { StatGrid, StatTile } from "~/components/ui/stat-tile";
import { entities, entityDetailParams } from "~/entities/entities";
import { image, type ProjectImageSummaries } from "~/entities/image.functions";
import { getErrorMessage } from "~/lib/error-utils";
import { cn, formatCurrency } from "~/lib/utils";

import {
  defaultFilters,
  type Filters,
  filtersFromSavedViewFilters,
  filtersFromSearch,
  filtersToScopeInput,
  filtersToSearch,
} from "./dashboard-filter-state";
import { ActiveScopeSummary, DashboardFilters } from "./dashboard-filters";
import { NeedsAttention } from "./needs-attention";
import { project } from "./project.functions";
import {
  capitalize,
  formatDate,
  formatDateRange,
  PROJECT_STATUS_LABELS,
  StatusIcon,
} from "./shared";

// Portfolio analytics is one optional interaction: keep all of its Nivo/d3
// charts in one lazy module so selecting Analytics has one predictable fetch.
const ProjectAnalytics = lazy(() =>
  import("./project-portfolio-analytics-view").then((m) => ({
    default: m.ProjectPortfolioAnalyticsView,
  })),
);
const TaskStatusBoard = lazy(() =>
  import("./charts/task-status-board").then((m) => ({
    default: m.TaskStatusBoard,
  })),
);

/** The two project dashboard slots declared beside the ordinary list. */
export type DashboardView = "overview" | "analytics";

/** Cover image (first attached image) per project id — keyed lookup for the gallery/overview cards. */
type CoverImages = ProjectImageSummaries;

const NO_PROJECT_IDS: string[] = [];
const NO_PROJECTS: ProjectOut[] = [];
const NO_KINDS: string[] = [];
const NO_LOCATIONS: string[] = [];
const NO_YEARS: string[] = [];

const route = getRouteApi("/_authenticated/projects/");

export function ProjectsDashboard({ view }: { view: DashboardView }) {
  return <MainDashboard view={view} />;
}

function DashboardToolbar({ filterControl }: { filterControl: ReactNode }) {
  return (
    <Row justify="end" align="center" wrap gap="sm">
      {filterControl}
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
        <EmptyIcon icon={HammerIcon} />
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

/**
 * `dashboardSummary` is fetched for both of these views — it's the
 * bounded, cheap Overview read (summary counts, filtered project list w/
 * rollups, task-status breakdown, upcoming tasks, Needs Attention, filter
 * options), and Overview reuses its `projects` list rather than issuing
 * their own query. Only `portfolioAnalytics` (chart aggregates) and the
 * Data's three lists issue their own paginated server reads. The dashboard
 * summary is never used as a browser-side membership oracle for them.
 */
const dashboardSavedViewFilters = (filters: Filters) => [
  ...(filters.statuses.size > 0
    ? [{ id: "status", value: [...filters.statuses] }]
    : []),
  ...(filters.kinds.size > 0
    ? [{ id: "kind", value: [...filters.kinds] }]
    : []),
  ...(filters.locations.size > 0
    ? [{ id: "locations", value: [...filters.locations] }]
    : []),
  ...(filters.dateRange ? [{ id: "dateRange", value: filters.dateRange }] : []),
  ...(filters.completionYear
    ? [{ id: "completionYear", value: filters.completionYear }]
    : []),
];

function DashboardContent({
  view,
  data,
  coverImages,
  analyticsData,
  analyticsLoading,
}: {
  view: DashboardView;
  data: ProjectDashboardSummaryOut;
  coverImages: CoverImages | undefined;
  analyticsData: ProjectPortfolioAnalyticsViewProps["data"] | undefined;
  analyticsLoading: boolean;
}) {
  if (view === "overview") {
    return <OverviewView data={data} coverImages={coverImages} />;
  }
  if (view === "analytics") {
    return <AnalyticsView data={analyticsData} isLoading={analyticsLoading} />;
  }
  return <AnalyticsView data={analyticsData} isLoading={analyticsLoading} />;
}

function MainDashboard({ view }: { view: DashboardView }) {
  const search = route.useSearch();
  const navigate = route.useNavigate();

  // Keyed on the primitive values so a fresh object per parse doesn't rebuild
  // the Sets — and every downstream memo keyed on `filters` — every render.
  const statusesKey = search.statuses;
  const kindsKey = search.kinds;
  const locationsKey = search.locations;
  const filters = useMemo<Filters>(
    () => filtersFromSearch(search),
    // oxlint-disable-next-line react/exhaustive-deps -- keyed on the primitive values above, not the search object, on purpose
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
    () => dashboardSavedViewFilters(filters),
    [filters],
  );
  const savedViews = (
    <SavedViewsMenu
      entity="project"
      columnFilters={savedViewFilters}
      sorting={[]}
      onApplyFilters={(viewFilters) => {
        handleFiltersChange(filtersFromSavedViewFilters(viewFilters));
      }}
      onApplySort={() => undefined}
    />
  );

  const scopeInput = useMemo(
    () => filtersToScopeInput(filters),
    // oxlint-disable-next-line react/exhaustive-deps -- keyed on the joined-string primitives, not the Set references
    [statusesKey, kindsKey, locationsKey, search.date, search.completed],
  );

  const dashboardQuery = useQuery({
    ...project.dashboardSummary.queryOptions(scopeInput),
  });

  // Chart aggregates are ONLY fetched once the Analytics tab is actually
  // selected — the whole point of splitting `project.dashboard` in two. Date
  // bounds now live in `scopeInput` itself (via `filtersToScopeInput`), so
  // there's no separate dateFrom/dateTo spread here anymore.
  const analyticsQuery = useQuery({
    ...project.portfolioAnalytics.queryOptions(scopeInput),
    enabled: view === "analytics",
  });

  const projects = dashboardQuery.data?.projects ?? NO_PROJECTS;

  // Overview's project cards show cover images; Analytics does not render
  // views don't render any project cards, so skip the query entirely there.
  const showImages = view === "overview";
  const imageProjectIds = showImages
    ? projects.map((p) => p.id)
    : NO_PROJECT_IDS;
  const { data: coverImages } = useQuery({
    ...image.projectSummaries.queryOptions({
      projectIds: imageProjectIds,
    }),
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
        filterControl={
          <DashboardFilters
            filters={filters}
            onFiltersChange={handleFiltersChange}
            availableKinds={data?.filterOptions.kinds ?? NO_KINDS}
            availableLocations={data?.filterOptions.locations ?? NO_LOCATIONS}
            availableYears={data?.filterOptions.years ?? NO_YEARS}
            availableCompletionYears={
              data?.filterOptions.completionYears ?? NO_YEARS
            }
            savedViews={savedViews}
          />
        }
      />

      <ActiveScopeSummary
        filters={filters}
        onClear={() => handleFiltersChange(defaultFilters)}
      />

      {dashboardQuery.isLoading || !data ? (
        <DashboardSkeleton />
      ) : (
        <DashboardContent
          view={view}
          data={data}
          coverImages={coverImages}
          analyticsData={analyticsQuery.data}
          analyticsLoading={analyticsQuery.isLoading}
        />
      )}
    </Stack>
  );
}

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
      {
        // `estimateTotal` is null when NOTHING in scope has a `costEstimate`
        // (nullable end-to-end — see dashboard-summary.ts) — "—", not "$0",
        // for the same reason a per-project BudgetStrip never shows a $0
        // estimate it doesn't have. A PARTIAL population still sums (real
        // money from the projects that DO have one) but discloses which
        // slice of the portfolio that is, rather than presenting it as a
        // complete total.
        label: "Estimate",
        value:
          data.summary.estimateTotal != null
            ? formatCurrency(data.summary.estimateTotal, 0)
            : "—",
        caption:
          data.summary.estimateCoverage.projectsWithEstimate <
          data.summary.estimateCoverage.projectsInScope
            ? `across ${data.summary.estimateCoverage.projectsWithEstimate} of ${data.summary.estimateCoverage.projectsInScope} projects`
            : undefined,
      },
      {
        // Portfolio equivalent of the per-project BudgetStrip's "Committed"
        // figure, split forward by day window (90d is the headline since it's
        // the widest — the sub-line breaks out how much of it lands sooner).
        label: "Committed (90d)",
        value: data.summary.forwardCommittedSpend.in90Days,
        formatter: (v) => formatCurrency(Number(v), 0),
        subValue:
          data.summary.forwardCommittedSpend.in90Days > 0
            ? `${formatCurrency(data.summary.forwardCommittedSpend.in30Days, 0)} in 30d · ${formatCurrency(data.summary.forwardCommittedSpend.in60Days, 0)} in 60d`
            : undefined,
      },
    ],
    [data.summary],
  );

  return (
    <Stack className="pt-4">
      <NeedsAttention items={data.attention} />

      <NextWork tasks={data.nextTasks} />

      <StatGrid>
        {summaryItems.map((item) => (
          <StatTile key={item.label} item={item} />
        ))}
      </StatGrid>

      {/* "Projects", not "Active Projects" — the summary tile above already
          says that; identical text on both would be a strict-mode-locator
          collision in e2e tests and a redundant label for a real reader. */}
      <Section title="Projects">
        <ProjectCards projects={data.projects} coverImages={coverImages} />
        {data.completedCount > 0 && (
          <Link
            to="/projects"
            search={{ view: "table", statuses: "done" }}
            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
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
    </Stack>
  );
}

function NextWork({ tasks }: { tasks: TaskOut[] }) {
  const projectRefs = useMemo(
    () =>
      tasks.flatMap((task) =>
        task.projectId
          ? [{ entityType: "project" as const, entityId: task.projectId }]
          : [],
      ),
    [tasks],
  );
  const projectImages = useEntityDisplayImages(projectRefs);
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
            {task.projectName && task.projectId && (
              <span className="max-w-40 min-w-0 text-xs text-muted-foreground">
                <EntityInlineLink
                  displayImage={
                    projectImages[
                      entityDisplayImageKey({
                        entityType: "project",
                        entityId: task.projectId,
                      })
                    ] ?? null
                  }
                  entity="project"
                  data={{ id: task.projectId, name: task.projectName }}
                  truncate
                />
              </span>
            )}
            {task.dueDate && (
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {formatDate(task.dueDate)}
              </span>
            )}
          </Row>
        ))}
      </Stack>
    </Section>
  );
}

function AnalyticsView({
  data,
  isLoading,
}: {
  data: ProjectPortfolioAnalyticsViewProps["data"];
  isLoading: boolean;
}) {
  return (
    <Suspense fallback={<Skeleton className="h-[400px] w-full" />}>
      <ProjectAnalytics data={data} isLoading={isLoading} />
    </Suspense>
  );
}

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
          <EmptyIcon icon={HammerIcon} />
          <EmptyTitle>No projects found</EmptyTitle>
          <EmptyDescription>Adjust your filters.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Grid cols="cards3">
      {projects.map((project) => {
        return (
          <ProjectCard
            key={project.id}
            project={project}
            coverUrl={coverImages?.[project.id]?.[0]?.url}
          />
        );
      })}
    </Grid>
  );
}

type ProjectCardInspection = {
  row: Pick<
    CubbyRow<ProjectOut>,
    "id" | "getIsSelected" | "getToggleSelectedHandler"
  >;
  currentRowId: string | undefined;
  presentation: PreviewPresentation;
  onRowClick: () => void;
  onRowHover: () => void;
  onRowHoverEnd: () => void;
};

export function ProjectCard({
  project,
  coverUrl,
  inspection,
}: {
  project: ProjectOut;
  coverUrl: string | undefined;
  inspection?: ProjectCardInspection;
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
  const current =
    inspection != null && inspection.currentRowId === inspection.row.id;
  const selected = inspection?.row.getIsSelected() ?? false;
  const handleProjectClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!inspection) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
      return;
    inspection.onRowClick();
  };

  return (
    <Card
      size="sm"
      data-current={current || undefined}
      className={cn(
        "relative overflow-hidden py-0 transition-colors hover:bg-muted/50",
        current && "border-primary/50 bg-primary/[0.035]",
        selected && "ring-1 ring-primary/30",
      )}
      onClick={handleProjectClick}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") inspection?.onRowHover();
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "touch") inspection?.onRowHoverEnd();
      }}
      onFocus={() => inspection?.onRowHover()}
      onBlur={() => inspection?.onRowHoverEnd()}
    >
      {inspection ? (
        <div
          role="presentation"
          className="absolute top-0 right-0 z-10 flex min-h-11 min-w-11 items-center justify-center"
          onClick={(event) => event.stopPropagation()}
        >
          <Checkbox
            checked={selected}
            aria-label={`Select ${project.name}`}
            onCheckedChange={(checked, details) =>
              inspection.row.getToggleSelectedHandler({
                selectChildren: false,
              })({
                target: { checked },
                nativeEvent: details.event,
              })
            }
          />
        </div>
      ) : null}
      <div className={cn("flex flex-col gap-2 py-2.5", coverUrl && "pt-0")}>
        {coverUrl && (
          <div className="relative aspect-[16/9] w-full overflow-hidden">
            <Image
              src={coverUrl}
              alt=""
              displayWidth={400}
              className="absolute inset-0 h-full w-full object-cover"
            />
          </div>
        )}
        <CardHeader>
          <CardTitle>
            <Link
              to={entities.project.routes.detail}
              params={entityDetailParams(project.id)}
              aria-current={current ? "true" : undefined}
              className="inline-flex min-w-0 items-center gap-2"
              onClick={(event) => event.stopPropagation()}
            >
              <ProjectMark icon={project.icon} size={20} />
              <span className="truncate">{project.name}</span>
            </Link>
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
                className="font-sans tracking-normal normal-case"
              >
                {loc}
              </Badge>
            ))}
            {hasEstimate && (
              <Badge variant="outline">
                <CurrencyDollarIcon className="size-3" />
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
                <WalletIcon className="size-3" />
                {formatCurrency(spent, 0)} spent
              </Badge>
            )}
            {(project.dates.effectiveStart || project.dates.effectiveEnd) && (
              <Badge variant="outline">
                <CalendarIcon className="size-3" />
                {formatDateRange(
                  project.dates.effectiveStart,
                  project.dates.effectiveEnd,
                )}
              </Badge>
            )}
          </Row>
        </CardContent>
      </div>
    </Card>
  );
}

function DashboardSkeleton() {
  return <DashboardSectionLoading label="Loading project work…" sections={4} />;
}
