import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as d3Force from "d3-force";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useContainerDimensions } from "~/hooks/useContainerDimensions";
import type {
  IngredientEdge,
  IngredientNode,
} from "~/schemas/ingredient-cooccurrence";
import { useTRPC } from "~/trpc/react";
import { VisualizationPlaceholder } from "./visualization-placeholder";

interface NetworkNode extends IngredientNode, d3Force.SimulationNodeDatum {}

interface NetworkLink extends d3Force.SimulationLinkDatum<NetworkNode> {
  source: string | NetworkNode;
  target: string | NetworkNode;
  weight: number;
  recipes: Array<{ id: string; name: string }>;
}

export default function IngredientNetwork() {
  const api = useTRPC();
  const { data, isLoading } = useQuery(
    api.recipe.getIngredientCooccurrence.queryOptions({ minEdgeWeight: 2 }),
  );

  if (isLoading) {
    return (
      <VisualizationPlaceholder
        message="Loading ingredient data..."
        height={400}
      />
    );
  }

  if (!data || data.nodes.length === 0) {
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
  const dimensions = useContainerDimensions(containerRef, {
    minHeight: 400,
    initialWidth: 800,
    initialHeight: 400,
  });
  const [hoveredNode, setHoveredNode] = useState<NetworkNode | null>(null);
  const [selectedLinkKey, setSelectedLinkKey] = useState<string | null>(null);
  const [simulatedNodes, setSimulatedNodes] = useState<NetworkNode[]>([]);
  const [simulatedLinks, setSimulatedLinks] = useState<NetworkLink[]>([]);

  // Helper to get a stable key for a link
  const getLinkKey = useCallback((link: NetworkLink) => {
    const sourceId =
      typeof link.source === "string" ? link.source : link.source.id;
    const targetId =
      typeof link.target === "string" ? link.target : link.target.id;
    return [sourceId, targetId].sort().join("|");
  }, []);

  // Get the currently selected link object
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
          .strength((d) => (d.weight as number) / maxWeight),
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

    simulation.on("tick", () => {
      // Keep nodes within bounds
      for (const node of nodesCopy) {
        const r = getNodeRadius(node);
        node.x = Math.max(r, Math.min(dimensions.width - r, node.x ?? 0));
        node.y = Math.max(r, Math.min(dimensions.height - r, node.y ?? 0));
      }
      setSimulatedNodes([...nodesCopy]);
      setSimulatedLinks([...linksCopy]);
    });

    // Run simulation for a bit then stop for performance
    simulation.alpha(1).restart();

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
      const sourceId =
        typeof link.source === "string" ? link.source : link.source.id;
      const targetId =
        typeof link.target === "string" ? link.target : link.target.id;
      return sourceId === hoveredNode.id || targetId === hoveredNode.id;
    },
    [hoveredNode],
  );

  // Check if a node is connected to hovered node
  const isNodeConnected = useCallback(
    (node: NetworkNode) => {
      if (!hoveredNode) return true;
      if (node.id === hoveredNode.id) return true;
      return simulatedLinks.some((link) => {
        const sourceId =
          typeof link.source === "string" ? link.source : link.source.id;
        const targetId =
          typeof link.target === "string" ? link.target : link.target.id;
        return (
          (sourceId === hoveredNode.id && targetId === node.id) ||
          (targetId === hoveredNode.id && sourceId === node.id)
        );
      });
    },
    [hoveredNode, simulatedLinks],
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: D3 force-directed graph visualization interaction
    <div
      ref={containerRef}
      className="relative h-[400px] w-full overflow-hidden rounded-md border"
      onClick={() => setSelectedLinkKey(null)}
    >
      <svg
        ref={svgRef}
        aria-hidden="true"
        width={dimensions.width}
        height={dimensions.height}
      >
        {/* Links */}
        <g>
          {simulatedLinks.map((link, i) => {
            const source = link.source as NetworkNode;
            const target = link.target as NetworkNode;
            if (!source.x || !target.x) return null;

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
              <g
                // biome-ignore lint/suspicious/noArrayIndexKey: d3 simulation links don't have stable IDs
                key={i}
              >
                {/* biome-ignore lint/a11y/noStaticElementInteractions: D3 graph link click interaction */}
                <line
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  stroke="transparent"
                  strokeWidth={Math.max(getLinkWidth(link.weight) + 8, 12)}
                  className="cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedLinkKey((current) =>
                      current === linkKey ? null : linkKey,
                    );
                  }}
                />
                {/* Visible line */}
                <line
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  stroke={
                    highlighted || isSelected
                      ? "hsl(var(--primary))"
                      : "hsl(220, 10%, 60%)"
                  }
                  strokeWidth={getLinkWidth(link.weight)}
                  strokeOpacity={opacity}
                  className="pointer-events-none"
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
              // biome-ignore lint/a11y/noStaticElementInteractions: D3 graph node hover interaction
              <g
                key={node.id}
                transform={`translate(${node.x ?? 0}, ${node.y ?? 0})`}
                className="cursor-pointer"
                onMouseEnter={() => setHoveredNode(node)}
                onMouseLeave={() => setHoveredNode(null)}
              >
                <circle
                  r={radius}
                  fill={
                    isHovered ? "hsl(var(--primary))" : "hsl(220, 55%, 50%)"
                  }
                  stroke={isHovered ? "hsl(var(--primary))" : "white"}
                  strokeWidth={isHovered ? 3 : 2}
                  opacity={connected ? 1 : 0.2}
                  className="transition-opacity"
                />
                {showInnerLabel && (
                  <text
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="pointer-events-none fill-white font-semibold text-[9px]"
                    style={{ textShadow: "0 1px 3px rgba(0,0,0,0.7)" }}
                  >
                    {truncatedName}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {/* Tooltip for selected link */}
      {selectedLink && !hoveredNode && (
        // biome-ignore lint/a11y/noStaticElementInteractions: Tooltip click prevention
        <div
          className="absolute top-4 left-4 z-50 max-w-xs rounded-md border bg-popover px-3 py-2 text-sm shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="font-medium">
              {(selectedLink.source as NetworkNode).name} +{" "}
              {(selectedLink.target as NetworkNode).name}
            </div>
            <button
              type="button"
              onClick={() => setSelectedLinkKey(null)}
              className="-mt-0.5 text-lg text-muted-foreground leading-none hover:text-foreground"
            >
              ×
            </button>
          </div>
          <div className="mt-1.5 text-muted-foreground text-xs">
            Together in {selectedLink.weight} recipe
            {selectedLink.weight !== 1 ? "s" : ""}:
          </div>
          <div className="mt-1.5 space-y-1">
            {selectedLink.recipes.map((recipe) => (
              <Link
                key={recipe.id}
                to="/recipes/$id"
                params={{ id: recipe.id }}
                className="block text-primary text-xs hover:underline"
              >
                {recipe.name}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Tooltip for hovered node */}
      {hoveredNode && (
        <div className="absolute top-4 left-4 z-50 max-w-xs rounded-md bg-popover px-3 py-2 text-sm shadow-lg">
          <div className="font-medium">
            <Link
              to="/ingredients/$id"
              params={{ id: hoveredNode.id }}
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
          <div className="text-muted-foreground text-xs">
            {
              simulatedLinks.filter((l) => {
                const sourceId =
                  typeof l.source === "string" ? l.source : l.source.id;
                const targetId =
                  typeof l.target === "string" ? l.target : l.target.id;
                return (
                  sourceId === hoveredNode.id || targetId === hoveredNode.id
                );
              }).length
            }{" "}
            connections
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="absolute right-2 bottom-2 rounded bg-background/80 px-2 py-1 text-xs backdrop-blur">
        <div className="text-muted-foreground">
          Node size = recipe count • Line thickness = co-occurrence
        </div>
      </div>
    </div>
  );
}
