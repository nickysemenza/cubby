import type {
  ProjectKind,
  ProjectOut,
  ProjectStatus,
  PurchaseOut,
  TaskOut,
} from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import {
  FileText,
  FolderTree,
  ImageIcon,
  Info,
  Link2,
  ListChecks,
  Pencil,
  Plus,
  ShoppingCart,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { WithProjectSearch } from "~/app/_components/combobox/with-search-hook";
import { DependencyPicker } from "~/app/_components/data-table/dependency-picker";
import {
  type DetailHeroStat,
  type DetailSection,
  DetailSections,
} from "~/app/_components/data-table/detail-page";
import { EditableCell } from "~/app/_components/data-table/editable-cell";
import EntityImageList from "~/app/_components/EntityImageList";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { ChipsInput } from "~/app/_components/forms/chips-input";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { Grid, Row, Section, Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { NoneValue } from "~/components/ui/none-value";
import { Textarea } from "~/components/ui/textarea";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import { projectMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import { CategoryBreakdown } from "./charts/category-breakdown";
import { CategoryTreemap } from "./charts/category-treemap";
import { CategoryTrend } from "./charts/category-trend";
import { CostBurnup } from "./charts/cost-burnup";
import { ProjectGantt } from "./charts/gantt/ProjectGantt";
import { PlannedVsActual } from "./charts/planned-vs-actual";
import { SpendingOverTime } from "./charts/spending-over-time";
import { TaskHeatmap } from "./charts/task-heatmap";
import { CreateProjectDialog } from "./create-project-dialog";
import { ProjectNotes } from "./project-notes";
import { projectKindOptions } from "./project-options";
import {
  capitalize,
  PROJECT_STATUS_LABELS,
  PROJECT_STATUS_OPTIONS,
  PurchaseList,
  StatusIcon,
  TaskList,
} from "./shared";

const NO_IMAGES: Array<{ id: string; url: string; filename: string }> = [];
const NO_TASKS: TaskOut[] = [];
const NO_PURCHASES: PurchaseOut[] = [];
const NO_CHILD_PROJECTS: ProjectOut[] = [];

/** Cap well above any real per-project row count (dozens at most) but within
 * the shared `MAX_PAGE_SIZE` — one page covers every task/purchase for a
 * single project. Exported so the route loader can prefetch with the exact
 * same params (identical query key ⇒ cache hit, no duplicate fetch). */
const PROJECT_SCOPED_PAGE_SIZE = 500;

export function projectTasksQueryParams(projectId: string) {
  return {
    // Checklist subtasks roll up to their parent everywhere (N/M chip);
    // surfacing them here alongside the parent would double-count the work.
    filters: { projectId, topLevelOnly: true },
    sort: { orderBy: "createdAt" as const, direction: "desc" as const },
    pagination: { pageIndex: 0, pageSize: PROJECT_SCOPED_PAGE_SIZE },
  };
}

/** The Gantt wants the whole subtree's work on one grid, so it can't reuse
 * `projectTasksQueryParams`: it drops `topLevelOnly` (dated subtasks render as
 * their parent's indented children) and adds `includeSubProjects` (sub-project
 * tasks are rows under their sub-project's group row). Separate params ⇒
 * separate cache entry, which is the point — the Tasks list stays direct,
 * top-level-only. Exported so the route loader prefetches identically. */
export function projectGanttTasksQueryParams(projectId: string) {
  return {
    filters: { projectId, includeSubProjects: true },
    sort: { orderBy: "createdAt" as const, direction: "desc" as const },
    pagination: { pageIndex: 0, pageSize: PROJECT_SCOPED_PAGE_SIZE },
  };
}

/** The Gantt's sub-project rows span arbitrary depth, so it needs the whole
 * live descendant subtree — not the direct-children query the Sub-projects
 * section relies on. Kept separate for exactly that reason. */
export function projectGanttSubtreeQueryParams(projectId: string) {
  return {
    filters: { parentProjectId: projectId, includeSubProjects: true },
    sort: { orderBy: "name" as const, direction: "asc" as const },
    pagination: { pageIndex: 0, pageSize: PROJECT_SCOPED_PAGE_SIZE },
  };
}

export function projectPurchasesQueryParams(projectId: string) {
  return {
    filters: { projectId },
    sort: { orderBy: "date" as const, direction: "desc" as const },
    pagination: { pageIndex: 0, pageSize: PROJECT_SCOPED_PAGE_SIZE },
  };
}

interface ProjectDetailPageProps {
  project: ProjectOut;
}

/**
 * A blocked-by/blocking dependency link, name-only — `project.options` (used
 * to resolve these) is the lightweight `{id,name}` projection, so this can't
 * carry `ProjectPill`'s status icon/tooltip (those need a full `ProjectOut`).
 */
function DependencyBadge({ id, name }: { id: string; name: string }) {
  return <EntityInlineLink entity="project" data={{ id, name }} compact />;
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
            <Badge key={loc} variant="outline">
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
          <Pencil className="h-3 w-3 text-muted-foreground" />
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
          {projects.map((child) => (
            <Row key={child.id} justify="between" align="center" gap="sm">
              <Row align="center" gap="xs">
                <StatusIcon status={child.status} />
                <EntityInlineLink
                  entity="project"
                  data={{ id: child.id, name: child.name }}
                  compact
                />
                <Badge variant="outline">
                  {PROJECT_STATUS_LABELS[child.status]}
                </Badge>
              </Row>
              <span className="text-muted-foreground text-sm">
                {formatCurrency(child.rollup.spent, 0)}
                {child.costEstimate != null &&
                  ` / ${formatCurrency(child.costEstimate, 0)}`}
              </span>
            </Row>
          ))}
        </Stack>
      )}
      <Row justify="end">
        <Button type="button" variant="outline" size="sm" onClick={onCreate}>
          <Plus className="h-3.5 w-3.5" />
          New sub-project
        </Button>
      </Row>
    </Stack>
  );
}

export function ProjectDetailPage({ project }: ProjectDetailPageProps) {
  const api = useTRPC();

  const { data: tasksPage } = useQuery(
    api.task.list.queryOptions(projectTasksQueryParams(project.id)),
  );
  const projectTasks = tasksPage?.items ?? NO_TASKS;

  const { data: purchasesPage } = useQuery(
    api.purchase.list.queryOptions(projectPurchasesQueryParams(project.id)),
  );
  const projectPurchases = purchasesPage?.items ?? NO_PURCHASES;

  // Charts aggregate the project PLUS its whole sub-project subtree (the
  // Purchases list tab stays direct-only, on `projectPurchases`).
  const { data: chartPurchases = NO_PURCHASES } = useQuery(
    api.purchase.chartData.queryOptions({
      projectId: project.id,
      includeSubProjects: true,
    }),
  );

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

  // Gantt-only fetches: the whole descendant subtree (projects + their tasks),
  // separate from the direct-children/top-level-only queries above.
  const { data: ganttTasksPage } = useQuery(
    api.task.list.queryOptions(projectGanttTasksQueryParams(project.id)),
  );
  const ganttTasks = ganttTasksPage?.items ?? NO_TASKS;

  const { data: ganttSubtreePage } = useQuery(
    api.project.list.queryOptions(projectGanttSubtreeQueryParams(project.id)),
  );
  const ganttSubtreeProjects = ganttSubtreePage?.items ?? NO_CHILD_PROJECTS;

  const updateMutation = useUpdateMutation({
    mutationFn: api.project.update.mutationOptions,
    entity: "project",
    invalidateKeys: projectMutationInvalidateKeys,
  });

  // Lightweight {id,name} projection (no rollups/dependency joins) — enough
  // to resolve blockedByIds/blockingIds into linked badges, and to populate
  // the "Parent project" picker. A project with a dangling reference to a
  // deleted project (excluded from `options`) just drops out of the list,
  // same as the old full-ProjectOut lookup did.
  const { data: projectOptions } = useQuery(api.project.options.queryOptions());
  const projectNamesById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projectOptions ?? []) map.set(p.id, p.name);
    return map;
  }, [projectOptions]);
  const resolveDependencyNames = (ids: ProjectOut["blockedByIds"]) =>
    ids
      .map((id) => {
        const name = projectNamesById.get(id);
        return name ? { id, name } : null;
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
      label: "Start date",
      value: (
        <EditableCell
          value={project.startDate}
          config={{ type: "text", placeholder: "YYYY-MM-DD" }}
          onSave={async (startDate) => {
            await updateMutation.mutateAsync({
              id: project.id,
              data: { startDate },
            });
          }}
          renderValue={(v) => v ?? <NoneValue />}
        />
      ),
    },
    {
      label: "End date",
      value: (
        <EditableCell
          value={project.endDate}
          config={{ type: "text", placeholder: "YYYY-MM-DD" }}
          onSave={async (endDate) => {
            await updateMutation.mutateAsync({
              id: project.id,
              data: { endDate },
            });
          }}
          renderValue={(v) => v ?? <NoneValue />}
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
    { label: "Spent", value: formatCurrency(project.rollup.spent, 0) },
    {
      label: "Progress",
      value:
        project.rollup.taskCount > 0
          ? `${project.rollup.doneTaskCount}/${project.rollup.taskCount} tasks`
          : undefined,
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
            v && project.parentProjectName ? (
              <EntityInlineLink
                entity="project"
                data={{ id: v, name: project.parentProjectName }}
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
  ];

  const sections: DetailSection[] = [
    {
      title: "Overview",
      icon: Info,
      content: <BasicInfo fields={fields} />,
    },
    {
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
              renderReadChip={(item) => <DependencyBadge {...item} />}
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
    },
    {
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
    },
    {
      title: "Images",
      icon: ImageIcon,
      content: <EntityImageList images={images} />,
    },
    {
      title: "Notes",
      icon: FileText,
      zone: "main",
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
          <Pencil className="h-3.5 w-3.5" />
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
    },
    {
      title: "Tasks",
      icon: ListChecks,
      zone: "full",
      content: <TaskList tasks={projectTasks} />,
    },
    {
      title: "Purchases",
      icon: ShoppingCart,
      zone: "full",
      content: <PurchaseList purchases={projectPurchases} />,
    },
  ];

  const hasSubtree = project.rollup.subtree.projectCount > 0;

  const heroStats: DetailHeroStat[] = [
    // A sub-project surfaces its parent right in the spec-plate header, same
    // treatment as the task subtask breadcrumb.
    ...(project.parentProjectId && project.parentProjectName
      ? [
          {
            label: "Sub-project of",
            value: (
              <EntityInlineLink
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
    { label: "Spent", value: formatCurrency(project.rollup.spent, 0) },
    {
      label: "Tasks",
      value: `${project.rollup.doneTaskCount}/${project.rollup.taskCount}`,
    },
    { label: "Purchases", value: project.rollup.purchaseCount },
    // Subtree totals alongside own — only shown once this project actually
    // has descendants (own numbers already tell the whole story otherwise).
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
    >
      <DetailSections
        sections={sections}
        rawData={project}
        heroImages={images}
      />

      <CreateProjectDialog
        open={isCreatingSubProject}
        onOpenChange={setIsCreatingSubProject}
        defaultParentProjectId={project.id}
      />

      {/* Spending/task charts scoped to this project — full-bleed, below the
          card grid (same treatment as the /projects list page's own chart
          panels). Purchases-dependent charts and the task timeline are gated
          independently — a project with tasks but no purchases (or vice
          versa) must still see its own section. */}
      {(chartPurchases.length > 0 ||
        projectTasks.length > 0 ||
        ganttTasks.length > 0 ||
        ganttSubtreeProjects.length > 0) && (
        <Stack className="pt-4">
          {chartPurchases.length > 0 && (
            <>
              <Section
                title="Spending Over Time"
                description={
                  childProjects.length > 0
                    ? "Includes sub-project purchases"
                    : undefined
                }
              >
                <SpendingOverTime
                  purchases={chartPurchases}
                  costEstimate={project.rollup.subtree.costEstimate}
                />
              </Section>

              <CategoryBreakdown purchases={chartPurchases} donutHeight={350} />

              <Grid cols="pair">
                <Section title="Category Treemap">
                  <CategoryTreemap purchases={chartPurchases} />
                </Section>
                <Section title="Category Trend">
                  <CategoryTrend purchases={chartPurchases} />
                </Section>
              </Grid>

              <Section
                title="Planned vs Actual"
                description="Committed spend vs future-flagged purchases"
              >
                <PlannedVsActual purchases={chartPurchases} />
              </Section>
            </>
          )}

          {chartPurchases.length > 0 && (
            <Section
              title="Cost Burnup"
              description="Cumulative spend against the estimate"
            >
              <CostBurnup
                purchases={chartPurchases}
                costEstimate={project.costEstimate}
              />
            </Section>
          )}

          {/* Gated on dated content existing at all: a project with no tasks
              and no sub-projects has nothing to plot. */}
          {(ganttTasks.length > 0 || ganttSubtreeProjects.length > 0) && (
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
                tasks={ganttTasks}
                subtreeProjects={ganttSubtreeProjects}
              />
            </Section>
          )}

          {projectTasks.length > 0 && (
            <Section title="Task Timeline">
              <TaskHeatmap tasks={projectTasks} />
            </Section>
          )}
        </Stack>
      )}
    </Page>
  );
}
