import { useEffect, useMemo, useRef, useState } from "react";
import type svgPanZoom from "svg-pan-zoom";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";

import {
  graphToDot,
  type GraphData,
  type GraphFilters,
  prepareGraph,
} from "./dependency-graph-model";

import "./dependency-graph.css";

let renderer:
  | ReturnType<(typeof import("@viz-js/viz"))["instance"]>
  | undefined;
async function getRenderer() {
  renderer ??= import("@viz-js/viz")
    .then((module) => module.instance())
    .catch((error) => {
      renderer = undefined;
      throw error;
    });
  return renderer;
}

/** Fit large graphs, but keep small graphs at readable record-label scale. */
function fitGraph(instance: ReturnType<typeof svgPanZoom>) {
  instance.fit();
  const { realZoom } = instance.getSizes();
  if (realZoom > 1.25) instance.zoom((instance.getZoom() * 1.25) / realZoom);
  instance.center();
}

export function DependencyGraphViewer({
  data,
  filters,
}: {
  data: GraphData;
  filters: GraphFilters;
}) {
  const graph = useMemo(() => prepareGraph(data, filters), [data, filters]);
  const dot = useMemo(
    () => graphToDot(graph, filters.grouped),
    [graph, filters.grouped],
  );
  const host = useRef<HTMLDivElement>(null);
  const navigation = useRef<ReturnType<typeof svgPanZoom> | null>(null);
  const [state, setState] = useState("Loading graph layout…");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    const container = host.current;
    let controls: ReturnType<typeof svgPanZoom> | undefined;
    let observer: ResizeObserver | undefined;
    setState("Loading graph layout…");
    const render = async () => {
      try {
        const [viz, panZoomModule] = await Promise.all([
          getRenderer(),
          import("svg-pan-zoom"),
        ]);
        if (disposed || !container) return;
        const svg = viz.renderSVGElement(dot);
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        svg.setAttribute("aria-label", "Entity dependency graph");
        for (const link of svg.querySelectorAll("a")) {
          link.setAttribute("tabindex", "0");
          link.setAttribute("aria-label", link.textContent ?? "Open record");
        }
        container.replaceChildren(svg);
        const instance = panZoomModule.default(svg, {
          controlIconsEnabled: false,
          minZoom: 0.01,
          mouseWheelZoomEnabled: false,
          dblClickZoomEnabled: false,
          fit: true,
          center: true,
        });
        navigation.current = instance;
        controls = instance;
        fitGraph(instance);
        observer = new ResizeObserver(() => {
          instance.resize();
          fitGraph(instance);
        });
        observer.observe(container);
        setState("");
      } catch {
        if (!disposed)
          setState(
            "Graph layout could not load. Use the record list below or retry.",
          );
      }
    };
    void render();
    return () => {
      disposed = true;
      observer?.disconnect();
      controls?.destroy();
      navigation.current = null;
      container?.replaceChildren();
    };
  }, [dot, attempt]);
  return (
    <Stack gap="md">
      <Row wrap gap="sm">
        <Button variant="outline" onClick={() => navigation.current?.zoomIn()}>
          Zoom in
        </Button>
        <Button variant="outline" onClick={() => navigation.current?.zoomOut()}>
          Zoom out
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            if (navigation.current) fitGraph(navigation.current);
          }}
        >
          Fit graph
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            navigation.current?.reset();
            if (navigation.current) fitGraph(navigation.current);
          }}
        >
          Reset view
        </Button>
      </Row>
      <p className="text-sm text-muted-foreground">
        Records: {graph.nodes.length} · {graph.hiddenNodeCount} hidden by
        filters · {graph.removedEdgeCount} redundant edges hidden. Dotted lines
        show hierarchy; solid arrows show dependencies. Drag to pan; use the
        buttons to zoom.
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
      {state && (
        <output>
          {state}{" "}
          {state.includes("could not") && (
            <Button
              variant="outline"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry layout
            </Button>
          )}
        </output>
      )}
      {graph.nodes.length === 0 && <p>No records match these graph filters.</p>}
      <div
        ref={host}
        className="dependency-graph rounded-panel h-[540px] min-w-0 overflow-hidden border bg-card"
      />
      <details open={state.includes("could not") || undefined}>
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
