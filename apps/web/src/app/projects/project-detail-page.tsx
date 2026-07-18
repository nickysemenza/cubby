import type {
  ProjectKind,
  ProjectOut,
  ProjectStatus,
  PurchaseOut,
  TaskOut,
} from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  FileText,
  ImageIcon,
  Info,
  Link2,
  ListChecks,
  Pencil,
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
import { ChipsInput } from "~/app/_components/forms/chips-input";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { Grid, Row, Section, Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { NoneValue } from "~/components/ui/none-value";
import { Textarea } from "~/components/ui/textarea";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import { projectMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import { CategoryTreemap } from "./charts/category-treemap";
import { CategoryTrend } from "./charts/category-trend";
import { PurchaseDonut } from "./charts/purchase-donut";
import { SpendingOverTime } from "./charts/spending-over-time";
import { SubcategoryBars } from "./charts/subcategory-bars";
import { TaskHeatmap } from "./charts/task-heatmap";
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

/** Cap well above any real per-project row count (dozens at most) but within
 * the shared `MAX_PAGE_SIZE` — one page covers every task/purchase for a
 * single project. Exported so the route loader can prefetch with the exact
 * same params (identical query key ⇒ cache hit, no duplicate fetch). */
const PROJECT_SCOPED_PAGE_SIZE = 500;

export function projectTasksQueryParams(projectId: string) {
  return {
    filters: { projectId },
    sort: { orderBy: "createdAt" as const, direction: "desc" as const },
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
  return (
    <Link to="/projects/$id" params={{ id }}>
      <Badge variant="outline" className="cursor-pointer hover:bg-muted">
        {name}
      </Badge>
    </Link>
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

  const { data: imageMap } = useQuery({
    ...api.image.imagesByProjectIds.queryOptions({ projectIds: [project.id] }),
    staleTime: 5 * 60 * 1000,
  });
  const images = imageMap?.[project.id] ?? NO_IMAGES;

  const updateMutation = useUpdateMutation({
    mutationFn: api.project.update.mutationOptions,
    entity: "project",
    invalidateKeys: projectMutationInvalidateKeys,
  });

  // Lightweight {id,name} projection (no rollups/dependency joins) — enough
  // to resolve blockedByIds/blockingIds into linked badges. A project with a
  // dangling reference to a deleted project (excluded from `options`) just
  // drops out of the list, same as the old full-ProjectOut lookup did.
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

  const heroStats: DetailHeroStat[] = [
    { label: "Spent", value: formatCurrency(project.rollup.spent, 0) },
    {
      label: "Tasks",
      value: `${project.rollup.doneTaskCount}/${project.rollup.taskCount}`,
    },
    { label: "Purchases", value: project.rollup.purchaseCount },
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

      {/* Spending/task charts scoped to this project — full-bleed, below the
          card grid (same treatment as the /projects list page's own chart
          panels). Purchases-dependent charts and the task timeline are gated
          independently — a project with tasks but no purchases (or vice
          versa) must still see its own section. */}
      {(projectPurchases.length > 0 || projectTasks.length > 0) && (
        <Stack className="pt-4">
          {projectPurchases.length > 0 && (
            <>
              <Section title="Spending Over Time">
                <SpendingOverTime
                  purchases={projectPurchases}
                  costEstimate={project.costEstimate}
                />
              </Section>

              <Grid cols="pair">
                <Section title="Spending by Category">
                  <PurchaseDonut purchases={projectPurchases} />
                </Section>
                <Section title="Spending by Subcategory">
                  <SubcategoryBars purchases={projectPurchases} />
                </Section>
              </Grid>

              <Grid cols="pair">
                <Section title="Category Treemap">
                  <CategoryTreemap purchases={projectPurchases} />
                </Section>
                <Section title="Category Trend">
                  <CategoryTrend purchases={projectPurchases} />
                </Section>
              </Grid>
            </>
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
