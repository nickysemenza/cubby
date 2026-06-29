import type { Entity } from "@cubby/schemas/entity";
import { allEntities, entityReferences } from "@cubby/schemas/entity-manifest";
import * as d3Force from "d3-force";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { ENTITY_ACCENTS } from "~/entities/entity-accents";
import { useContainerDimensions } from "~/hooks/useContainerDimensions";
import { VizOverlay } from "../visualizations/viz-overlay";

interface GraphNode extends d3Force.SimulationNodeDatum {
  id: Entity;
}
interface GraphLink extends d3Force.SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
}

/**
 * Directed reference graph of every entity, laid out by d3-force straight from
 * the manifest's `references` — add an entity or edge and it appears here with
 * no layout to maintain. Arrows point from an entity to what it references; a
 * node's size grows with how many entities reference it (image is the hub).
 */
export function EntityReferenceGraph() {
  const containerRef = useRef<HTMLDivElement>(null);
  const arrowId = useId().replace(/:/g, "");
  const arrowActiveId = `${arrowId}a`;
  const dimensions = useContainerDimensions(containerRef, {
    minHeight: 420,
    initialWidth: 800,
    initialHeight: 420,
  });
  const dimsRef = useRef(dimensions);
  dimsRef.current = dimensions;

  const [hovered, setHovered] = useState<Entity | null>(null);
  const [simNodes, setSimNodes] = useState<GraphNode[]>([]);
  const [simLinks, setSimLinks] = useState<GraphLink[]>([]);

  // Edges (self-loops handled separately — forceLink can't lay them out).
  const links = useMemo(
    () =>
      allEntities.flatMap((from) =>
        entityReferences(from)
          .filter((to) => to !== from)
          .map((to) => ({ source: from, target: to })),
      ),
    [],
  );
  const selfLoops = useMemo(
    () => allEntities.filter((e) => entityReferences(e).includes(e)),
    [],
  );

  // Node size grows with in-degree (how many entities reference it).
  const inDegree = useMemo(() => {
    const counts = new Map<Entity, number>();
    for (const e of links) {
      const t = e.target as Entity;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return counts;
  }, [links]);
  const getRadius = useCallback(
    (id: Entity) => 12 + Math.min(inDegree.get(id) ?? 0, 5) * 3,
    [inDegree],
  );

  useEffect(() => {
    const { width, height } = dimsRef.current;
    const nodesCopy: GraphNode[] = allEntities.map((id, i) => ({
      id,
      // Deterministic-ish ring seed so the layout settles the same way each load.
      x: width / 2 + Math.cos((i / allEntities.length) * 2 * Math.PI) * 140,
      y: height / 2 + Math.sin((i / allEntities.length) * 2 * Math.PI) * 120,
    }));
    const linksCopy: GraphLink[] = links.map((l) => ({ ...l }));

    const simulation = d3Force
      .forceSimulation<GraphNode>(nodesCopy)
      .force(
        "link",
        d3Force
          .forceLink<GraphNode, GraphLink>(linksCopy)
          .id((d) => d.id)
          .distance(110),
      )
      .force("charge", d3Force.forceManyBody().strength(-380).distanceMax(360))
      .force("center", d3Force.forceCenter(width / 2, height / 2))
      .force("x", d3Force.forceX(width / 2).strength(0.05))
      .force("y", d3Force.forceY(height / 2).strength(0.08))
      .force(
        "collision",
        d3Force.forceCollide<GraphNode>().radius((d) => getRadius(d.id) + 18),
      );

    simulation.on("tick", () => {
      const { width: w, height: h } = dimsRef.current;
      for (const node of nodesCopy) {
        const r = getRadius(node.id) + 18;
        node.x = Math.max(r, Math.min(w - r, node.x ?? 0));
        node.y = Math.max(r + 8, Math.min(h - r, node.y ?? 0));
      }
      setSimNodes([...nodesCopy]);
      setSimLinks([...linksCopy]);
    });
    simulation.alpha(1).restart();
    return () => {
      simulation.stop();
    };
  }, [links, getRadius]);

  const edgeActive = useCallback(
    (s: Entity, t: Entity) =>
      hovered != null && (s === hovered || t === hovered),
    [hovered],
  );

  return (
    <div
      ref={containerRef}
      className="relative h-[420px] w-full overflow-hidden rounded-md border border-[var(--border)]"
    >
      <svg
        aria-label="Entity reference graph"
        width={dimensions.width}
        height={dimensions.height}
      >
        <defs>
          {[
            { id: arrowId, fill: "var(--border)" },
            { id: arrowActiveId, fill: "var(--primary)" },
          ].map((m) => (
            <marker
              key={m.id}
              id={m.id}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={m.fill} />
            </marker>
          ))}
        </defs>

        <g>
          {simLinks.map((link, i) => {
            const source = link.source as GraphNode;
            const target = link.target as GraphNode;
            if (source.x == null || target.x == null) return null;
            const dx = (target.x ?? 0) - (source.x ?? 0);
            const dy = (target.y ?? 0) - (source.y ?? 0);
            const len = Math.hypot(dx, dy) || 1;
            const tr = getRadius(target.id) + 5;
            const sr = getRadius(source.id) + 2;
            const active = edgeActive(source.id, target.id);
            return (
              <line
                // biome-ignore lint/suspicious/noArrayIndexKey: d3 links lack stable ids
                key={i}
                x1={(source.x ?? 0) + (dx / len) * sr}
                y1={(source.y ?? 0) + (dy / len) * sr}
                x2={(target.x ?? 0) - (dx / len) * tr}
                y2={(target.y ?? 0) - (dy / len) * tr}
                stroke={active ? "var(--primary)" : "var(--border)"}
                strokeWidth={active ? 2 : 1.25}
                strokeOpacity={hovered ? (active ? 0.95 : 0.1) : 0.55}
                markerEnd={`url(#${active ? arrowActiveId : arrowId})`}
              />
            );
          })}
        </g>

        <g>
          {simNodes.map((node) => {
            const r = getRadius(node.id);
            const dim =
              hovered != null &&
              hovered !== node.id &&
              !entityReferences(hovered).includes(node.id) &&
              !entityReferences(node.id).includes(hovered);
            const hasSelf = selfLoops.includes(node.id);
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: graph node hover
              <g
                key={node.id}
                transform={`translate(${node.x ?? 0}, ${node.y ?? 0})`}
                opacity={dim ? 0.25 : 1}
                className="cursor-default transition-opacity"
                onMouseEnter={() => setHovered(node.id)}
                onMouseLeave={() => setHovered(null)}
              >
                {hasSelf && (
                  <circle
                    r={r + 4}
                    fill="none"
                    stroke="var(--warning)"
                    strokeWidth={1.25}
                    strokeDasharray="2 2"
                  />
                )}
                <circle
                  r={r}
                  fill={ENTITY_ACCENTS[node.id]}
                  stroke="var(--card)"
                  strokeWidth={2}
                />
                <text
                  y={r + 12}
                  textAnchor="middle"
                  className="fill-foreground font-mono text-[10px]"
                >
                  {node.id}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      <VizOverlay className="text-muted-foreground">
        Arrow → the entity it references · size = times referenced · dashed ring
        = self-reference
      </VizOverlay>
    </div>
  );
}
