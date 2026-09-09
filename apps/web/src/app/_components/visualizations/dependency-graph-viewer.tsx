import { useMemo } from "react";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";

import { DependencyGraphCanvas } from "./dependency-graph-canvas";
import {
  layoutGraph,
  graphEdgeIdentity,
  neighborhoodGraph,
  type GraphData,
  type GraphFilters,
  type GraphNode,
  type GraphEdge,
  prepareGraph,
} from "./dependency-graph-model";

import "./dependency-graph.css";

export function DependencyGraphViewer({
  data,
  filters,
  onSelectNode,
  neighborhoodRoot,
  onSelectEdge,
  selectedEdgeId,
}: {
  data: GraphData;
  filters: GraphFilters;
  neighborhoodRoot?: string;
  /** Graph interactions can inspect or expand a record without navigating away. */
  onSelectNode?: (node: GraphNode) => void;
  onSelectEdge?: (edge: GraphEdge | undefined) => void;
  selectedEdgeId?: string;
}) {
  const graph = useMemo(() => {
    const prepared = prepareGraph(data, filters);
    return neighborhoodRoot
      ? neighborhoodGraph(prepared, neighborhoodRoot)
      : prepared;
  }, [data, filters, neighborhoodRoot]);
  const images = useMemo(
    () =>
      graph.nodes.flatMap((node) =>
        node.imageUrl ? [{ id: node.id, url: node.imageUrl }] : [],
      ),
    [graph],
  );
  const kinds = useMemo(
    () => [
      ...new Map(
        graph.nodes
          .filter((node): node is GraphNode & { kind: string } =>
            Boolean(node.kind),
          )
          .map((node) => [
            node.kind,
            node.kindLabel ??
              node.kind
                .replaceAll("-", " ")
                .replace(/^./, (value) => value.toUpperCase()),
          ]),
      ).entries(),
    ],
    [graph.nodes],
  );
  const layout = useMemo(
    () =>
      layoutGraph(
        graph,
        filters.grouped,
        filters.groupByLocation,
        neighborhoodRoot,
      ),
    [graph, filters.grouped, filters.groupByLocation, neighborhoodRoot],
  );
  const hasDashedNodeState = graph.nodes.some(
    (node) => node.completed || node.external,
  );
  const hasRedNodeState = graph.nodes.some((node) => node.overdue);
  return (
    <Stack gap="md">
      <p className="text-sm text-muted-foreground">
        {graph.nodes.length} records · {graph.hiddenNodeCount} hidden by filters
        · {graph.removedEdgeCount} redundant edges hidden
      </p>
      <Row wrap gap="md" className="text-sm" aria-label="Graph legend">
        {kinds.map(([kind, label]) => (
          <span
            key={kind}
            className={
              kind === "project"
                ? "text-chart-4"
                : kind === "task"
                  ? "text-chart-3"
                  : kind === "recipe"
                    ? "text-chart-5"
                    : "text-muted-foreground"
            }
          >
            ● {label}
          </span>
        ))}
        {hasDashedNodeState && (
          <span className="text-muted-foreground">
            Dashed border: completed or outside scope
          </span>
        )}
        {(hasRedNodeState || graph.cycleIds.length > 0) && (
          <span className="text-destructive">Red border: overdue or cycle</span>
        )}
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
          componentDots={layout.componentDots}
          images={images}
          edges={graph.edges}
          selectedEdgeId={selectedEdgeId}
          onSelectEdge={(id) =>
            onSelectEdge?.(
              graph.edges.find((edge) => graphEdgeIdentity(edge) === id),
            )
          }
          hierarchyEdges={layout.hierarchyEdges}
          focus={neighborhoodRoot ?? filters.focus}
          onSelectNode={
            onSelectNode == null
              ? undefined
              : (id) => {
                  const node = graph.nodes.find(
                    (candidate) => candidate.id === id,
                  );
                  if (node) onSelectNode(node);
                }
          }
        />
      )}
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          Record and relationship list ({graph.nodes.length})
        </summary>
        <ul className="divide-y text-sm">
          {graph.nodes.map((node) => (
            <li key={node.id} className="py-2">
              {node.href == null ? (
                <span className="font-medium">{node.name}</span>
              ) : (
                <a className="text-primary underline" href={node.href}>
                  {node.name}
                </a>
              )}{" "}
              <span className="text-muted-foreground">
                {node.id}
                {(node.metadata ?? []).length > 0
                  ? ` · ${(node.metadata ?? []).join(" · ")}`
                  : ""}
                {node.completed ? " · Completed" : ""}
                {node.overdue ? " · Overdue" : ""}
                {node.external ? " · Outside scope" : ""}
                {graph.cycleIds.includes(node.id) ? " · Cycle" : ""}
              </span>
              {onSelectNode && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-2"
                  onClick={() => onSelectNode(node)}
                >
                  Explore {node.name}
                </Button>
              )}
              <ul>
                {graph.edges
                  .filter((edge) => edge.source === node.id)
                  .map((edge) => (
                    <li
                      key={`${edge.kind}-${edge.id ?? edge.relationshipKey ?? edge.key ?? edge.label ?? ""}-${edge.target}`}
                      className="text-muted-foreground"
                    >
                      {edge.kind === "hierarchy"
                        ? "Contains"
                        : (edge.label ?? "Blocks")}
                      :{" "}
                      {graph.nodes.find((target) => target.id === edge.target)
                        ?.name ?? edge.target}
                      {onSelectEdge && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onSelectEdge(edge)}
                        >
                          Inspect connection
                        </Button>
                      )}
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
