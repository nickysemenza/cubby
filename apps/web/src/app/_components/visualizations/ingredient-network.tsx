import type {
  IngredientEdge,
  IngredientNode,
} from "@cubby/schemas/ingredient-cooccurrence";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as d3Force from "d3-force";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { recipe } from "~/app/recipes/recipe.functions";
import { useContainerDimensions } from "~/hooks/useContainerDimensions";
import { getAppErrorDetails } from "~/lib/error-utils";

import { VisualizationPlaceholder } from "./visualization-placeholder";
import { VizOverlay, VizTooltip } from "./viz-overlay";

interface NetworkNode extends IngredientNode, d3Force.SimulationNodeDatum {}

interface NetworkLink extends d3Force.SimulationLinkDatum<NetworkNode> {
  source: string | NetworkNode;
  target: string | NetworkNode;
  weight: number;
  recipes: Array<{ id: string; name: string }>;
}

const isNetworkNode = (
  endpoint: string | NetworkNode,
): endpoint is NetworkNode => endpoint instanceof Object;

const resolvedNetworkNode = (
  endpoint: string | NetworkNode,
): NetworkNode | null => (isNetworkNode(endpoint) ? endpoint : null);

export default function IngredientNetwork() {
  const { data, isError, error, isLoading, refetch } = useQuery(
    recipe.getIngredientCooccurrence.queryOptions({ minEdgeWeight: 2 }),
  );

  if (isLoading) {
    return (
      <VisualizationPlaceholder
        message="Loading ingredient data..."
        height={400}
      />
    );
  }

  if (isError) {
    return (
      <VisualizationPlaceholder
        message="Ingredient relationships are unavailable"
        subMessage={getAppErrorDetails(error).message}
        height={400}
        onRetry={() => void refetch()}
      />
    );
  }

  if (!data || data.nodes.length === 0 || data.edges.length === 0) {
    return (
      <VisualizationPlaceholder
        message="No ingredient relationships to display"
        subMessage="Add more recipes with shared ingredients to see connections"
        height={400}
      />
    );
  }

  return <NetworkGraph nodes={data.nodes} edges={data.edges} />;
}

interface NetworkGraphProps {
  nodes: IngredientNode[];
  edges: IngredientEdge[];
}

function NetworkGraph({ nodes, edges }: NetworkGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const summaryId = useId();
  const dimensions = useContainerDimensions(containerRef, {
    minHeight: 400,
    initialWidth: 800,
    initialHeight: 400,
  });
  const [hoveredNode, setHoveredNode] = useState<NetworkNode | null>(null);
  const [selectedLinkKey, setSelectedLinkKey] = useState<string | null>(null);
  const [simulatedNodes, setSimulatedNodes] = useState<NetworkNode[]>([]);
  const [simulatedLinks, setSimulatedLinks] = useState<NetworkLink[]>([]);

  const getLinkKey = useCallback((link: NetworkLink) => {
    const sourceId = isNetworkNode(link.source) ? link.source.id : link.source;
    const targetId = isNetworkNode(link.target) ? link.target.id : link.target;
    return [sourceId, targetId].sort().join("|");
  }, []);

  const selectedLink = useMemo(() => {
    if (!selectedLinkKey) return null;
    return (
      simulatedLinks.find((l) => getLinkKey(l) === selectedLinkKey) ?? null
    );
  }, [selectedLinkKey, simulatedLinks, getLinkKey]);

  // Calculate node radius based on recipe count (must be before useEffect that uses it)
  const maxRecipeCount = useMemo(
    () => Math.max(...nodes.map((n) => n.recipeCount), 1),
    [nodes],
  );

  const getNodeRadius = useCallback(
    (node: { recipeCount: number }) => {
      const minRadius = 8;
      const maxRadius = 24;
      const scale = node.recipeCount / maxRecipeCount;
      return minRadius + scale * (maxRadius - minRadius);
    },
    [maxRecipeCount],
  );

  // Initialize and run simulation
  useEffect(() => {
    if (nodes.length === 0) return;

    // Create deep copies for simulation (d3 mutates these)
    const nodesCopy: NetworkNode[] = nodes.map((n) => ({
      ...n,
      x: dimensions.width / 2 + (Math.random() - 0.5) * 100,
      y: dimensions.height / 2 + (Math.random() - 0.5) * 100,
    }));

    const linksCopy: NetworkLink[] = edges.map((e) => ({
      source: e.source,
      target: e.target,
      weight: e.weight,
      recipes: e.recipes,
    }));

    // Calculate max weight for scaling
    const maxWeight = Math.max(...edges.map((e) => e.weight), 1);

    const simulation = d3Force
      .forceSimulation<NetworkNode>(nodesCopy)
      .force(
        "link",
        d3Force
          .forceLink<NetworkNode, NetworkLink>(linksCopy)
          .id((d) => d.id)
          .distance(100)
          .strength((d) => d.weight / maxWeight),
      )
      .force("charge", d3Force.forceManyBody().strength(-200))
      .force(
        "center",
        d3Force.forceCenter(dimensions.width / 2, dimensions.height / 2),
      )
      .force(
        "collision",
        d3Force.forceCollide<NetworkNode>().radius((d) => getNodeRadius(d) + 5),
      );

    // Static layout: run the simulation to completion synchronously, then push
    // a single state update — instead of streaming ticks through React state.
    // The old on("tick") → setState fired twice per tick and re-rendered
    // thousands of SVG elements ~300× per mount, freezing the main thread
    // (requestAnimationFrame stalled 30s+). We lose only the settling
    // animation, the right trade for a below-the-fold homepage panel.
    simulation.stop();
    const tickCount = Math.ceil(
      Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay()),
    );
    simulation.tick(tickCount);

    // Keep nodes within bounds (applied once, post-settle).
    for (const node of nodesCopy) {
      const r = getNodeRadius(node);
      node.x = Math.max(r, Math.min(dimensions.width - r, node.x ?? 0));
      node.y = Math.max(r, Math.min(dimensions.height - r, node.y ?? 0));
    }
    setSimulatedNodes([...nodesCopy]);
    setSimulatedLinks([...linksCopy]);

    return () => {
      simulation.stop();
    };
  }, [nodes, edges, dimensions, getNodeRadius]);

  // Calculate link width based on weight
  const maxWeight = useMemo(
    () => Math.max(...edges.map((e) => e.weight), 1),
    [edges],
  );

  const getLinkWidth = useCallback(
    (weight: number) => {
      const minWidth = 1;
      const maxWidth = 6;
      const scale = weight / maxWeight;
      return minWidth + scale * (maxWidth - minWidth);
    },
    [maxWeight],
  );

  // Check if a link is connected to hovered node
  const isLinkHighlighted = useCallback(
    (link: NetworkLink) => {
      if (!hoveredNode) return false;
      const sourceId = isNetworkNode(link.source)
        ? link.source.id
        : link.source;
      const targetId = isNetworkNode(link.target)
        ? link.target.id
        : link.target;
      return sourceId === hoveredNode.id || targetId === hoveredNode.id;
    },
    [hoveredNode],
  );

  // Top nodes by recipe count, for the chart's aria-label summary.
  const chartSummary = useMemo(() => {
    const top = [...nodes]
      .sort((a, b) => b.recipeCount - a.recipeCount)
      .slice(0, 3)
      .map(
        (n) =>
          `${n.name} ${n.recipeCount} recipe${n.recipeCount !== 1 ? "s" : ""}`,
      )
      .join("; ");
    return `Ingredient co-occurrence network: ${top}; ${nodes.length} ingredients, ${edges.length} connections`;
  }, [nodes, edges]);

  const topIngredients = useMemo(
    () => [...nodes].sort((a, b) => b.recipeCount - a.recipeCount).slice(0, 3),
    [nodes],
  );

  // Check if a node is connected to hovered node
  const isNodeConnected = useCallback(
    (node: NetworkNode) => {
      if (!hoveredNode) return true;
      if (node.id === hoveredNode.id) return true;
      return simulatedLinks.some((link) => {
        const sourceId = isNetworkNode(link.source)
          ? link.source.id
          : link.source;
        const targetId = isNetworkNode(link.target)
          ? link.target.id
          : link.target;
        return (
          (sourceId === hoveredNode.id && targetId === node.id) ||
          (targetId === hoveredNode.id && sourceId === node.id)
        );
      });
    },
    [hoveredNode, simulatedLinks],
  );

  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events jsx-a11y/no-static-element-interactions -- Blank-canvas click is a pointer convenience; the selected-link panel has a keyboard-operable close button.
    <div
      ref={containerRef}
      className="relative h-[400px] w-full overflow-hidden border border-[var(--border)]"
      onClick={() => setSelectedLinkKey(null)}
    >
      <svg
        ref={svgRef}
        aria-label={chartSummary}
        aria-describedby={summaryId}
        width={dimensions.width}
        height={dimensions.height}
      >
        <title>{chartSummary}</title>
        {/* Links */}
        <g>
          {simulatedLinks.map((link) => {
            const source = resolvedNetworkNode(link.source);
            const target = resolvedNetworkNode(link.target);
            if (!source?.x || !target?.x) return null;

            const linkKey = getLinkKey(link);
            const highlighted = isLinkHighlighted(link);
            const isSelected = selectedLinkKey === linkKey;
            const opacity = hoveredNode
              ? highlighted
                ? 0.8
                : 0.1
              : isSelected
                ? 1
                : 0.4;

            return (
              <g key={linkKey}>
                {/* oxlint-disable jsx-a11y/prefer-tag-over-role -- SVG has no native button; this single focusable edge exposes pressed state and keyboard activation. */}
                <line
                  role="button"
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  stroke="transparent"
                  strokeWidth={Math.max(getLinkWidth(link.weight) + 8, 12)}
                  className="peer cursor-pointer outline-none"
                  tabIndex={0}
                  aria-label={`Show recipes containing ${source.name} and ${target.name}`}
                  aria-pressed={isSelected}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedLinkKey((current) =>
                      current === linkKey ? null : linkKey,
                    );
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      setSelectedLinkKey((current) =>
                        current === linkKey ? null : linkKey,
                      );
                    }
                  }}
                />
                {/* oxlint-enable jsx-a11y/prefer-tag-over-role */}
                {/* Visible line */}
                <line
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  stroke={
                    highlighted || isSelected
                      ? "var(--primary)"
                      : "var(--border)"
                  }
                  strokeWidth={getLinkWidth(link.weight)}
                  strokeOpacity={opacity}
                  className="pointer-events-none peer-focus-visible:stroke-primary peer-focus-visible:stroke-[3px]"
                />
              </g>
            );
          })}
        </g>

        {/* Nodes */}
        <g>
          {simulatedNodes.map((node) => {
            const radius = getNodeRadius(node);
            const connected = isNodeConnected(node);
            const isHovered = hoveredNode?.id === node.id;
            // ~4.5px per char at 9px font, need inner diameter (radius * 1.4) for safe text area
            const maxChars = Math.max(0, Math.floor((radius * 1.4) / 4.5));
            // Only show inner label if we can fit at least 5 chars
            const showInnerLabel = maxChars >= 5;
            const truncatedName =
              node.name.length > maxChars
                ? `${node.name.slice(0, Math.max(2, maxChars - 2))}...`
                : node.name;

            return (
              <g
                key={node.id}
                transform={`translate(${node.x ?? 0}, ${node.y ?? 0})`}
                role="graphics-symbol"
                tabIndex={0}
                aria-label={`${node.name}, used in ${node.recipeCount} recipes`}
                onMouseEnter={() => setHoveredNode(node)}
                onMouseLeave={() => setHoveredNode(null)}
                onFocus={() => setHoveredNode(node)}
                onBlur={() => setHoveredNode(null)}
              >
                <circle
                  r={radius}
                  fill={isHovered ? "var(--primary)" : "var(--chart-3)"}
                  stroke={isHovered ? "var(--primary)" : "var(--card)"}
                  strokeWidth={isHovered ? 3 : 2}
                  opacity={connected ? 1 : 0.2}
                  className="transition-opacity"
                />
                {showInnerLabel && (
                  <text
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="pointer-events-none fill-background text-2xs font-semibold"
                  >
                    {truncatedName}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      <p id={summaryId} className="sr-only">
        {chartSummary}. Use the ingredient links below to open an ingredient.
      </p>

      {topIngredients.length > 0 && (
        <nav
          aria-label="Top connected ingredients"
          className="absolute inset-x-2 bottom-2 flex flex-wrap gap-1 border border-[var(--border)] bg-background/95 p-1 pr-32"
        >
          {topIngredients.map((ingredient) => (
            <Link
              key={ingredient.id}
              to="/ingredients/$shortcode"
              params={{ shortcode: ingredient.id }}
              className="inline-flex min-h-11 items-center px-2 text-xs text-primary hover:underline sm:min-h-0"
            >
              {ingredient.name} ({ingredient.recipeCount})
            </Link>
          ))}
        </nav>
      )}

      {/* Tooltip for selected link */}
      {selectedLink && !hoveredNode && (
        <VizTooltip
          className="pointer-events-auto max-w-xs border"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="font-medium">
              {resolvedNetworkNode(selectedLink.source)?.name} +{" "}
              {resolvedNetworkNode(selectedLink.target)?.name}
            </div>
            <button
              type="button"
              aria-label="Close recipe pair details"
              onClick={() => setSelectedLinkKey(null)}
              className="-mt-0.5 text-lg leading-none text-muted-foreground hover:text-foreground" /* tight: × optical-align nudge */
            >
              ×
            </button>
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            Together in {selectedLink.weight} recipe
            {selectedLink.weight !== 1 ? "s" : ""}:
          </div>
          <div className="mt-2 space-y-1">
            {selectedLink.recipes.map((recipe) => (
              <Link
                key={recipe.id}
                to="/recipes/$shortcode"
                params={{ shortcode: recipe.id }}
                className="block text-xs text-primary hover:underline"
              >
                {recipe.name}
              </Link>
            ))}
          </div>
        </VizTooltip>
      )}

      {/* Tooltip for hovered node */}
      {hoveredNode && (
        <VizTooltip className="max-w-xs">
          <div className="font-medium">
            <Link
              to="/ingredients/$shortcode"
              params={{ shortcode: hoveredNode.id }}
              className="hover:underline"
              style={{ pointerEvents: "auto" }}
            >
              {hoveredNode.name}
            </Link>
          </div>
          <div className="mt-1 text-muted-foreground">
            Used in {hoveredNode.recipeCount} recipe
            {hoveredNode.recipeCount !== 1 ? "s" : ""}
          </div>
          <div className="text-xs text-muted-foreground">
            {
              simulatedLinks.filter((l) => {
                const sourceId = isNetworkNode(l.source)
                  ? l.source.id
                  : l.source;
                const targetId = isNetworkNode(l.target)
                  ? l.target.id
                  : l.target;
                return (
                  sourceId === hoveredNode.id || targetId === hoveredNode.id
                );
              }).length
            }{" "}
            connections
          </div>
        </VizTooltip>
      )}

      {/* Legend */}
      <VizOverlay className="bottom-14">
        <div className="text-muted-foreground">
          Node size = recipe count • Line thickness = co-occurrence
        </div>
      </VizOverlay>
    </div>
  );
}
