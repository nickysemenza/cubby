import {
  projectShortcode,
  type ProjectShortcode,
} from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useMemo } from "react";

import { RecordEmoji } from "~/entity/components/record-emoji";
import { project } from "~/integrations/tanstack-query/generated/catalog.gen";
import { householdLocalDate } from "~/lib/household-date";
import { effectiveTaskDueDate } from "~/lib/task-dates";
import { Picker } from "~/ui/combobox/picker";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { useEntityOptions } from "~/ui/hooks/use-entity-options";
import { Row, Stack } from "~/ui/layout";

import type {
  GraphData,
  GraphFilters,
} from "../../ui/visualizations/dependency-graph-model";
import { DependencyGraphViewer } from "../../ui/visualizations/dependency-graph-viewer";
import { EntityGraphControls } from "./entity-graph-controls";

export function WorkDependencyGraph({
  projectId,
  onScopeChange,
  filters,
  onChange,
  search,
  onSearch,
}: {
  projectId?: ProjectShortcode;
  onScopeChange: (id: ProjectShortcode | undefined) => void;
  filters: GraphFilters;
  onChange: (patch: Partial<GraphFilters>) => void;
  search: string;
  onSearch: (value: string) => void;
}) {
  const router = useRouter();
  const { data, isLoading, isError, error, refetch } = useQuery(
    project.getDependencyGraph.queryOptions({ projectId }),
  );
  const { items: projects } = useEntityOptions("project");
  const projectOptions = useMemo(
    (): PickerOption[] => [
      { value: "", label: "All projects and tasks" },
      ...projects.map((item) => ({
        value: item.id,
        label: item.label,
        ...(item.detail && { detail: item.detail }),
        ...(item.emoji && {
          icon: <RecordEmoji entity="project" emoji={item.emoji} />,
        }),
      })),
    ],
    [projects],
  );
  const today = householdLocalDate();
  const graph = useMemo<GraphData>(
    () => ({
      nodes:
        data?.nodes.map((node) => {
          const due = effectiveTaskDueDate(node);
          return {
            id: node.id,
            kind: node.kind,
            name: node.name,
            metadata: [
              node.status.replaceAll("_", " "),
              ...(due ? [`Due ${due}`] : []),
            ],
            parentId: node.parentId,
            locations: node.locations,
            completed: node.status === "done",
            overdue: node.status !== "done" && due !== null && due < today,
            external: node.external,
            href: router.buildLocation({
              to:
                node.kind === "project"
                  ? "/projects/$shortcode"
                  : "/tasks/$shortcode",
              params: { shortcode: node.id },
            }).href,
          };
        }) ?? [],
      edges: data?.edges ?? [],
    }),
    [data, today, router],
  );
  return (
    <Stack gap="md">
      <Row align="center" gap="sm">
        <span>Project</span>
        <Picker
          compact
          label="Project"
          className="w-64 max-w-full min-w-0"
          options={projectOptions}
          value={projectId ?? ""}
          onValueChange={(value) =>
            onScopeChange(value ? projectShortcode.parse(value) : undefined)
          }
        />
      </Row>
      {isLoading ? (
        <output>Loading work graph…</output>
      ) : isError ? (
        <ErrorDisplay
          error={error}
          title="work relationships"
          onRetry={() => void refetch()}
        />
      ) : (
        <>
          <EntityGraphControls
            search={search}
            onSearch={onSearch}
            data={graph}
            filters={filters}
            onChange={onChange}
            recipes={false}
          />
          <DependencyGraphViewer data={graph} filters={filters} />
        </>
      )}
    </Stack>
  );
}
