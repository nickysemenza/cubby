import { useNavigate } from "@tanstack/react-router";
import * as d3Force from "d3-force";
import { Network, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useContainerDimensions } from "~/hooks/useContainerDimensions";
import type { NotionProject } from "~/server/clients/notion";
import { ChartEmpty } from "./chart-empty";

const STATUS_COLORS: Record<string, string> = {
  Done: "hsl(142, 50%, 50%)",
  "In progress": "hsl(210, 60%, 55%)",
  Planning: "hsl(270, 50%, 60%)",
  "Not started": "#999",
  Blocked: "hsl(0, 55%, 50%)",
};

interface GraphNode extends d3Force.SimulationNodeDatum {
  id: string;
  name: string;
  icon: string | null;
  status: string | null;
  radius: number;
}

interface GraphLink extends d3Force.SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
}

export function DependencyGraph({ projects }: { projects: NotionProject[] }) {
  const { nodes, links } = useMemo(() => {
    const projectIds = new Set(projects.map((p) => p.id));

    const involvedIds = new Set<string>();
    for (const p of projects) {
      for (const depId of p.blockedBy) {
        if (projectIds.has(depId)) {
          involvedIds.add(p.id);
          involvedIds.add(depId);
        }
      }
      for (const depId of p.blocking) {
        if (projectIds.has(depId)) {
          involvedIds.add(p.id);
          involvedIds.add(depId);
        }
      }
    }

    const involved = projects.filter((p) => involvedIds.has(p.id));

    const nodes: GraphNode[] = involved.map((p) => ({
      id: p.id,
      name: p.name,
      icon: p.icon,
      status: p.status,
      radius: p.status === "Done" ? 20 : 28,
    }));

    const linkSet = new Set<string>();
    const links: GraphLink[] = [];

    for (const p of involved) {
      for (const blockerId of p.blockedBy) {
        if (!involvedIds.has(blockerId)) continue;
        const key = `${blockerId}->${p.id}`;
        if (linkSet.has(key)) continue;
        linkSet.add(key);
        links.push({ source: blockerId, target: p.id });
      }
    }

    return { nodes, links };
  }, [projects]);

  if (nodes.length === 0) {
    return <ChartEmpty icon={Network} title="No project dependencies found." />;
  }

  return <ForceGraph nodes={nodes} links={links} />;
}

type ViewBox = { x: number; y: number; w: number; h: number };

function ForceGraph({
  nodes: initialNodes,
  links: initialLinks,
}: {
  nodes: GraphNode[];
  links: GraphLink[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dimensions = useContainerDimensions(containerRef, {
    minHeight: 350,
    initialWidth: 800,
    initialHeight: 450,
  });
  const navigate = useNavigate();
  const svgRef = useRef<SVGSVGElement>(null);

  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [nodePositions, setNodePositions] = useState<GraphNode[]>([]);
  const [linkPositions, setLinkPositions] = useState<GraphLink[]>([]);

  // Pan/zoom state
  const defaultViewBox: ViewBox = useMemo(
    () => ({ x: 0, y: 0, w: dimensions.width, h: dimensions.height }),
    [dimensions.width, dimensions.height],
  );
  const [viewBox, setViewBox] = useState<ViewBox>(defaultViewBox);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef<{ x: number; y: number; vx: number; vy: number }>({
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
  });

  // Reset viewBox when dimensions change
  useEffect(() => {
    setViewBox({ x: 0, y: 0, w: dimensions.width, h: dimensions.height });
  }, [dimensions.width, dimensions.height]);

  // Force simulation — no clamping, let nodes spread naturally
  useEffect(() => {
    const nodes = initialNodes.map((n) => ({ ...n }));
    const links = initialLinks.map((l) => ({ ...l }));

    const simulation = d3Force
      .forceSimulation<GraphNode>(nodes)
      .force(
        "link",
        d3Force
          .forceLink<GraphNode, GraphLink>(links)
          .id((d) => d.id)
          .distance(140),
      )
      .force("charge", d3Force.forceManyBody().strength(-400))
      .force(
        "center",
        d3Force.forceCenter(dimensions.width / 2, dimensions.height / 2),
      )
      .force(
        "collision",
        d3Force.forceCollide<GraphNode>().radius((d) => d.radius + 12),
      );

    simulation.on("tick", () => {
      setNodePositions([...nodes]);
      setLinkPositions([...links]);
    });

    return () => {
      simulation.stop();
    };
  }, [initialNodes, initialLinks, dimensions.width, dimensions.height]);

  const handleNodeClick = useCallback(
    (nodeId: string) => {
      navigate({ to: "/projects/$id", params: { id: nodeId } });
    },
    [navigate],
  );

  // Zoom handler
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const svg = svgRef.current;
      if (!svg) return;

      const rect = svg.getBoundingClientRect();
      // Cursor position in viewBox coordinates
      const mx = viewBox.x + ((e.clientX - rect.left) / rect.width) * viewBox.w;
      const my = viewBox.y + ((e.clientY - rect.top) / rect.height) * viewBox.h;

      const zoomFactor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      const newW = Math.max(
        dimensions.width * 0.3,
        Math.min(dimensions.width * 3, viewBox.w * zoomFactor),
      );
      const newH = Math.max(
        dimensions.height * 0.3,
        Math.min(dimensions.height * 3, viewBox.h * zoomFactor),
      );

      // Keep cursor position stable
      const newX = mx - ((mx - viewBox.x) / viewBox.w) * newW;
      const newY = my - ((my - viewBox.y) / viewBox.h) * newH;

      setViewBox({ x: newX, y: newY, w: newW, h: newH });
    },
    [viewBox, dimensions.width, dimensions.height],
  );

  // Pan handlers
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Only pan on direct SVG background clicks (not on nodes)
      if (
        (e.target as Element).tagName !== "svg" &&
        !(e.target as Element).closest("svg > rect")
      )
        return;
      setIsPanning(true);
      panStart.current = {
        x: e.clientX,
        y: e.clientY,
        vx: viewBox.x,
        vy: viewBox.y,
      };
    },
    [viewBox.x, viewBox.y],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isPanning) return;
      const svg = svgRef.current;
      if (!svg) return;

      const rect = svg.getBoundingClientRect();
      const scale = viewBox.w / rect.width;
      const dx = (e.clientX - panStart.current.x) * scale;
      const dy = (e.clientY - panStart.current.y) * scale;

      setViewBox((prev) => ({
        ...prev,
        x: panStart.current.vx - dx,
        y: panStart.current.vy - dy,
      }));
    },
    [isPanning, viewBox.w],
  );

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
  }, []);

  const resetView = useCallback(() => {
    setViewBox(defaultViewBox);
  }, [defaultViewBox]);

  const isZoomed =
    Math.abs(viewBox.w - defaultViewBox.w) > 1 ||
    Math.abs(viewBox.x - defaultViewBox.x) > 1 ||
    Math.abs(viewBox.y - defaultViewBox.y) > 1;

  return (
    <div ref={containerRef} className="relative h-[450px] rounded-md border">
      {isZoomed && (
        <button
          type="button"
          onClick={resetView}
          className="absolute top-2 right-2 z-10 flex items-center gap-1 rounded-md bg-background/80 px-2 py-1 text-muted-foreground text-xs shadow-sm ring-1 ring-border hover:bg-background hover:text-foreground"
        >
          <RotateCcw className="h-3 w-3" />
          Reset
        </button>
      )}
      <svg
        ref={svgRef}
        width={dimensions.width}
        height={dimensions.height}
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
        aria-label="Project dependency graph"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ cursor: isPanning ? "grabbing" : "grab" }}
      >
        <defs>
          <marker
            id="arrowhead"
            viewBox="0 0 10 7"
            refX="10"
            refY="3.5"
            markerWidth="8"
            markerHeight="6"
            orient="auto"
          >
            <polygon points="0 0, 10 3.5, 0 7" fill="#999" />
          </marker>
        </defs>

        {/* Invisible rect for pan target */}
        <rect
          x={viewBox.x}
          y={viewBox.y}
          width={viewBox.w}
          height={viewBox.h}
          fill="transparent"
        />

        {/* Links */}
        {linkPositions.map((link, i) => {
          const source = link.source as GraphNode;
          const target = link.target as GraphNode;
          if (source.x == null || target.x == null) return null;

          const dx = target.x - source.x;
          const dy = (target.y ?? 0) - (source.y ?? 0);
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist === 0) return null;

          const targetR = target.radius + 4;
          const x2 = target.x - (dx / dist) * targetR;
          const y2 = (target.y ?? 0) - (dy / dist) * targetR;

          const isHighlighted =
            hoveredNode === source.id || hoveredNode === target.id;

          return (
            <line
              key={`link-${i}`}
              x1={source.x}
              y1={source.y}
              x2={x2}
              y2={y2}
              stroke={isHighlighted ? "#333" : "#ccc"}
              strokeWidth={isHighlighted ? 2.5 : 1.5}
              markerEnd="url(#arrowhead)"
              style={{ transition: "stroke 0.15s, stroke-width 0.15s" }}
            />
          );
        })}

        {/* Nodes */}
        {nodePositions.map((node) => {
          const isHovered = hoveredNode === node.id;
          const color = STATUS_COLORS[node.status ?? ""] ?? "#999";
          const isDone = node.status === "Done";

          return (
            <g
              key={node.id}
              transform={`translate(${node.x}, ${node.y})`}
              onMouseEnter={() => setHoveredNode(node.id)}
              onMouseLeave={() => setHoveredNode(null)}
              onClick={(e) => {
                e.stopPropagation();
                handleNodeClick(node.id);
              }}
              style={{ cursor: "pointer" }}
            >
              <circle
                r={node.radius}
                fill={color}
                opacity={isDone ? 0.5 : 0.85}
                stroke={isHovered ? "#333" : "white"}
                strokeWidth={isHovered ? 3 : 2}
                style={{ transition: "all 0.15s" }}
              />
              {node.icon && (
                <text
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={16}
                  style={{ pointerEvents: "none" }}
                >
                  {node.icon}
                </text>
              )}
              <text
                y={node.radius + 14}
                textAnchor="middle"
                fontSize={11}
                fill="#333"
                fontWeight={isHovered ? 600 : 400}
                style={{ pointerEvents: "none" }}
              >
                {node.name.length > 22
                  ? `${node.name.slice(0, 22)}...`
                  : node.name}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="flex items-center justify-center gap-4 px-3 py-2 text-muted-foreground text-xs">
        <span>Arrow = "blocks"</span>
        <span>·</span>
        <span>Scroll to zoom · Drag to pan · Click to open</span>
      </div>
    </div>
  );
}
