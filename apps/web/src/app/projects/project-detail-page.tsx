import type {
  ProjectOut,
  ProjectStatus,
  PurchaseOut,
  TaskOut,
} from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import {
  FileText,
  ImageIcon,
  Info,
  Link2,
  ListChecks,
  ShoppingCart,
} from "lucide-react";
import { useMemo } from "react";
import {
  type DetailHeroStat,
  type DetailSection,
  DetailSections,
} from "~/app/_components/data-table/detail-page";
import { EditableCell } from "~/app/_components/data-table/editable-cell";
import EntityImageList from "~/app/_components/EntityImageList";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { Grid, Row, Section, Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Badge } from "~/components/ui/badge";
import { NoneValue } from "~/components/ui/none-value";
import { useTRPC } from "~/integrations/trpc/react";
import { projectMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import { CategoryTreemap } from "./charts/category-treemap";
import { CategoryTrend } from "./charts/category-trend";
import { PurchaseDonut } from "./charts/purchase-donut";
import { SpendingOverTime } from "./charts/spending-over-time";
import { SubcategoryBars } from "./charts/subcategory-bars";
import { TaskHeatmap } from "./charts/task-heatmap";
import { ProjectNotes } from "./project-notes";
import { ProjectPill } from "./project-pill";
import {
  capitalize,
  PROJECT_STATUS_LABELS,
  PROJECT_STATUS_OPTIONS,
  PurchaseList,
  StatusIcon,
  TaskList,
} from "./shared";

const NO_IMAGES: Array<{ id: string; url: string; filename: string }> = [];

interface ProjectDetailPageProps {
  project: ProjectOut;
  /** Every project — resolves `blockedByIds`/`blockingIds` to pills. */
  allProjects: ProjectOut[];
  /** All tasks/purchases (dashboard-wide) — filtered to this project below. */
  tasks: TaskOut[];
  purchases: PurchaseOut[];
}

export function ProjectDetailPage({
  project,
  allProjects,
  tasks,
  purchases,
}: ProjectDetailPageProps) {
  const api = useTRPC();

  const projectTasks = useMemo(
    () => tasks.filter((t) => t.projectId === project.id),
    [tasks, project.id],
  );
  const projectPurchases = useMemo(
    () => purchases.filter((p) => p.projectId === project.id),
    [purchases, project.id],
  );

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

  const projectsById = useMemo(
    () => new Map(allProjects.map((p) => [p.id, p])),
    [allProjects],
  );
  const blockedBy = project.blockedByIds
    .map((id) => projectsById.get(id))
    .filter((p): p is ProjectOut => p != null);
  const blocking = project.blockingIds
    .map((id) => projectsById.get(id))
    .filter((p): p is ProjectOut => p != null);

  const fields: BasicInfoField[] = [
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
      value: project.kind ? capitalize(project.kind) : undefined,
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
      value:
        project.locations.length > 0 ? (
          <Row wrap gap="xs" justify="end">
            {project.locations.map((loc) => (
              <Badge key={loc} variant="outline">
                {loc}
              </Badge>
            ))}
          </Row>
        ) : undefined,
    },
  ];

  const sections: DetailSection[] = [
    {
      title: "Overview",
      icon: Info,
      content: <BasicInfo fields={fields} />,
    },
    ...(blockedBy.length > 0 || blocking.length > 0
      ? [
          {
            title: "Dependencies",
            icon: Link2,
            content: (
              <Stack gap="sm">
                {blockedBy.length > 0 && (
                  <Stack gap="xs">
                    <p className="eyebrow my-0">Blocked by</p>
                    <Row wrap gap="sm">
                      {blockedBy.map((p) => (
                        <ProjectPill key={p.id} project={p} />
                      ))}
                    </Row>
                  </Stack>
                )}
                {blocking.length > 0 && (
                  <Stack gap="xs">
                    <p className="eyebrow my-0">Blocks</p>
                    <Row wrap gap="sm">
                      {blocking.map((p) => (
                        <ProjectPill key={p.id} project={p} />
                      ))}
                    </Row>
                  </Stack>
                )}
              </Stack>
            ),
          },
        ]
      : []),
    {
      title: "Images",
      icon: ImageIcon,
      content: <EntityImageList images={images} />,
    },
    {
      title: "Notes",
      icon: FileText,
      zone: "main",
      content: <ProjectNotes notes={project.notes} />,
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
          card grid (same treatment as the dashboard's own chart panels).
          Purchases-dependent charts and the task timeline are gated
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
