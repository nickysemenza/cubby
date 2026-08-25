import type { CookbookShortcode } from "@cubby/schemas/identifiers";
import type {
  RecipeDepEdge,
  RecipeDepNode,
} from "@cubby/schemas/recipe-dependency-graph";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as d3Force from "d3-force";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { recipeDependencyGraphQueryOptions } from "~/app/recipes/recipe.functions";
import { useContainerDimensions } from "~/hooks/useContainerDimensions";
import { VisualizationPlaceholder } from "./visualization-placeholder";
import { VizOverlay, VizTooltip } from "./viz-overlay";

// Ink ladder tokens (ultramarine accent -> light grey), cycled across
// cookbooks for node fill.
const COOKBOOK_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
];

interface GraphNode extends RecipeDepNode, d3Force.SimulationNodeDatum {}

interface GraphLink extends d3Force.SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
}

export function RecipeDependencyGraph({
  cookbookId,
  hideUnconnected,
}: {
  cookbookId?: CookbookShortcode;
  hideUnconnected: boolean;
}) {
  const { data, isLoading } = useQuery(
    recipeDependencyGraphQueryOptions({ cookbookId }),
  );

  // Restrict to nodes that participate in an edge when asked — most recipes have
  // no sub-recipe links, so the unfiltered view is mostly isolated dots.
  const { nodes, edges } = useMemo(() => {
    if (!data) return { nodes: [], edges: [] };
    if (!hideUnconnected) return data;
    const connected = new Set<string>();
    for (const e of data.edges) {
      connected.add(e.source);
      connected.add(e.target);
    }
    return {
      nodes: data.nodes.filter((n) => connected.has(n.id)),
      edges: data.edges,
    };
  }, [data, hideUnconnected]);

  if (isLoading) {
    return (
      <VisualizationPlaceholder message="Loading recipe graph…" height={540} />
    );
  }

  if (nodes.length === 0) {
    return (
      <VisualizationPlaceholder
        message="No recipe dependencies to display"
        subMessage="Recipes that use another recipe as an ingredient appear here"
        height={540}
      />
    );
  }

  return <Graph nodes={nodes} edges={edges} />;
}

function Graph({
  nodes,
  edges,
}: {
  nodes: RecipeDepNode[];
  edges: RecipeDepEdge[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  // useId may contain ":" which is invalid in an SVG/CSS url() selector.
  const arrowId = useId().replace(/:/g, "");
  const dimensions = useContainerDimensions(containerRef, {
    minHeight: 540,
    initialWidth: 800,
    initialHeight: 540,
  });
  // Read live dimensions inside the simulation without making them an effect
  // dependency — otherwise every resize restarts the sim with fresh random
  // positions and the whole graph reshuffles.
  const dimsRef = useRef(dimensions);
  dimsRef.current = dimensions;
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  const [simNodes, setSimNodes] = useState<GraphNode[]>([]);
  const [simLinks, setSimLinks] = useState<GraphLink[]>([]);

  // Node radius scales with in-degree (how many recipes depend on it).
  const inDegree = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of edges)
      counts.set(e.target, (counts.get(e.target) ?? 0) + 1);
    return counts;
  }, [edges]);

  const getRadius = useCallback(
    (id: string) => 9 + Math.min(inDegree.get(id) ?? 0, 8) * 2,
    [inDegree],
  );

  // Stable cookbook → color assignment (external sub-recipes stay neutral).
  const colorFor = useMemo(() => {
    const order: string[] = [];
    for (const n of nodes) {
      if (n.cookbookId && !order.includes(n.cookbookId))
        order.push(n.cookbookId);
    }
    return (n: RecipeDepNode) => {
      if (!n.cookbookId) return "var(--muted-foreground)";
      const idx = order.indexOf(n.cookbookId);
      return COOKBOOK_COLORS[idx % COOKBOOK_COLORS.length] ?? "var(--chart-1)";
    };
  }, [nodes]);

  useEffect(() => {
    if (nodes.length === 0) return;
    const { width, height } = dimsRef.current;
    const nodesCopy: GraphNode[] = nodes.map((n) => ({
      ...n,
      x: width / 2 + (Math.random() - 0.5) * 200,
      y: height / 2 + (Math.random() - 0.5) * 200,
    }));
    const linksCopy: GraphLink[] = edges.map((e) => ({
      source: e.source,
      target: e.target,
    }));

    const simulation = d3Force
      .forceSimulation<GraphNode>(nodesCopy)
      .force(
        "link",
        d3Force
          .forceLink<GraphNode, GraphLink>(linksCopy)
          .id((d) => d.id)
          .distance(70),
      )
      // Cap long-range repulsion so isolated nodes don't fling to the walls.
      .force("charge", d3Force.forceManyBody().strength(-180).distanceMax(280))
      .force("center", d3Force.forceCenter(width / 2, height / 2))
      // Gentle pull toward centre keeps everything a cohesive cloud instead of
      // a ring clamped against the border (Y stronger — the band is wide+short).
      .force("x", d3Force.forceX(width / 2).strength(0.06))
      .force("y", d3Force.forceY(height / 2).strength(0.12))
      .force(
        "collision",
        d3Force.forceCollide<GraphNode>().radius((d) => getRadius(d.id) + 6),
      );

    simulation.on("tick", () => {
      // Clamp against live dimensions so nodes stay in view after a resize.
      const { width: w, height: h } = dimsRef.current;
      for (const node of nodesCopy) {
        const r = getRadius(node.id);
        node.x = Math.max(r, Math.min(w - r, node.x ?? 0));
        node.y = Math.max(r, Math.min(h - r, node.y ?? 0));
      }
      setSimNodes([...nodesCopy]);
      setSimLinks([...linksCopy]);
    });
    simulation.alpha(1).restart();
    return () => {
      simulation.stop();
    };
    // `dimensions` intentionally omitted — read live via dimsRef so resizes
    // don't restart the simulation and reshuffle node positions.
  }, [nodes, edges, getRadius]);

  const isAdjacent = useCallback(
    (node: GraphNode) => {
      if (!hovered) return true;
      if (node.id === hovered.id) return true;
      return simLinks.some((l) => {
        const s = typeof l.source === "string" ? l.source : l.source.id;
        const t = typeof l.target === "string" ? l.target : l.target.id;
        return (
          (s === hovered.id && t === node.id) ||
          (t === hovered.id && s === node.id)
        );
      });
    },
    [hovered, simLinks],
  );

  return (
    <div
      ref={containerRef}
      className="relative h-[540px] w-full overflow-hidden border border-[var(--border)]"
    >
      <svg
        aria-hidden="true"
        width={dimensions.width}
        height={dimensions.height}
      >
        <defs>
          <marker
            id={arrowId}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border)" />
          </marker>
        </defs>

        <g>
          {simLinks.map((link, i) => {
            const source = link.source as GraphNode;
            const target = link.target as GraphNode;
            if (source.x == null || target.x == null) return null;
            // Stop the line at the target's edge so the arrowhead sits clear.
            const dx = (target.x ?? 0) - (source.x ?? 0);
            const dy = (target.y ?? 0) - (source.y ?? 0);
            const len = Math.hypot(dx, dy) || 1;
            const r = getRadius(target.id) + 4;
            const tx = (target.x ?? 0) - (dx / len) * r;
            const ty = (target.y ?? 0) - (dy / len) * r;
            const active =
              hovered && (source.id === hovered.id || target.id === hovered.id);
            return (
              <line
                // biome-ignore lint/suspicious/noArrayIndexKey: d3 links lack stable ids
                key={i}
                x1={source.x}
                y1={source.y}
                x2={tx}
                y2={ty}
                stroke={active ? "var(--primary)" : "var(--border)"}
                strokeWidth={active ? 2 : 1.25}
                strokeOpacity={hovered ? (active ? 0.9 : 0.12) : 0.5}
                markerEnd={`url(#${arrowId})`}
              />
            );
          })}
        </g>

        <g>
          {simNodes.map((node) => {
            const r = getRadius(node.id);
            const adjacent = isAdjacent(node);
            const isHovered = hovered?.id === node.id;
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: D3 graph node interaction
              <g
                key={node.id}
                transform={`translate(${node.x ?? 0}, ${node.y ?? 0})`}
                className="cursor-pointer"
                onMouseEnter={() => setHovered(node)}
                onMouseLeave={() => setHovered(null)}
                onClick={() =>
                  navigate({
                    to: "/recipes/$shortcode",
                    params: { shortcode: node.id },
                  })
                }
              >
                <circle
                  r={r}
                  fill={isHovered ? "var(--primary)" : colorFor(node)}
                  stroke={
                    node.external ? "var(--muted-foreground)" : "var(--card)"
                  }
                  strokeWidth={2}
                  strokeDasharray={node.external ? "3 2" : undefined}
                  opacity={adjacent ? 1 : 0.2}
                  className="transition-opacity"
                />
              </g>
            );
          })}
        </g>
      </svg>

      {hovered && (
        <VizTooltip className="top-3 left-3 max-w-xs border">
          <div className="font-medium">{hovered.name}</div>
          <div className="mt-1 text-muted-foreground text-xs">
            {hovered.cookbookName ?? "No cookbook"}
            {hovered.external ? " · external" : ""}
          </div>
          <div className="mt-1 text-muted-foreground text-xs">
            Used by {inDegree.get(hovered.id) ?? 0} recipe
            {(inDegree.get(hovered.id) ?? 0) === 1 ? "" : "s"} · click to open
          </div>
        </VizTooltip>
      )}

      <VizOverlay className="text-muted-foreground">
        Arrow points to the sub-recipe it uses · size = how many depend on it
      </VizOverlay>
    </div>
  );
}
