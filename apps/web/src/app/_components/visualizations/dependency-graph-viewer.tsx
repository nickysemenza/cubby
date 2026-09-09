import { useMemo } from "react";

import { Row, Stack } from "~/components/layout";

import { DependencyGraphCanvas } from "./dependency-graph-canvas";
import {
  layoutGraph,
  type GraphData,
  type GraphFilters,
  prepareGraph,
} from "./dependency-graph-model";

import "./dependency-graph.css";

export function DependencyGraphViewer({
  data,
  filters,
}: {
  data: GraphData;
  filters: GraphFilters;
}) {
  const graph = useMemo(() => prepareGraph(data, filters), [data, filters]);
  const layout = useMemo(
    () => layoutGraph(graph, filters.grouped, filters.groupByLocation),
    [graph, filters.grouped, filters.groupByLocation],
  );
  return (
    <Stack gap="md">
      <p className="text-sm text-muted-foreground">
        {graph.nodes.length} records · {graph.hiddenNodeCount} hidden by filters
        · {graph.removedEdgeCount} redundant edges hidden
      </p>
      <Row wrap gap="md" className="text-sm" aria-label="Graph legend">
        {graph.nodes.some((node) => node.kind === "project") && (
          <span className="text-chart-4">● Projects</span>
        )}
        {graph.nodes.some((node) => node.kind === "task") && (
          <span className="text-chart-3">● Tasks</span>
        )}
        {graph.nodes.some((node) => node.kind === "recipe") && (
          <span className="text-chart-5">● Recipes</span>
        )}
        <span className="text-muted-foreground">
          Dashed border: completed or outside scope
        </span>
        <span className="text-destructive">Red border: overdue or cycle</span>
      </Row>
      {graph.cycleIds.length > 0 && (
        <output className="text-sm text-destructive">
          Dependency cycle detected. Cycle records are marked in the graph and
          list.
        </output>
      )}
      {graph.nodes.length === 0 ? (
        <p>No records match these graph filters.</p>
      ) : (
        <DependencyGraphCanvas
          dot={layout.dot}
          hierarchyEdges={layout.hierarchyEdges}
          focus={filters.focus}
        />
      )}
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          Record and relationship list ({graph.nodes.length})
        </summary>
        <ul className="divide-y text-sm">
          {graph.nodes.map((node) => (
            <li key={node.id} className="py-2">
              <a className="text-primary underline" href={node.href}>
                {node.name}
              </a>{" "}
              <span className="text-muted-foreground">
                {node.id} · {node.metadata.join(" · ")}
                {node.completed ? " · Completed" : ""}
                {node.overdue ? " · Overdue" : ""}
                {node.external ? " · Outside scope" : ""}
                {graph.cycleIds.includes(node.id) ? " · Cycle" : ""}
              </span>
              <ul>
                {graph.edges
                  .filter((edge) => edge.source === node.id)
                  .map((edge) => (
                    <li
                      key={`${edge.kind}-${edge.target}`}
                      className="text-muted-foreground"
                    >
                      {edge.kind === "hierarchy"
                        ? "Contains"
                        : (edge.label ?? "Blocks")}
                      :{" "}
                      {graph.nodes.find((target) => target.id === edge.target)
                        ?.name ?? edge.target}
                    </li>
                  ))}
              </ul>
            </li>
          ))}
        </ul>
      </details>
    </Stack>
  );
}
