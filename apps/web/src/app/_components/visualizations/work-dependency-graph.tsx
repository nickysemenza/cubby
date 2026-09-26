import {
  projectShortcode,
  type ProjectShortcode,
} from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useMemo } from "react";

import { project } from "~/app/projects/project.functions";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Row, Stack } from "~/components/layout";
import { NativeSelect } from "~/components/ui/native-select";
import { householdLocalDate } from "~/lib/household-date";
import { effectiveTaskDueDate } from "~/lib/task-dates";

import type { GraphData, GraphFilters } from "./dependency-graph-model";
import { DependencyGraphViewer } from "./dependency-graph-viewer";
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
  const { data: projects } = useQuery(project.options.queryOptions(undefined));
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
      <Row as="label" align="center" gap="sm">
        <span>Project</span>
        <NativeSelect
          className="max-w-full min-w-0"
          value={projectId ?? ""}
          onChange={(event) =>
            onScopeChange(
              event.target.value
                ? projectShortcode.parse(event.target.value)
                : undefined,
            )
          }
        >
          <option value="">All projects and tasks</option>
          {projects?.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </NativeSelect>
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
