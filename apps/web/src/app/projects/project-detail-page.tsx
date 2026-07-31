import type {
  ExpenseOut,
  ProjectKind,
  ProjectOut,
  ProjectStatus,
  TaskOut,
  Trade,
} from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  FileText,
  FolderTree,
  Info,
  Link2,
  ListChecks,
  Pencil,
  Plus,
  ShoppingCart,
  Wallet,
} from "lucide-react";
import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AuditLogList } from "~/app/_components/audit-log/audit-log-list";
import { WithProjectSearch } from "~/app/_components/combobox/with-search-hook";
import { DependencyPicker } from "~/app/_components/data-table/dependency-picker";
import {
  type DetailSection,
  DetailSections,
} from "~/app/_components/data-table/detail-page";
import { EditableCell } from "~/app/_components/data-table/editable-cell";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { ChipsInput } from "~/app/_components/forms/chips-input";
import { useEntityDelete } from "~/app/_components/hooks/useEntityDelete";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { CreateExpenseDialog } from "~/app/expenses/create-expense-dialog";
import { TaskBoard } from "~/app/tasks/board/TaskBoard";
import { CreateTaskDialog } from "~/app/tasks/create-task-dialog";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { Row, Section, Stack } from "~/components/layout";
import type { DetailHeroStat } from "~/components/layouts/page-hero";
import { Page } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { NoneValue } from "~/components/ui/none-value";
import { Skeleton } from "~/components/ui/skeleton";
import { Textarea } from "~/components/ui/textarea";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import { projectMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import { BudgetStrip } from "./BudgetStrip";
import type { TradeCostCell } from "./charts/trade-cost-matrix";
import type { PivotCostKey } from "./charts/trade-cost-pivot";
import { CreateProjectDialog } from "./create-project-dialog";
import { ProjectNotes } from "./project-notes";
import { projectKindOptions } from "./project-options";
import {
  projectGanttSubtreeQueryParams,
  projectSubtreeExpensesFilters,
  projectSubtreeTasksFilters,
} from "./project-query-params";
import {
  capitalize,
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

/** List/Board toggle for the project-detail Tasks section (local, no URL params). */
const TASKS_VIEW_OPTIONS: ViewSwitcherOption<"list" | "board">[] = [
  { value: "list", label: "List" },
  { value: "board", label: "Board" },
];
const NO_EXPENSES: ExpenseOut[] = [];
const NO_CHILD_PROJECTS: ProjectOut[] = [];

/** Cap for the Tasks section's scoped open/history `task.list` queries —
 * generous relative to any real project's task count, within the shared
 * `MAX_PAGE_SIZE`. */
const TASKS_SECTION_PAGE_SIZE = 500;

/** Cap for the Expenses section's scoped planned/history `expense.list`
 * queries — same rationale as `TASKS_SECTION_PAGE_SIZE`. */
const EXPENSES_SECTION_PAGE_SIZE = 500;

/** The default "recent actual expenses" page is deliberately small — it's a
 * glance, not the ledger (History expands to the full expense list). */
const RECENT_EXPENSES_PAGE_SIZE = 15;

interface ProjectDetailPageProps {
  project: ProjectOut;
}

/**
 * A blocked-by/blocking dependency link, name-only — `project.options` (used
 * to resolve these) is the lightweight `{id,name}` projection, so this can't
 * carry `ProjectPill`'s status icon/tooltip (those need a full `ProjectOut`).
 */
function DependencyBadge({
  id,
  name,
  shortcode,
}: {
  id: string;
  name: string;
  shortcode: string;
}) {
  return (
    <EntityInlineLink entity="project" data={{ id, name, shortcode }} compact />
  );
}

/**
 * Read mode: location badges + an Edit pencil. Edit mode: the generic
 * `ChipsInput` + Save/Cancel. No suggestions — this page only has the current
 * project's own data loaded, so a corpus of "locations used elsewhere" isn't
 * cheaply available here (see the dashboard's `ProjectTable`/filters, which
 * DO have the full project list, for that kind of aggregate).
 */
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
            <Badge
              key={loc}
              variant="outline"
              // Free-form location names — opt out of the mono-uppercase stamp.
              className="font-sans normal-case tracking-normal"
            >
              {loc}
            </Badge>
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
 * prevent. A "derived" effective value renders muted; when the override is
 * explicit AND disagrees with what the content would otherwise derive to, the
 * derived bound is surfaced underneath as secondary text so the divergence
 * (a `date_window_drift` attention candidate) stays visible instead of
 * silently shadowed.
 */
function ProjectDateField({
  rawOverride,
  effective,
  derived,
  source,
  onSave,
}: {
  rawOverride: string | null;
  effective: string | null;
  derived: string | null;
  source: "explicit" | "derived" | "none";
  onSave: (value: string | null) => Promise<void>;
}) {
  const drifted =
    source === "explicit" && derived != null && derived !== effective;

  return (
    <Stack gap="tight">
      <EditableCell
        value={rawOverride}
        config={{ type: "date" }}
        onSave={onSave}
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
      {drifted && (
        <span className="text-2xs text-muted-foreground">
          derived: {derived}
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

/**
 * Direct children (arbitrary-depth sub-projects, but this section only lists
 * one level down — a child's own children show on ITS detail page) — name
 * link, status badge, own spent vs costEstimate. Always rendered (even with
 * zero children) so the "New sub-project" button stays discoverable.
 */
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
            // Subtree-aware, matching the projects table + hero: a child with
            // its own descendants shows its whole subtree; `actualSpent` (money
            // out, excluding planned + contributions) mirrors the hero's
            // "Actual" so a sub-project's number never means something the
            // parent's doesn't.
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
                    entity="project"
                    data={{
                      id: child.id,
                      shortcode: child.shortcode,
                      name: child.name,
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
  // Whether this project owns descendant sub-projects — gates the board's
  // per-card project link (otherwise every card is the same project).
  const hasSubtree = project.rollup.subtree.projectCount > 0;
  const [tasksView, setTasksView] = useState<"list" | "board">("list");

  // Tasks section (List view): scoped to open (non-done) tasks only — a
  // completed project can carry hundreds of historical tasks, and those
  // shouldn't be fetched/rendered on initial load just to show the active
  // work. Separate from `subtreeTasks` above (Board view keeps using that
  // one — its optimistic drag/drop patches the `task.chartData` cache keyed
  // on those exact filters, so it can't be pointed at a different query).
  const openTaskFilters = useMemo(
    () => ({
      projectId: project.id,
      includeSubProjects: true,
      completion: "open" as const,
    }),
    [project.id],
  );
  const { data: openTasksPage } = useQuery(
    api.task.list.queryOptions({
      filters: openTaskFilters,
      pagination: { pageIndex: 0, pageSize: TASKS_SECTION_PAGE_SIZE },
    }),
  );
  const openTasks = openTasksPage?.items ?? NO_TASKS;
  const topLevelOpenTasks = useMemo(
    () => openTasks.filter((t) => t.parentTaskId == null),
    [openTasks],
  );

  // History: completed tasks, fetched only once the disclosure below is
  // opened — `enabled` keeps this off the initial page load entirely.
  const [isTaskHistoryOpen, setIsTaskHistoryOpen] = useState(false);
  const doneTaskFilters = useMemo(
    () => ({
      projectId: project.id,
      includeSubProjects: true,
      completion: "done" as const,
    }),
    [project.id],
  );
  const { data: doneTasksPage } = useQuery({
    ...api.task.list.queryOptions({
      filters: doneTaskFilters,
      pagination: { pageIndex: 0, pageSize: TASKS_SECTION_PAGE_SIZE },
    }),
    enabled: isTaskHistoryOpen,
  });
  const doneTasks = doneTasksPage?.items ?? NO_TASKS;
  const topLevelDoneTasks = useMemo(
    () => doneTasks.filter((t) => t.parentTaskId == null),
    [doneTasks],
  );

  // Full subtree expense history — feeds the Budget card + the spend charts
  // below, both of which need the complete picture. The Expenses section's
  // *list* view intentionally does NOT read from this (see the scoped
  // planned/recent/history queries further down) — a completed project's
  // full expense ledger shouldn't be fetched/rendered just to show the
  // section's default (planned + recent) view.
  const { data: chartExpenses = NO_EXPENSES } = useQuery(
    api.expense.chartData.queryOptions(
      projectSubtreeExpensesFilters(project.id),
    ),
  );

  // Expenses section (default view): planned expenses + a small recency-
  // capped page of already-made ones, rather than the full ledger above.
  const plannedExpenseFilters = useMemo(
    () => ({
      projectId: project.id,
      includeSubProjects: true,
      future: true,
    }),
    [project.id],
  );
  const { data: plannedExpensesPage } = useQuery(
    api.expense.list.queryOptions({
      filters: plannedExpenseFilters,
      pagination: { pageIndex: 0, pageSize: EXPENSES_SECTION_PAGE_SIZE },
    }),
  );
  const plannedExpenses = plannedExpensesPage?.items ?? NO_EXPENSES;

  const recentActualExpenseFilters = useMemo(
    () => ({
      projectId: project.id,
      includeSubProjects: true,
      future: false,
    }),
    [project.id],
  );
  // `expense.list`'s default sort (date desc, nulls last) is exactly what's
  // wanted here, so no explicit `sort` is passed.
  const { data: recentActualExpensesPage } = useQuery(
    api.expense.list.queryOptions({
      filters: recentActualExpenseFilters,
      pagination: { pageIndex: 0, pageSize: RECENT_EXPENSES_PAGE_SIZE },
    }),
  );
  const recentActualExpenses = recentActualExpensesPage?.items ?? NO_EXPENSES;

  // Merge the two bounded pages for display — each page is independently
  // sorted, so the combined list needs its own newest-first, nulls-last pass.
  const defaultSectionExpenses = useMemo(
    () =>
      [...plannedExpenses, ...recentActualExpenses].sort((a, b) => {
        if (!a.date && !b.date) return 0;
        if (!a.date) return 1;
        if (!b.date) return -1;
        return b.date.localeCompare(a.date);
      }),
    [plannedExpenses, recentActualExpenses],
  );

  // History: the full expense ledger, fetched only once the disclosure
  // below is opened — `enabled` keeps this off the initial page load.
  const [isExpenseHistoryOpen, setIsExpenseHistoryOpen] = useState(false);
  const { data: expenseHistoryPage } = useQuery({
    ...api.expense.list.queryOptions({
      filters: projectSubtreeExpensesFilters(project.id),
      pagination: { pageIndex: 0, pageSize: EXPENSES_SECTION_PAGE_SIZE },
    }),
    enabled: isExpenseHistoryOpen,
  });
  const expenseHistory = expenseHistoryPage?.items ?? NO_EXPENSES;

  // Decompose spend into actual / committed / contributions rather than showing
  // one blended figure. Own-scope split feeds the hero; the whole-subtree split
  // + subtree estimate feed the Budget card's reconciliation (own == subtree for
  // a leaf project, so both collapse there).
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

  // Live direct children — full ProjectOut (own rollup/status/costEstimate)
  // so the Sub-projects section can render a status badge + spend-vs-estimate
  // line per row without a second fetch.
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

  // The Gantt's sub-project rows need the whole descendant project subtree
  // (separate from the direct-children query the Sub-projects section uses).
  const { data: ganttSubtreePage } = useQuery(
    api.project.list.queryOptions(projectGanttSubtreeQueryParams(project.id)),
  );
  const ganttSubtreeProjects = ganttSubtreePage?.items ?? NO_CHILD_PROJECTS;

  const updateMutation = useUpdateMutation({
    mutationFn: api.project.update.mutationOptions,
    entity: "project",
    invalidateKeys: projectMutationInvalidateKeys,
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
      api.project.delete.mutationOptions(callbacks),
    invalidateKeys: projectMutationInvalidateKeys,
    redirectTo: "/projects",
  });

  // Lightweight {id,name} projection (no rollups/dependency joins) — enough
  // to resolve blockedByIds/blockingIds into linked badges, and to populate
  // the "Parent project" picker. A project with a dangling reference to a
  // deleted project (excluded from `options`) just drops out of the list,
  // same as the old full-ProjectOut lookup did.
  const { data: projectOptions } = useQuery(api.project.options.queryOptions());
  const projectNamesById = useMemo(() => {
    const map = new Map<string, { name: string; shortcode: string }>();
    for (const p of projectOptions ?? [])
      map.set(p.id, { name: p.name, shortcode: p.shortcode });
    return map;
  }, [projectOptions]);
  const resolveDependencyNames = (ids: ProjectOut["blockedByIds"]) =>
    ids
      .map((id) => {
        const found = projectNamesById.get(id);
        return found
          ? { id, name: found.name, shortcode: found.shortcode }
          : null;
      })
      .filter((p): p is NonNullable<typeof p> => p != null);
  const blockedBy = resolveDependencyNames(project.blockedByIds);
  const blocking = resolveDependencyNames(project.blockingIds);

  // Excludes itself — a project can't be its own parent (the server also
  // rejects self-parent/cycles, this just keeps the picker sane).
  const parentProjectOptions = useMemo(
    () =>
      (projectOptions ?? [])
        .filter((p) => p.id !== project.id)
        .map((p) => ({ value: p.id, label: p.name })),
    [projectOptions, project.id],
  );

  // Notes: house pattern is textarea-in → MarkdownText-out, toggled via the
  // section's headerAction — no rich markdown editor.
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

  // Trade × Cost Type pivot → Expenses table filter + scroll-into-view.
  // Clicking the same cell again clears the filter.
  const [activeMatrixCell, setActiveMatrixCell] =
    useState<TradeCostCell | null>(null);
  const expensesRef = useRef<HTMLDivElement>(null);

  const handleMatrixCellClick = (
    trade: Trade,
    costType: PivotCostKey | null,
  ) => {
    setActiveMatrixCell((current) => {
      const clear = current?.trade === trade && current.costType === costType;
      // The pivot is built from the full subtree ledger (`chartExpenses`) —
      // a matched expense may not be in the section's default bounded view,
      // so expand History to the full list rather than filtering to nothing.
      if (!clear) setIsExpenseHistoryOpen(true);
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
          renderValue={(v) => (v ? capitalize(v) : <NoneValue />)}
        />
      ),
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
      // Subtree-aware to match the hero: a parent shows its whole subtree's
      // task progress, a leaf its own (own == subtree for a leaf).
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
            v && project.parentProjectName && project.parentProjectShortcode ? (
              <EntityInlineLink
                entity="project"
                data={{
                  id: v,
                  name: project.parentProjectName,
                  shortcode: project.parentProjectShortcode,
                }}
                compact
              />
            ) : (
              <NoneValue />
            )
          }
        />
      ),
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
      value: project.updatedAt.toISOString().slice(0, 10),
    },
  ];

  // Notes lead the main column when they have content (or are being edited);
  // otherwise they collapse to a slim aside card whose "No notes yet." body +
  // Edit action keep the section discoverable without eating the wide column.
  const hasNotesContent = isEditingNotes || !!project.notes?.trim();
  const notesSection: DetailSection = {
    title: "Notes",
    icon: FileText,
    zone: hasNotesContent ? "main" : "aside",
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
    title: "Budget",
    icon: Wallet,
    zone: "main",
    content: (
      <BudgetStrip estimate={budgetEstimate} split={subtreeSpendSplit} />
    ),
  };

  // Board view keeps showing the full (incl. done) subtree — see the
  // `subtreeTasks` comment above; List view is the scoped open-tasks set.
  const visibleTaskCount =
    tasksView === "board" ? topLevelTasks.length : topLevelOpenTasks.length;

  const tasksSection: DetailSection = {
    title: "Tasks",
    icon: ListChecks,
    // The board needs the full width; the list is happy in the main column.
    zone: tasksView === "board" ? "full" : "main",
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
          // A card section on the detail page, not the whole viewport — a
          // shorter fixed bound than the standalone board page's default.
          maxHeightClassName="max-h-[70vh]"
        />
      ) : (
        <Stack gap="sm">
          <TaskList tasks={topLevelOpenTasks} showProjectColumn={hasSubtree} />
          <Collapsible
            open={isTaskHistoryOpen}
            onOpenChange={setIsTaskHistoryOpen}
          >
            <CollapsibleTrigger className="flex items-center gap-1 text-muted-foreground text-xs transition-colors hover:text-foreground">
              {isTaskHistoryOpen ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )}
              History
              {isTaskHistoryOpen &&
                topLevelDoneTasks.length > 0 &&
                ` (${topLevelDoneTasks.length})`}
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
              <TaskList
                tasks={topLevelDoneTasks}
                showProjectColumn={hasSubtree}
              />
            </CollapsibleContent>
          </Collapsible>
        </Stack>
      ),
  };

  const overviewSection: DetailSection = {
    title: "Overview",
    icon: Info,
    content: <BasicInfo fields={fields} />,
  };

  const resourcesSection: DetailSection = {
    title: "Resources",
    icon: ExternalLink,
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
    title: "Dependencies",
    icon: Link2,
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
              // DependencyPicker's chip type is the generic {id,name} —
              // resolve the public id from the same options map `blockedBy`
              // was built from rather than widening that shared component.
              const shortcode = projectNamesById.get(item.id)?.shortcode;
              return shortcode ? (
                <DependencyBadge
                  id={item.id}
                  name={item.name}
                  shortcode={shortcode}
                />
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
    title: "Sub-projects",
    icon: FolderTree,
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
    title: "Expenses",
    icon: ShoppingCart,
    zone: hasSubtree ? "full" : "main",
    headerAction: (
      <Row align="center" gap="sm">
        {defaultSectionExpenses.length > 0 && (
          <Badge variant="outline">{defaultSectionExpenses.length}</Badge>
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
        <Stack gap="sm">
          <ExpenseList
            expenses={defaultSectionExpenses}
            tradeFilter={activeMatrixCell?.trade ?? null}
            costTypeFilter={activeMatrixCell?.costType ?? null}
            showProjectColumn={hasSubtree}
          />
          <Collapsible
            open={isExpenseHistoryOpen}
            onOpenChange={setIsExpenseHistoryOpen}
          >
            <CollapsibleTrigger className="flex items-center gap-1 text-muted-foreground text-xs transition-colors hover:text-foreground">
              {isExpenseHistoryOpen ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )}
              History
              {isExpenseHistoryOpen &&
                expenseHistory.length > 0 &&
                ` (${expenseHistory.length})`}
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
              <ExpenseList
                expenses={expenseHistory}
                tradeFilter={activeMatrixCell?.trade ?? null}
                costTypeFilter={activeMatrixCell?.costType ?? null}
                showProjectColumn={hasSubtree}
              />
            </CollapsibleContent>
          </Collapsible>
        </Stack>
      </div>
    ),
  };

  // The manifest's `history` common section, rendered inline rather than via
  // `useEntityDetail` (task-detail/expense-detail's route): project also
  // declares `images`, and that common section reads `data.images` — which
  // ProjectOut doesn't carry (images come from the separate
  // `imagesByProjectIds` query and already ride the hero), so it would render
  // an always-empty Images card. Same content the helper produces.
  const historySection: DetailSection = {
    title: "History",
    icon: Clock,
    content: (
      <AuditLogList
        entityType="project"
        entityId={project.id}
        showEntityLink={false}
      />
    ),
  };

  const sections: DetailSection[] = [
    // Main column: Notes (when populated), Budget, Tasks, then — for a leaf —
    // the expense ledger.
    ...(hasNotesContent ? [notesSection] : []),
    ...(showBudget ? [budgetSection] : []),
    tasksSection,
    ...(hasSubtree ? [] : [expensesSection]),
    // Aside rail: metadata + (when empty) the slim Notes card.
    overviewSection,
    resourcesSection,
    dependenciesSection,
    subProjectsSection,
    ...(hasNotesContent ? [] : [notesSection]),
    // Subtree projects show the ledger as a full-width band at the bottom.
    ...(hasSubtree ? [expensesSection] : []),
    // Paper trail last, same position task/expense detail give it.
    historySection,
  ];

  const heroStats: DetailHeroStat[] = [
    // A sub-project surfaces its parent right in the spec-plate header, same
    // treatment as the task subtask breadcrumb.
    ...(project.parentProjectId &&
    project.parentProjectName &&
    project.parentProjectShortcode
      ? [
          {
            label: "Sub-project of",
            value: (
              <EntityInlineLink
                entity="project"
                data={{
                  id: project.parentProjectId,
                  name: project.parentProjectName,
                  shortcode: project.parentProjectShortcode,
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
    // Null when nothing in the subtree is estimated — skip the stat rather
    // than showing $0.
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
        <>
          {project.icon && `${project.icon} `}
          {project.name}
        </>
      }
      rawData={project}
      heroImages={images}
      heroStamp={{
        label: PROJECT_STATUS_LABELS[project.status],
        tone: project.status === "done" ? "green" : "ink",
      }}
      heroStats={heroStats}
      actions={deleteButton}
    >
      <DetailSections
        sections={sections}
        rawData={project}
        heroImages={images}
      />
      {deleteDialog}

      <CreateProjectDialog
        open={isCreatingSubProject}
        onOpenChange={setIsCreatingSubProject}
        defaultParentProjectId={project.id}
      />

      <CreateTaskDialog
        open={isCreatingTask}
        onOpenChange={setIsCreatingTask}
        presetProjectId={project.id}
      />

      <CreateExpenseDialog
        open={isCreatingExpense}
        onOpenChange={setIsCreatingExpense}
        presetProjectId={project.id}
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
