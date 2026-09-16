import {
  type ExpenseOut,
  type ProjectOut,
  type ProjectUpdateData,
  type TaskOut,
  type Trade,
  taskStatusValues,
} from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ColumnFiltersState } from "@tanstack/react-table";
import {
  AlertTriangle,
  ExternalLink,
  FileText,
  FolderTree,
  Info,
  Link2,
  ListChecks,
  Pencil,
  Plus,
  Receipt,
  Share2,
  ShoppingCart,
  Wallet,
  Wrench,
} from "lucide-react";
import {
  lazy,
  type ReactNode,
  Suspense,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import { WithEntitySearch } from "~/app/_components/combobox/with-search-hook";
import { renderOptionCell } from "~/app/_components/data-table/columnHelpers";
import { DependencyPicker } from "~/app/_components/data-table/dependency-picker";
import {
  type DetailSection,
  DetailSections,
} from "~/app/_components/data-table/detail-page";
import {
  EditableCell,
  useOptimisticDisplayValue,
} from "~/app/_components/data-table/editable-cell";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { ChipsInput } from "~/app/_components/forms/chips-input";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { RelationshipSummaryTable } from "~/app/_components/relationships/relationship-summary-table";
import { expense } from "~/app/expenses/expense.functions";
import { ProjectMark } from "~/app/projects/project-mark";
import { TaskBoard } from "~/app/tasks/board/TaskBoard";
import { task } from "~/app/tasks/task.functions";
import { Row, Stack } from "~/components/layout";
import type { DetailHeroStat } from "~/components/layouts/page-hero";
import { Page } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { EntityFilterLink } from "~/components/ui/entity-filter-link";
import { NoneValue } from "~/components/ui/none-value";
import { Skeleton } from "~/components/ui/skeleton";
import { Textarea } from "~/components/ui/textarea";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import {
  expenseCaptureRequest,
  projectCaptureRequest,
  taskCaptureRequest,
} from "~/entities/editing/editor-requests";
import { EntityEditDialog } from "~/entities/editing/entity-edit-dialog";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import {
  editableFieldOverrides,
  EntityBasicInfo,
} from "~/entities/entity-display";
import { entityListFor } from "~/entities/entity-list.functions";
import { image } from "~/entities/image.functions";
import { focusOnMount } from "~/hooks/focus-on-mount";
import { getErrorMessage } from "~/lib/error-utils";
import { splitExpenseSpend } from "~/lib/spend";
import { formatCurrency } from "~/lib/utils";

import { BudgetStrip } from "./BudgetStrip";
import type { TradeCostCell } from "./charts/trade-cost-matrix";
import type { PivotCostKey } from "./charts/trade-cost-pivot";
import { ProjectContributionSection } from "./project-contribution-section";
import { projectDateDelta } from "./project-formatting";
import { ProjectNotes } from "./project-notes";
import { projectKindOptions } from "./project-options";
import { ProjectPurchasesTable } from "./project-purchases-table";
import {
  projectGanttSubtreeQueryParams,
  projectSubtreeExpensesFilters,
  projectSubtreeTasksFilters,
} from "./project-query-params";
import { ProjectResourcesSection } from "./project-tools-section";
import { project as projectOperations } from "./project.functions";
import {
  ExpenseList,
  PROJECT_STATUS_LABELS,
  PROJECT_STATUS_OPTIONS,
  StatusIcon,
  TaskList,
} from "./shared";

const ProjectDetailAnalytics = lazy(() =>
  import("./project-detail-analytics-view").then((module) => ({
    default: module.ProjectDetailAnalyticsView,
  })),
);

const NO_IMAGES: Array<{ id: string; url: string; filename: string }> = [];
const NO_TASKS: TaskOut[] = [];

const TASKS_VIEW_OPTIONS: ViewSwitcherOption<"list" | "board">[] = [
  { value: "list", label: "List" },
  { value: "board", label: "Board" },
];
const NO_EXPENSES: ExpenseOut[] = [];
const NO_CHILD_PROJECTS: ProjectOut[] = [];

/** Tasks section default: the embedded `TaskList` gets fed the full subtree
 * (open + done), but seeds its column-filter state to exclude `done` so open
 * work shows first — a user-visible, user-clearable filter rather than a
 * separately-fetched scoped query. Module scope: it's passed as a prop, and
 * an inline literal here would be a fresh reference every render. */
const OPEN_TASK_FILTERS: ColumnFiltersState = [
  { id: "status", value: taskStatusValues.filter((s) => s !== "done") },
];

interface ProjectDetailPageProps {
  project: ProjectOut;
}

function DependencyBadge({ id, name }: { id: string; name: string }) {
  return (
    <EntityInlineLink
      displayImage={undefined}
      entity="project"
      data={{ id, name }}
      compact
    />
  );
}

function EditableLocations({
  locations,
  onSave,
}: {
  locations: string[];
  onSave: (locations: string[]) => Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [pending, setPending] = useState<string[]>(locations);

  if (!isEditing) {
    return (
      <Row wrap gap="xs" justify="end" align="center">
        {locations.length === 0 ? (
          <NoneValue />
        ) : (
          locations.map((loc) => (
            <EntityFilterLink
              key={loc}
              to="/projects"
              search={{ view: "data", locations: [loc] }}
              label={`Show all projects at ${loc}`}
              variant="value"
              className="no-underline"
            >
              <Badge
                variant="outline"
                className="font-sans tracking-normal normal-case"
              >
                {loc}
              </Badge>
            </EntityFilterLink>
          ))
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            setPending(locations);
            setIsEditing(true);
          }}
          aria-label="Edit locations"
        >
          <Pencil className="size-3 text-muted-foreground" />
        </Button>
      </Row>
    );
  }

  return (
    <Stack gap="xs">
      <ChipsInput
        value={pending}
        onChange={setPending}
        placeholder="Add location..."
      />
      <Row gap="xs" justify="end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={isPending}
          onClick={async () => {
            setIsPending(true);
            try {
              await onSave(pending);
              setIsEditing(false);
            } catch (err) {
              toast.error(getErrorMessage(err));
            } finally {
              setIsPending(false);
            }
          }}
        >
          Save
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={isPending}
          onClick={() => setIsEditing(false)}
        >
          Cancel
        </Button>
      </Row>
    </Stack>
  );
}

/**
 * Start/End date spec-plate field: displays the EFFECTIVE bound (derived
 * rollup or override, whichever wins), but the inline editor opens on and
 * saves to the raw override column (`rawOverride`) — editing a derived value
 * and hitting save would silently freeze a computed date into a permanent
 * override, which is the exact bug the effective/override split exists to
 * prevent. A "derived" effective value renders muted; an explicit override
 * that disagrees with the derived bound hangs a mono ledger annotation under
 * the figure — the derived date plus the signed day delta — so the divergence
 * stays visible instead of silently shadowed.
 *
 * Only a NARROWING override (a start after the earliest dated work, or an end
 * before the latest — the `date_window_drift` attention rule's condition) is
 * flagged; a wider override is deliberate slack. The flag is an amber icon
 * beside an INK delta rather than amber text: `--warning` reads 3.6:1 on
 * paper, under the 4.5:1 floor at this 10px size, so the tone rides the icon
 * (a graphic, held to 3:1) while legibility rides ink and weight.
 */
function ProjectDateField({
  side,
  rawOverride,
  effective,
  derived,
  source,
  onSave,
}: {
  side: "start" | "end";
  rawOverride: string | null;
  effective: string | null;
  derived: string | null;
  source: "explicit" | "derived" | "none";
  onSave: (value: string | null) => Promise<void>;
}) {
  // Mirrors the cell's own post-save optimistic value. Editing the override
  // cannot move `derived` (it rolls up tasks/expenses/children), so pairing
  // the two keeps the annotation true through the save→refetch window, where
  // the `effective`/`source` props still describe the pre-save date.
  const { displayValue: override, setOptimisticValue } =
    useOptimisticDisplayValue<string>(rawOverride);
  const delta =
    derived != null && override != null
      ? projectDateDelta(side, derived, override)
      : null;

  return (
    <Stack gap="tight">
      <EditableCell
        value={rawOverride}
        config={{ type: "date" }}
        onSave={async (next) => {
          await onSave(next);
          setOptimisticValue(next);
        }}
        // `renderValue`'s arg is the optimistic post-save override, so prefer
        // it when non-null — the new date shows immediately rather than
        // waiting for the refetch that recomputes `effective`. Clearing yields
        // null, which correctly falls through to the derived value.
        renderValue={(optimistic) => (
          <span
            className={
              optimistic == null && source === "derived"
                ? "text-muted-foreground"
                : undefined
            }
          >
            {optimistic ?? effective ?? <NoneValue />}
          </span>
        )}
      />
      {delta && (
        <span className="text-2xs">
          <Row
            as="span"
            align="center"
            justify="end"
            gap="xs"
            wrap
            aria-hidden
            title={delta.description}
            className="font-mono text-slate"
          >
            <span>derived: {derived}</span>
            {/* One separator, never two: the flag mark divides the date from
                the delta when it is there, the middot when it is not. */}
            {delta.narrows ? (
              <AlertTriangle className="size-3 shrink-0 text-warning" />
            ) : (
              <span>·</span>
            )}
            <span
              className={
                delta.narrows ? "font-medium text-foreground" : undefined
              }
            >
              {delta.label}
            </span>
          </Row>
          {/* The compact reading is aria-hidden; screen readers get the
              sentence the hover title carries. */}
          <span className="sr-only">{delta.description}</span>
        </span>
      )}
    </Stack>
  );
}

function ProjectResourceLink({
  value,
  placeholder,
  linkLabel,
  onSave,
}: {
  value: string | null;
  placeholder: string;
  linkLabel: string;
  onSave: (value: string | null) => Promise<void>;
}) {
  return (
    <EditableCell
      value={value}
      config={{ type: "text", placeholder }}
      onSave={(next) => onSave(next?.trim() || null)}
      // A real external anchor cannot live inside EditableCell's button-style
      // wrap trigger. Keep it beside the shared pencil trigger instead.
      trigger="pencil"
      renderValue={(url) =>
        url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title={url}
            className="inline-flex min-w-0 items-center gap-1 hover:underline"
          >
            <span className="truncate">{linkLabel}</span>
            <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
          </a>
        ) : (
          <span className="text-muted-foreground">Add</span>
        )
      }
    />
  );
}

function SubProjectsList({
  projects,
  onCreate,
}: {
  projects: ProjectOut[];
  onCreate: () => void;
}) {
  return (
    <Stack gap="sm">
      {projects.length === 0 ? (
        <Empty variant="minimal" className="py-6">
          <EmptyHeader>
            <EmptyTitle>No sub-projects yet</EmptyTitle>
            <EmptyDescription>
              Split this project into phases or trades with their own budget.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Stack gap="xs">
          {projects.map((child) => {
            const childHasSubtree = child.rollup.subtree.projectCount > 0;
            const spent = childHasSubtree
              ? child.rollup.subtree.actualSpent
              : child.rollup.actualSpent;
            const estimate = childHasSubtree
              ? child.rollup.subtree.costEstimate
              : child.costEstimate;
            return (
              <Row key={child.id} justify="between" align="center" gap="sm">
                <Row align="center" gap="xs">
                  <StatusIcon status={child.status} />
                  <EntityInlineLink
                    displayImage={undefined}
                    entity="project"
                    data={{
                      id: child.id,
                      name: child.name,
                      icon: child.icon,
                    }}
                    compact
                  />
                  <Badge variant="outline">
                    {PROJECT_STATUS_LABELS[child.status]}
                  </Badge>
                </Row>
                <span className="text-sm text-muted-foreground">
                  {formatCurrency(spent, 0)}
                  {estimate != null && ` / ${formatCurrency(estimate, 0)}`}
                </span>
              </Row>
            );
          })}
        </Stack>
      )}
      <Row justify="end">
        <Button type="button" variant="outline" size="sm" onClick={onCreate}>
          <Plus className="size-3.5" />
          New sub-project
        </Button>
      </Row>
    </Stack>
  );
}

type SaveProject = (data: ProjectUpdateData) => Promise<void>;
type ParentProjectOption = {
  value: string;
  label: string;
  icon: ReactNode;
};

const projectProgress = (project: ProjectOut, hasSubtree: boolean) => {
  const rollup = hasSubtree ? project.rollup.subtree : project.rollup;
  return rollup.taskCount > 0
    ? `${rollup.doneTaskCount}/${rollup.taskCount} tasks`
    : undefined;
};

const buildProjectOverviewRenderers = (args: {
  project: ProjectOut;
  parentProjectOptions: ParentProjectOption[];
  saveProject: SaveProject;
}) => {
  const { project, parentProjectOptions, saveProject } = args;
  return {
    // `icon` is plain scalar → update {key} — generic. `name` keeps its
    // required-field guard (a cleared name is a no-op, not a write attempt).
    ...editableFieldOverrides("project", project, ["icon"], (variables) =>
      saveProject(variables.data),
    ),
    name: () => ({
      value: (
        <EditableCell
          value={project.name}
          config={{ type: "text" }}
          onSave={async (name) => {
            if (name) await saveProject({ name });
          }}
          renderValue={(value) => value ?? <NoneValue />}
        />
      ),
    }),
    status: () => ({
      value: (
        <EditableCell
          value={project.status}
          config={{ type: "select", options: PROJECT_STATUS_OPTIONS }}
          onSave={async (status) => {
            if (status) await saveProject({ status });
          }}
          renderValue={(status) =>
            status ? (
              <Row as="span" align="center" gap="xs">
                <StatusIcon status={status} />
                {PROJECT_STATUS_LABELS[status]}
              </Row>
            ) : (
              <NoneValue />
            )
          }
        />
      ),
      filterAction: (
        <EntityFilterLink
          to="/projects"
          search={{ view: "data", statuses: [project.status] }}
          label={`Show all ${PROJECT_STATUS_LABELS[project.status].toLowerCase()} projects`}
        />
      ),
    }),
    kind: () => ({
      value: (
        <EditableCell
          value={project.kind}
          config={{ type: "select", options: projectKindOptions }}
          onSave={async (kind) => saveProject({ kind })}
          renderValue={(value) => renderOptionCell(value, projectKindOptions)}
        />
      ),
      filterAction: project.kind ? (
        <EntityFilterLink
          to="/projects"
          search={{ view: "data", kinds: [project.kind] }}
          label={`Show all projects of kind ${project.kind}`}
        />
      ) : undefined,
    }),
    startDate: () => ({
      // The field displays the effective start but edits only the raw override.
      value: (
        <ProjectDateField
          side="start"
          rawOverride={project.startDate}
          effective={project.dates.effectiveStart}
          derived={project.dates.derivedStart}
          source={project.dates.startSource}
          onSave={async (startDate) => saveProject({ startDate })}
        />
      ),
    }),
    endDate: () => ({
      value: (
        <ProjectDateField
          side="end"
          rawOverride={project.endDate}
          effective={project.dates.effectiveEnd}
          derived={project.dates.derivedEnd}
          source={project.dates.endSource}
          onSave={async (endDate) => saveProject({ endDate })}
        />
      ),
    }),
    costEstimate: () => ({
      value: (
        <EditableCell
          value={project.costEstimate}
          config={{ type: "currency" }}
          onSave={async (costEstimate) => saveProject({ costEstimate })}
          renderValue={(value) =>
            value != null ? formatCurrency(value, 0) : <NoneValue />
          }
        />
      ),
    }),
    parentProjectId: () => ({
      value: (
        <EditableCell
          value={project.parentProjectId}
          config={{
            type: "select",
            options: parentProjectOptions,
            placeholder: "No parent — top-level project",
          }}
          onSave={async (parentProjectId) => saveProject({ parentProjectId })}
          renderValue={(value) =>
            value && project.parentProjectName && project.parentProjectId ? (
              <EntityInlineLink
                displayImage={undefined}
                entity="project"
                data={{
                  id: project.parentProjectId,
                  name: project.parentProjectName,
                }}
                compact
              />
            ) : (
              <NoneValue />
            )
          }
        />
      ),
      filterAction: project.parentProjectId ? (
        <EntityFilterLink
          to="/projects"
          search={{ view: "data", parent: project.parentProjectId }}
          label={`Show all projects inside ${project.parentProjectName ?? "this project"}`}
        />
      ) : undefined,
    }),
    locations: () => ({
      value: (
        <EditableLocations
          locations={project.locations}
          onSave={async (locations) => saveProject({ locations })}
        />
      ),
    }),
    updatedAt: () => ({
      // UTC ISO date keeps this SSR output deterministic across time zones.
      value: (
        <span className="font-mono">
          {project.updatedAt.toISOString().slice(0, 10)}
        </span>
      ),
    }),
  };
};

type ProjectNotesSection = {
  section: DetailSection;
  hasContent: boolean;
};

const buildProjectNotesSection = (args: {
  project: ProjectOut;
  isEditing: boolean;
  draft: string;
  pending: boolean;
  onStartEditing: () => void;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}): ProjectNotesSection => {
  const hasContent = args.isEditing || Boolean(args.project.notes?.trim());
  return {
    hasContent,
    section: {
      id: "notes",
      title: "Notes",
      icon: FileText,
      placement: hasContent ? "primary" : "supporting",
      headerAction: args.isEditing ? undefined : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={args.onStartEditing}
        >
          <Pencil className="size-3.5" />
          Edit
        </Button>
      ),
      content: args.isEditing ? (
        <Stack gap="sm">
          <Textarea
            value={args.draft}
            onChange={(event) => args.onDraftChange(event.target.value)}
            rows={8}
            placeholder="Freeform markdown notes..."
            disabled={args.pending}
            ref={focusOnMount}
          />
          <Row gap="xs">
            <Button
              type="button"
              size="sm"
              onClick={args.onSave}
              disabled={args.pending}
            >
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={args.onCancel}
              disabled={args.pending}
            >
              Cancel
            </Button>
          </Row>
        </Stack>
      ) : (
        <ProjectNotes notes={args.project.notes} />
      ),
    },
  };
};

const orderProjectSections = (args: {
  hasNotesContent: boolean;
  showBudget: boolean;
  hasSubtree: boolean;
  notes: DetailSection;
  budget: DetailSection;
  contribution: DetailSection;
  tasks: DetailSection;
  reusableResources: DetailSection;
  expenses: DetailSection;
  purchases: DetailSection;
  purchasedProducts: DetailSection;
  overview: DetailSection;
  resources: DetailSection;
  dependencies: DetailSection;
  subProjects: DetailSection;
  vendors: DetailSection;
}): DetailSection[] => [
  ...(args.hasNotesContent ? [args.notes] : []),
  ...(args.showBudget ? [args.budget] : []),
  args.contribution,
  args.tasks,
  args.reusableResources,
  ...(args.hasSubtree
    ? []
    : [args.expenses, args.purchases, args.purchasedProducts]),
  args.overview,
  args.resources,
  args.dependencies,
  args.subProjects,
  args.vendors,
  ...(args.hasNotesContent ? [] : [args.notes]),
  ...(args.hasSubtree
    ? [args.expenses, args.purchases, args.purchasedProducts]
    : []),
];

type ProjectSpendSplit = ReturnType<typeof splitExpenseSpend>;

const buildProjectHeroStats = (
  project: ProjectOut,
  ownSpend: ProjectSpendSplit,
  hasSubtree: boolean,
): DetailHeroStat[] => [
  ...(project.parentProjectId && project.parentProjectName
    ? [
        {
          label: "Sub-project of",
          value: (
            <EntityInlineLink
              displayImage={undefined}
              entity="project"
              data={{
                id: project.parentProjectId,
                name: project.parentProjectName,
              }}
              truncate
            />
          ),
        } satisfies DetailHeroStat,
      ]
    : []),
  { label: "Actual", value: formatCurrency(ownSpend.actual, 0) },
  ...(ownSpend.committed > 0
    ? [
        {
          label: "Committed",
          value: formatCurrency(ownSpend.committed, 0),
        } satisfies DetailHeroStat,
      ]
    : []),
  ...(hasSubtree
    ? [
        {
          label: "Spent (incl. sub-projects)",
          value: formatCurrency(project.rollup.subtree.spent, 0),
        } satisfies DetailHeroStat,
        {
          label: "Tasks (incl. sub-projects)",
          value: `${project.rollup.subtree.doneTaskCount}/${project.rollup.subtree.taskCount}`,
        } satisfies DetailHeroStat,
        {
          label: "Expenses (incl. sub-projects)",
          value: project.rollup.subtree.expenseCount,
        } satisfies DetailHeroStat,
      ]
    : [
        {
          label: "Tasks",
          value: `${project.rollup.doneTaskCount}/${project.rollup.taskCount}`,
        } satisfies DetailHeroStat,
        {
          label: "Expenses",
          value: project.rollup.expenseCount,
        } satisfies DetailHeroStat,
      ]),
  ...(hasSubtree && project.rollup.subtree.costEstimate !== null
    ? [
        {
          label: "Estimate (incl. sub-projects)",
          value: formatCurrency(project.rollup.subtree.costEstimate, 0),
        } satisfies DetailHeroStat,
      ]
    : []),
];

function useProjectWorkReadModel(project: ProjectOut) {
  const { data: subtreeTasks = NO_TASKS } = useQuery(
    task.chartData.queryOptions(projectSubtreeTasksFilters(project.id)),
  );
  const topLevelTasks = useMemo(
    () => subtreeTasks.filter((candidate) => candidate.parentTaskId == null),
    [subtreeTasks],
  );
  const { data: chartExpenses = NO_EXPENSES } = useQuery(
    expense.chartData.queryOptions(projectSubtreeExpensesFilters(project.id)),
  );
  // chartData is date-ascending. The embedded table preserves its historical
  // newest-first, nulls-last order without relying on an unverified sortFn.
  const sortedSubtreeExpenses = useMemo(
    () =>
      [...chartExpenses].sort((left, right) => {
        if (!left.date && !right.date) return 0;
        if (!left.date) return 1;
        if (!right.date) return -1;
        return right.date.localeCompare(left.date);
      }),
    [chartExpenses],
  );
  const ownSpendSplit = useMemo(
    () =>
      splitExpenseSpend(
        chartExpenses.filter((candidate) => candidate.projectId === project.id),
      ),
    [chartExpenses, project.id],
  );
  const subtreeSpendSplit = useMemo(
    () => splitExpenseSpend(chartExpenses),
    [chartExpenses],
  );
  const budgetEstimate =
    project.rollup.subtree.costEstimate ?? project.costEstimate;
  return {
    subtreeTasks,
    topLevelTasks,
    chartExpenses,
    sortedSubtreeExpenses,
    ownSpendSplit,
    subtreeSpendSplit,
    budgetEstimate,
    showBudget: budgetEstimate != null || chartExpenses.length > 0,
  };
}

function useProjectStructureReadModel(project: ProjectOut) {
  const { data: imageMap } = useQuery({
    ...image.projectSummaries.queryOptions({ projectIds: [project.id] }),
  });
  const { data: childProjectsPage } = useQuery(
    entityListFor("project").queryOptions({
      filters: { parentProjectId: project.id },
      sort: { orderBy: "name", direction: "asc" },
      pagination: { pageIndex: 0, pageSize: 200 },
    }),
  );
  const { data: ganttSubtreePage } = useQuery(
    entityListFor("project").queryOptions(
      projectGanttSubtreeQueryParams(project.id),
    ),
  );
  const { data: projectOptions } = useQuery(
    projectOperations.options.queryOptions(),
  );
  const namesById = useMemo(() => {
    const names = new Map<string, { name: string; icon: string | null }>();
    for (const option of projectOptions ?? []) {
      names.set(option.id, { name: option.name, icon: option.icon });
    }
    return names;
  }, [projectOptions]);
  const resolveDependencies = (ids: ProjectOut["blockedByIds"]) =>
    ids
      .map((id) => {
        const found = namesById.get(id);
        return found
          ? {
              id,
              name: found.name,
              icon: <ProjectMark icon={found.icon} size={12} />,
            }
          : null;
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> =>
        Boolean(candidate),
      );
  const parentProjectOptions = useMemo(
    () =>
      (projectOptions ?? [])
        .filter((option) => option.id !== project.id)
        .map((option) => ({
          value: option.id,
          label: option.name,
          icon: <ProjectMark icon={option.icon} size={12} />,
        })),
    [projectOptions, project.id],
  );
  return {
    images: imageMap?.[project.id] ?? NO_IMAGES,
    childProjects: childProjectsPage?.items ?? NO_CHILD_PROJECTS,
    ganttSubtreeProjects: ganttSubtreePage?.items ?? NO_CHILD_PROJECTS,
    projectNamesById: namesById,
    blockedBy: resolveDependencies(project.blockedByIds),
    blocking: resolveDependencies(project.blockingIds),
    parentProjectOptions,
  };
}

export function ProjectDetailPage({ project }: ProjectDetailPageProps) {
  const {
    subtreeTasks,
    topLevelTasks,
    chartExpenses,
    sortedSubtreeExpenses,
    ownSpendSplit,
    subtreeSpendSplit,
    budgetEstimate,
    showBudget,
  } = useProjectWorkReadModel(project);
  const {
    images,
    childProjects,
    ganttSubtreeProjects,
    projectNamesById,
    blockedBy,
    blocking,
    parentProjectOptions,
  } = useProjectStructureReadModel(project);
  const hasSubtree = project.rollup.subtree.projectCount > 0;
  const [tasksView, setTasksView] = useState<"list" | "board">("list");
  const [isCreatingSubProject, setIsCreatingSubProject] = useState(false);
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [isCreatingExpense, setIsCreatingExpense] = useState(false);
  const updateMutation = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("project", "update"),
    entity: "project",
  });

  const [isEditingNotes, setIsEditingNotes] = useState(false);
  const [notesDraft, setNotesDraft] = useState(project.notes ?? "");
  const [notesPending, setNotesPending] = useState(false);

  const saveNotes = async () => {
    setNotesPending(true);
    try {
      const trimmed = notesDraft.trim();
      await updateMutation.mutateAsync({
        id: project.id,
        data: { notes: trimmed === "" ? null : notesDraft },
      });
      setIsEditingNotes(false);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setNotesPending(false);
    }
  };

  const [activeMatrixCell, setActiveMatrixCell] =
    useState<TradeCostCell | null>(null);
  const expensesRef = useRef<HTMLDivElement>(null);

  const handleMatrixCellClick = (
    trade: Trade,
    costType: PivotCostKey | null,
  ) => {
    setActiveMatrixCell((current) => {
      const clear = current?.trade === trade && current.costType === costType;
      return clear ? null : { trade, costType };
    });
    expensesRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  const saveProject: SaveProject = async (data) => {
    await updateMutation.mutateAsync({ id: project.id, data });
  };
  const overviewRenderers = buildProjectOverviewRenderers({
    project,
    parentProjectOptions,
    saveProject,
  });

  const { hasContent: hasNotesContent, section: notesSection } =
    buildProjectNotesSection({
      project,
      isEditing: isEditingNotes,
      draft: notesDraft,
      pending: notesPending,
      onStartEditing: () => {
        setNotesDraft(project.notes ?? "");
        setIsEditingNotes(true);
      },
      onDraftChange: setNotesDraft,
      onSave: () => void saveNotes(),
      onCancel: () => setIsEditingNotes(false),
    });

  const budgetSection: DetailSection = {
    id: "budget",
    title: "Budget",
    icon: Wallet,
    placement: "primary",
    content: (
      <BudgetStrip estimate={budgetEstimate} split={subtreeSpendSplit} />
    ),
  };

  const contributionSection: DetailSection = {
    id: "contribution",
    title: "Contribution",
    icon: Wallet,
    placement: "primary",
    content: <ProjectContributionSection projectId={project.id} />,
  };

  // Both views render the full top-level subtree now — List view's default
  // "open work first" ordering is a column filter on the embedded TaskList
  // (see `OPEN_TASK_FILTERS`), not a separate scoped fetch.
  const visibleTaskCount = topLevelTasks.length;

  const tasksSection: DetailSection = {
    id: "tasks",
    title: "Tasks",
    icon: ListChecks,
    placement: tasksView === "board" ? "full" : "primary",
    headerAction: (
      <Row align="center" gap="sm">
        {visibleTaskCount > 0 && (
          <Badge variant="outline">{visibleTaskCount}</Badge>
        )}
        <ViewSwitcher
          ariaLabel="Tasks view"
          options={TASKS_VIEW_OPTIONS}
          value={tasksView}
          onValueChange={setTasksView}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setIsCreatingTask(true)}
        >
          <Plus className="size-3.5" />
          New task
        </Button>
      </Row>
    ),
    content:
      tasksView === "board" ? (
        <TaskBoard
          tasks={topLevelTasks}
          cols="status"
          lane={null}
          cacheTarget={{
            source: "chartData",
            filters: projectSubtreeTasksFilters(project.id),
          }}
          showProjectOnCards={hasSubtree}
          maxHeightClassName="max-h-[70vh]"
        />
      ) : (
        <TaskList
          tasks={topLevelTasks}
          showProjectColumn={hasSubtree}
          defaultColumnFilters={OPEN_TASK_FILTERS}
        />
      ),
  };

  const overviewSection: DetailSection = {
    id: "overview",
    title: "Overview",
    icon: Info,
    placement: "supporting",
    content: (
      <EntityBasicInfo
        entity="project"
        record={project}
        overrides={overviewRenderers}
        afterFields={{
          costEstimate: [
            { label: "Progress", value: projectProgress(project, hasSubtree) },
          ],
        }}
      />
    ),
  };

  const reusableResourcesSection: DetailSection = {
    id: "reusable-resources",
    title: "Reusable resources",
    icon: Wrench,
    placement: "primary",
    content: <ProjectResourcesSection projectId={project.id} />,
  };

  const resourcesSection: DetailSection = {
    id: "resources",
    title: "Resources",
    icon: ExternalLink,
    placement: "supporting",
    content: (
      <EntityBasicInfo
        entity="project"
        record={project}
        section="resources"
        overrides={{
          googleDriveFolderUrl: () => ({
            value: (
              <ProjectResourceLink
                value={project.googleDriveFolderUrl}
                placeholder="https://drive.google.com/drive/folders/…"
                linkLabel="Open folder"
                onSave={async (googleDriveFolderUrl) => {
                  await updateMutation.mutateAsync({
                    id: project.id,
                    data: { googleDriveFolderUrl },
                  });
                }}
              />
            ),
          }),
          notionPageUrl: () => ({
            value: (
              <ProjectResourceLink
                value={project.notionPageUrl}
                placeholder="https://….notion.site/…"
                linkLabel="Open page"
                onSave={async (notionPageUrl) => {
                  await updateMutation.mutateAsync({
                    id: project.id,
                    data: { notionPageUrl },
                  });
                }}
              />
            ),
          }),
        }}
      />
    ),
  };

  const dependenciesSection: DetailSection = {
    id: "dependencies",
    title: "Dependencies",
    icon: Link2,
    placement: "supporting",
    content: (
      <Stack gap="sm">
        <Stack gap="xs">
          <p className="my-0 eyebrow">Blocked by</p>
          <DependencyPicker
            value={blockedBy}
            onSave={async (ids) => {
              await updateMutation.mutateAsync({
                id: project.id,
                data: { blockedByIds: ids },
              });
            }}
            SearchProvider={(props) => (
              <WithEntitySearch entity="project" {...props} />
            )}
            label="project"
            excludeId={project.id}
            renderReadChip={(item) => {
              return projectNamesById.has(item.id) ? (
                <DependencyBadge id={item.id} name={item.name} />
              ) : null;
            }}
          />
        </Stack>
        {blocking.length > 0 && (
          <Stack gap="xs">
            <p className="my-0 eyebrow">Blocks</p>
            <Row wrap gap="sm">
              {blocking.map((p) => (
                <DependencyBadge key={p.id} {...p} />
              ))}
            </Row>
          </Stack>
        )}
      </Stack>
    ),
  };

  const subProjectsSection: DetailSection = {
    id: "sub-projects",
    title: "Sub-projects",
    icon: FolderTree,
    placement: "supporting",
    headerAction:
      childProjects.length > 0 ? (
        <Badge variant="outline">{childProjects.length}</Badge>
      ) : undefined,
    content: (
      <SubProjectsList
        projects={childProjects}
        onCreate={() => setIsCreatingSubProject(true)}
      />
    ),
  };

  // Leaf projects lead with the ledger in the wide column (no sub-project tree to
  // show, so the main column would otherwise sit empty under a short Tasks card);
  // subtree projects keep the ledger as a full-width band and show the project
  // column since rows span multiple sub-projects.
  const expensesSection: DetailSection = {
    id: "expenses",
    title: "Expenses",
    icon: ShoppingCart,
    placement: hasSubtree ? "full" : "primary",
    headerAction: (
      <Row align="center" gap="sm">
        {sortedSubtreeExpenses.length > 0 && (
          <Badge variant="outline">{sortedSubtreeExpenses.length}</Badge>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setIsCreatingExpense(true)}
        >
          <Plus className="size-3.5" />
          New expense
        </Button>
      </Row>
    ),
    content: (
      <div ref={expensesRef}>
        <ExpenseList
          expenses={sortedSubtreeExpenses}
          tradeFilter={activeMatrixCell?.trade ?? null}
          costTypeFilter={activeMatrixCell?.costType ?? null}
          showProjectColumn={hasSubtree}
        />
      </div>
    ),
  };

  const purchasesSection: DetailSection = {
    id: "purchases",
    title: "Purchases",
    icon: Receipt,
    placement: hasSubtree ? "full" : "primary",
    content: (
      <ProjectPurchasesTable
        projectId={project.id}
        expenses={sortedSubtreeExpenses}
      />
    ),
  };

  const purchasedProductsSection: DetailSection = {
    id: "purchased-products",
    title: "Purchased products",
    icon: ShoppingCart,
    placement: hasSubtree ? "full" : "primary",
    content: (
      <RelationshipSummaryTable
        relationKey="project.purchasedProducts"
        sourceId={project.id}
        includeSubProjects={true}
        columns={[
          "target",
          "acquired",
          "purchases",
          "expenses",
          "netSpend",
          "latestActivity",
        ]}
        defaultSort={{ field: "latestActivity", direction: "desc" }}
        emptyCopy="No product-linked expenses have been recorded for this project yet."
        note="Expenses without a linked product are excluded."
        expenseHref={(target) =>
          `/expenses?project=${encodeURIComponent(project.id)}&subprojects=true&productId=${encodeURIComponent(target?.id ?? "")}`
        }
      />
    ),
  };

  const vendorsSection: DetailSection = {
    id: "vendors",
    title: "Vendors",
    icon: ShoppingCart,
    placement: "primary",
    content: (
      <RelationshipSummaryTable
        relationKey="project.vendors"
        sourceId={project.id}
        includeSubProjects={true}
        columns={[
          "target",
          "purchases",
          "expenses",
          "unpriced",
          "netSpend",
          "latestActivity",
        ]}
        defaultSort={{ field: "netSpend", direction: "desc" }}
        emptyCopy="No vendor-linked expenses have been recorded for this project yet."
        nullLabel="No purchase/vendor"
        expenseHref={(target) =>
          `/expenses?project=${encodeURIComponent(project.id)}&subprojects=true&vendor=${encodeURIComponent(target?.id ?? "__none__")}`
        }
      />
    ),
  };

  // History is appended automatically by `DetailSections` for every auditable
  // entity — see `ACTIVITY_SECTION_ID` there. Not hand-wired here (previously
  // duplicated `useEntityDetail`'s `history` commonSection, which this page
  // can't use wholesale: project also declares `images`, and that common
  // section reads `data.images` — which `ProjectOut` doesn't carry (images
  // come from the separate project-image projection and already ride the
  // hero), so it would render an always-empty Images card).

  const sections = orderProjectSections({
    hasNotesContent,
    showBudget,
    hasSubtree,
    notes: notesSection,
    budget: budgetSection,
    contribution: contributionSection,
    tasks: tasksSection,
    reusableResources: reusableResourcesSection,
    expenses: expensesSection,
    purchases: purchasesSection,
    purchasedProducts: purchasedProductsSection,
    overview: overviewSection,
    resources: resourcesSection,
    dependencies: dependenciesSection,
    subProjects: subProjectsSection,
    vendors: vendorsSection,
  });
  const heroStats = buildProjectHeroStats(project, ownSpendSplit, hasSubtree);

  return (
    <Page
      variant="detail"
      entity="project"
      title={
        <Row align="center" gap="xs">
          <ProjectMark icon={project.icon} size={20} />
          {project.name}
        </Row>
      }
      rawData={project}
      heroImages={images}
      heroStamp={{
        label: PROJECT_STATUS_LABELS[project.status],
        tone: project.status === "done" ? "green" : "ink",
      }}
      heroStats={heroStats}
      heroActions={{
        secondary: (
          <Link to="/entities" search={{ tab: "work", projectId: project.id }}>
            <Button variant="outline">
              <Share2 />
              Graph
            </Button>
          </Link>
        ),
      }}
    >
      <DetailSections
        sections={sections}
        rawData={project}
        heroImages={images}
      />

      <EntityEditDialog
        open={isCreatingSubProject}
        onOpenChange={setIsCreatingSubProject}
        request={projectCaptureRequest({ parentProjectId: project.id })}
      />

      <EntityEditDialog
        open={isCreatingTask}
        onOpenChange={setIsCreatingTask}
        request={taskCaptureRequest({ projectId: project.id })}
      />

      <EntityEditDialog
        open={isCreatingExpense}
        onOpenChange={setIsCreatingExpense}
        request={expenseCaptureRequest({ projectId: project.id })}
      />

      {/* Spending/task charts scoped to this project PLUS its whole sub-project
          subtree — full-bleed, below the card grid (same treatment as the
          /projects list page's own chart panels). Expenses-dependent charts
          and the task timeline are gated independently — a project with tasks
          but no expenses (or vice versa) must still see its own section. */}
      {(chartExpenses.length > 0 ||
        subtreeTasks.length > 0 ||
        ganttSubtreeProjects.length > 0) && (
        <Suspense fallback={<Skeleton className="h-[400px] w-full" />}>
          <ProjectDetailAnalytics
            projectId={project.id}
            costEstimate={project.rollup.subtree.costEstimate}
            hasSubtree={hasSubtree}
            expenses={chartExpenses}
            tasks={subtreeTasks}
            topLevelTasks={topLevelTasks}
            subtreeProjects={ganttSubtreeProjects}
            activeMatrixCell={activeMatrixCell}
            onMatrixCellClick={handleMatrixCellClick}
          />
        </Suspense>
      )}
    </Page>
  );
}
