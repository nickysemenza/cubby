import {
  type ExpenseOut,
  type ProjectKind,
  type ProjectOut,
  type ProjectStatus,
  type TaskOut,
  type Trade,
  taskStatusValues,
} from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
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
  ShoppingCart,
  Wallet,
  Wrench,
} from "lucide-react";
import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { WithProjectSearch } from "~/app/_components/combobox/with-search-hook";
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
import { useEntityDelete } from "~/app/_components/hooks/useEntityDelete";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { RelationshipSummaryTable } from "~/app/_components/relationships/relationship-summary-table";
import { ProjectMark } from "~/app/projects/project-mark";
import { TaskBoard } from "~/app/tasks/board/TaskBoard";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { Row, Section, Stack } from "~/components/layout";
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
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
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
import {
  ExpenseList,
  PROJECT_STATUS_LABELS,
  PROJECT_STATUS_OPTIONS,
  StatusIcon,
  TaskList,
} from "./shared";
import { splitExpenseSpend } from "./spend";

// Charts are Nivo/d3-heavy (~590 KiB with @react-spring + d3) and every one of
// them is gated on data existing, below the fold. Lazy-loading keeps that stack
// out of this page's chunk — and out of the SSR graph, since this route is
// `ssr: false` and never renders them on the server anyway.
const CategoryBreakdown = lazy(() =>
  import("./charts/category-breakdown").then((m) => ({
    default: m.CategoryBreakdown,
  })),
);
const ProjectGantt = lazy(() =>
  import("./charts/gantt/ProjectGantt").then((m) => ({
    default: m.ProjectGantt,
  })),
);
const PlannedVsActual = lazy(() =>
  import("./charts/planned-vs-actual").then((m) => ({
    default: m.PlannedVsActual,
  })),
);
const SpendingOverTime = lazy(() =>
  import("./charts/spending-over-time").then((m) => ({
    default: m.SpendingOverTime,
  })),
);
const TaskHeatmap = lazy(() =>
  import("./charts/task-heatmap").then((m) => ({ default: m.TaskHeatmap })),
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
                className="font-sans normal-case tracking-normal"
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
                <span className="text-muted-foreground text-sm">
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

export function ProjectDetailPage({ project }: ProjectDetailPageProps) {
  const api = useTRPC();

  // One subtree fetch (project + every live descendant) feeds the Gantt, the
  // Task Timeline, and the Board view — all of which need the whole (incl.
  // done) picture. The default List view uses the separate scoped
  // `openTasks`/`doneTasks` queries below instead (see their comment).
  const { data: subtreeTasks = NO_TASKS } = useQuery(
    api.task.chartData.queryOptions(projectSubtreeTasksFilters(project.id)),
  );
  // Task Timeline shows top-level tasks only — checklist subtasks roll up to
  // their parent everywhere (N/M chip); surfacing them here would
  // double-count the work. The Gantt keeps the full result (dated subtasks
  // render as their parent's indented children).
  const topLevelTasks = useMemo(
    () => subtreeTasks.filter((t) => t.parentTaskId == null),
    [subtreeTasks],
  );
  const hasSubtree = project.rollup.subtree.projectCount > 0;
  const [tasksView, setTasksView] = useState<"list" | "board">("list");

  // Full subtree expense history — feeds the Budget card + the spend charts
  // below, AND (as of the column-filter default below) the embedded Expenses
  // section table, so there's a single subtree fetch instead of a separate
  // scoped `expense.list` round-trip just to bound what that table renders.
  const { data: chartExpenses = NO_EXPENSES } = useQuery(
    api.expense.chartData.queryOptions(
      projectSubtreeExpensesFilters(project.id),
    ),
  );

  // The embedded ExpenseList holds no sorting state, and `chartData` returns
  // rows date-ASCENDING — so feeding `chartExpenses` straight through would
  // make page 1 the OLDEST rows. Flip to newest-first, nulls-last (matching
  // the old scoped-query default) before handing it to the table. Do NOT
  // replace this with `initialState.sorting` instead — the date column has
  // no `sortFn` and nulls-handling there is unverified.
  const sortedSubtreeExpenses = useMemo(
    () =>
      [...chartExpenses].sort((a, b) => {
        if (!a.date && !b.date) return 0;
        if (!a.date) return 1;
        if (!b.date) return -1;
        return b.date.localeCompare(a.date);
      }),
    [chartExpenses],
  );

  const ownSpendSplit = useMemo(
    () =>
      splitExpenseSpend(
        chartExpenses.filter((p) => p.projectId === project.id),
      ),
    [chartExpenses, project.id],
  );
  const subtreeSpendSplit = useMemo(
    () => splitExpenseSpend(chartExpenses),
    [chartExpenses],
  );
  const budgetEstimate =
    project.rollup.subtree.costEstimate ?? project.costEstimate;
  const showBudget = budgetEstimate != null || chartExpenses.length > 0;

  const { data: imageMap } = useQuery({
    ...api.image.imagesByProjectIds.queryOptions({ projectIds: [project.id] }),
    staleTime: 5 * 60 * 1000,
  });
  const images = imageMap?.[project.id] ?? NO_IMAGES;

  const { data: childProjectsPage } = useQuery(
    api.project.list.queryOptions({
      filters: { parentProjectId: project.id },
      sort: { orderBy: "name", direction: "asc" },
      pagination: { pageIndex: 0, pageSize: 200 },
    }),
  );
  const childProjects = childProjectsPage?.items ?? NO_CHILD_PROJECTS;
  const [isCreatingSubProject, setIsCreatingSubProject] = useState(false);
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [isCreatingExpense, setIsCreatingExpense] = useState(false);

  const { data: ganttSubtreePage } = useQuery(
    api.project.list.queryOptions(projectGanttSubtreeQueryParams(project.id)),
  );
  const ganttSubtreeProjects = ganttSubtreePage?.items ?? NO_CHILD_PROJECTS;

  const updateMutation = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("project", "update"),
    entity: "project",
  });

  // `deleteProjects` refuses a project that still has sub-projects, tasks or
  // expenses (assertNoDependents) — that error surfaces as the hook's toast,
  // so the destructive case explains itself rather than needing a guard here.
  const { deleteButton, deleteDialog } = useEntityDelete({
    id: project.id,
    name: project.name,
    entityLabel: "Project",
    entity: "project",
    mutationOptions: (callbacks) =>
      entityMutationOptionsFactory("project", "delete")(callbacks),
    redirectTo: "/projects",
  });

  const { data: projectOptions } = useQuery(api.project.options.queryOptions());
  const projectNamesById = useMemo(() => {
    const map = new Map<string, { name: string; icon: string | null }>();
    for (const p of projectOptions ?? [])
      map.set(p.id, { name: p.name, icon: p.icon });
    return map;
  }, [projectOptions]);
  const resolveDependencyNames = (ids: ProjectOut["blockedByIds"]) =>
    ids
      .map((id) => {
        const found = projectNamesById.get(id);
        return found
          ? {
              id,
              name: found.name,
              icon: <ProjectMark icon={found.icon} size={12} />,
            }
          : null;
      })
      .filter((p): p is NonNullable<typeof p> => p != null);
  const blockedBy = resolveDependencyNames(project.blockedByIds);
  const blocking = resolveDependencyNames(project.blockingIds);

  const parentProjectOptions = useMemo(
    () =>
      (projectOptions ?? [])
        .filter((p) => p.id !== project.id)
        .map((p) => ({
          value: p.id,
          label: p.name,
          icon: <ProjectMark icon={p.icon} size={12} />,
        })),
    [projectOptions, project.id],
  );

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

  const fields: BasicInfoField[] = [
    {
      label: "Name",
      value: (
        <EditableCell
          value={project.name}
          config={{ type: "text" }}
          onSave={async (name) => {
            if (!name) return;
            await updateMutation.mutateAsync({
              id: project.id,
              data: { name },
            });
          }}
          renderValue={(v) => v ?? <NoneValue />}
        />
      ),
    },
    {
      label: "Icon",
      value: (
        <EditableCell
          value={project.icon}
          config={{ type: "text", placeholder: "e.g. 🔧" }}
          onSave={async (icon) => {
            await updateMutation.mutateAsync({
              id: project.id,
              data: { icon },
            });
          }}
          renderValue={(v) => v ?? <NoneValue />}
        />
      ),
    },
    {
      label: "Status",
      value: (
        <EditableCell
          value={project.status}
          config={{ type: "select", options: PROJECT_STATUS_OPTIONS }}
          onSave={async (status) => {
            if (!status) return;
            await updateMutation.mutateAsync({
              id: project.id,
              data: { status: status as ProjectStatus },
            });
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
    },
    {
      label: "Kind",
      value: (
        <EditableCell
          value={project.kind}
          config={{ type: "select", options: projectKindOptions }}
          onSave={async (kind) => {
            await updateMutation.mutateAsync({
              id: project.id,
              data: { kind: kind as ProjectKind | null },
            });
          }}
          renderValue={(v) => renderOptionCell(v, projectKindOptions)}
        />
      ),
      filterAction: project.kind ? (
        <EntityFilterLink
          to="/projects"
          search={{ view: "data", kinds: [project.kind] }}
          label={`Show all projects of kind ${project.kind}`}
        />
      ) : undefined,
    },
    {
      // Displays the EFFECTIVE start (rolled up from tasks/expenses/live
      // sub-projects, or the override when set); the editor still opens on
      // and saves to the raw `startDate` override column, never the derived
      // value — see `projectDateWindow`'s doc comment in
      // packages/schemas/src/project.ts.
      label: "Start date",
      value: (
        <ProjectDateField
          side="start"
          rawOverride={project.startDate}
          effective={project.dates.effectiveStart}
          derived={project.dates.derivedStart}
          source={project.dates.startSource}
          onSave={async (startDate) => {
            await updateMutation.mutateAsync({
              id: project.id,
              data: { startDate },
            });
          }}
        />
      ),
    },
    {
      label: "End date",
      value: (
        <ProjectDateField
          side="end"
          rawOverride={project.endDate}
          effective={project.dates.effectiveEnd}
          derived={project.dates.derivedEnd}
          source={project.dates.endSource}
          onSave={async (endDate) => {
            await updateMutation.mutateAsync({
              id: project.id,
              data: { endDate },
            });
          }}
        />
      ),
    },
    {
      label: "Estimate",
      value: (
        <EditableCell
          value={project.costEstimate}
          config={{ type: "currency" }}
          onSave={async (costEstimate) => {
            await updateMutation.mutateAsync({
              id: project.id,
              data: { costEstimate },
            });
          }}
          renderValue={(v) =>
            v != null ? formatCurrency(v, 0) : <NoneValue />
          }
        />
      ),
    },
    {
      label: "Progress",
      value: (() => {
        const r = hasSubtree ? project.rollup.subtree : project.rollup;
        return r.taskCount > 0
          ? `${r.doneTaskCount}/${r.taskCount} tasks`
          : undefined;
      })(),
    },
    {
      label: "Parent project",
      value: (
        <EditableCell
          value={project.parentProjectId}
          config={{
            type: "select",
            options: parentProjectOptions,
            placeholder: "No parent — top-level project",
          }}
          onSave={async (parentProjectId) => {
            await updateMutation.mutateAsync({
              id: project.id,
              data: { parentProjectId },
            });
          }}
          renderValue={(v) =>
            v && project.parentProjectName && project.parentProjectId ? (
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
    },
    {
      label: "Locations",
      value: (
        <EditableLocations
          locations={project.locations}
          onSave={async (locations) => {
            await updateMutation.mutateAsync({
              id: project.id,
              data: { locations },
            });
          }}
        />
      ),
    },
    {
      label: "Last updated",
      // UTC ISO date — deterministic across server/client render (a locale/tz
      // format here would risk a hydration mismatch on this SSR'd page).
      value: (
        <span className="font-mono">
          {project.updatedAt.toISOString().slice(0, 10)}
        </span>
      ),
    },
  ];

  const hasNotesContent = isEditingNotes || !!project.notes?.trim();
  const notesSection: DetailSection = {
    id: "notes",
    title: "Notes",
    icon: FileText,
    placement: hasNotesContent ? "primary" : "supporting",
    headerAction: isEditingNotes ? undefined : (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          setNotesDraft(project.notes ?? "");
          setIsEditingNotes(true);
        }}
      >
        <Pencil className="size-3.5" />
        Edit
      </Button>
    ),
    content: isEditingNotes ? (
      <Stack gap="sm">
        <Textarea
          value={notesDraft}
          onChange={(e) => setNotesDraft(e.target.value)}
          rows={8}
          placeholder="Freeform markdown notes..."
          disabled={notesPending}
          autoFocus
        />
        <Row gap="xs">
          <Button
            type="button"
            size="sm"
            onClick={() => void saveNotes()}
            disabled={notesPending}
          >
            Save
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setIsEditingNotes(false)}
            disabled={notesPending}
          >
            Cancel
          </Button>
        </Row>
      </Stack>
    ) : (
      <ProjectNotes notes={project.notes} />
    ),
  };

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
    content: <BasicInfo fields={fields} />,
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
      <BasicInfo
        fields={[
          {
            label: "Google Drive folder",
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
          },
          {
            label: "Notion page",
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
          },
        ]}
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
          <p className="eyebrow my-0">Blocked by</p>
          <DependencyPicker
            value={blockedBy}
            onSave={async (ids) => {
              await updateMutation.mutateAsync({
                id: project.id,
                data: { blockedByIds: ids },
              });
            }}
            SearchProvider={WithProjectSearch}
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
            <p className="eyebrow my-0">Blocks</p>
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
  // come from the separate `imagesByProjectIds` query and already ride the
  // hero), so it would render an always-empty Images card).

  const sections: DetailSection[] = [
    ...(hasNotesContent ? [notesSection] : []),
    ...(showBudget ? [budgetSection] : []),
    contributionSection,
    tasksSection,
    reusableResourcesSection,
    ...(hasSubtree ? [] : [expensesSection]),
    ...(hasSubtree ? [] : [purchasesSection]),
    ...(hasSubtree ? [] : [purchasedProductsSection]),
    overviewSection,
    resourcesSection,
    dependenciesSection,
    subProjectsSection,
    vendorsSection,
    ...(hasNotesContent ? [] : [notesSection]),
    ...(hasSubtree ? [expensesSection] : []),
    ...(hasSubtree ? [purchasesSection] : []),
    ...(hasSubtree ? [purchasedProductsSection] : []),
  ];

  const heroStats: DetailHeroStat[] = [
    ...(project.parentProjectId &&
    project.parentProjectName &&
    project.parentProjectId
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
    { label: "Actual", value: formatCurrency(ownSpendSplit.actual, 0) },
    ...(ownSpendSplit.committed > 0
      ? [
          {
            label: "Committed",
            value: formatCurrency(ownSpendSplit.committed, 0),
          } satisfies DetailHeroStat,
        ]
      : []),
    // Own Tasks/Expenses only when this is a leaf — a subtree project shows
    // the fuller "(incl. sub-projects)" versions below instead, keeping the
    // spec-plate to ~6 stats so the mono values aren't truncated.
    ...(hasSubtree
      ? []
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
      : []),
    ...(hasSubtree && project.rollup.subtree.costEstimate !== null
      ? [
          {
            label: "Estimate (incl. sub-projects)",
            value: formatCurrency(project.rollup.subtree.costEstimate, 0),
          } satisfies DetailHeroStat,
        ]
      : []),
  ];

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
      heroActions={{ secondary: deleteButton }}
    >
      <DetailSections
        sections={sections}
        rawData={project}
        heroImages={images}
      />
      {deleteDialog}

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
        <Stack className="pt-4">
          {/* One boundary for the whole band — the charts load as a group, and
              a single skeleton reads better than five staggered ones. */}
          <Suspense fallback={<Skeleton className="h-[400px] w-full" />}>
            {chartExpenses.length > 0 && (
              <>
                <Section
                  title="Spending Over Time"
                  description={
                    hasSubtree
                      ? "Cumulative spend against the estimate · includes sub-project expenses"
                      : "Cumulative spend against the estimate"
                  }
                >
                  <SpendingOverTime
                    expenses={chartExpenses}
                    costEstimate={project.rollup.subtree.costEstimate}
                  />
                </Section>

                <CategoryBreakdown
                  expenses={chartExpenses}
                  donutHeight={350}
                  onMatrixCellClick={handleMatrixCellClick}
                  activeMatrixCell={activeMatrixCell}
                />

                {/* With zero future-flagged expenses this just restates the
                  pivot's column totals — only worth its own section when
                  something is actually planned. */}
                {chartExpenses.some((p) => p.future) && (
                  <Section
                    title="Planned vs Actual"
                    description="Committed spend vs future-flagged expenses"
                  >
                    <PlannedVsActual expenses={chartExpenses} />
                  </Section>
                )}
              </>
            )}

            {/* Gated on dated content existing at all: a project with no tasks
              and no sub-projects has nothing to plot. */}
            {(subtreeTasks.length > 0 || ganttSubtreeProjects.length > 0) && (
              <Section
                title="Gantt"
                description={
                  ganttSubtreeProjects.length > 0
                    ? "Tasks and sub-projects across the whole subtree"
                    : undefined
                }
              >
                <ProjectGantt
                  projectId={project.id}
                  tasks={subtreeTasks}
                  subtreeProjects={ganttSubtreeProjects}
                />
              </Section>
            )}

            {topLevelTasks.length > 0 && (
              <Section title="Task Timeline">
                <TaskHeatmap tasks={topLevelTasks} />
              </Section>
            )}
          </Suspense>
        </Stack>
      )}
    </Page>
  );
}
