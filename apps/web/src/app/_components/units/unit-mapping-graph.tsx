import type { UnitMapping } from "@cubby/schemas/unitmapping";
import * as d3Force from "d3-force";
import { useEffect, useMemo, useRef, useState } from "react";
import { useContainerDimensions } from "~/hooks/useContainerDimensions";
import { wasm } from "~/lib/wasm";

/**
 * A live node-link graph of a product's unit mappings: nodes are units (g, lb,
 * cup, each, $, kcal…), edges are conversions, colored by measurement kind.
 * Disconnected components drift apart, so an islanded price ($──each floating
 * away from the g cluster) is visible at a glance. Fed the editor's *preview*
 * mappings, so it redraws as you type — node positions persist across updates so
 * the layout nudges rather than re-randomizing on every keystroke.
 */
interface UNode extends d3Force.SimulationNodeDatum {
  id: string;
  label: string;
  kind: string;
}
interface ULink extends d3Force.SimulationLinkDatum<UNode> {
  source: string | UNode;
  target: string | UNode;
}

const KIND_COLOR: Record<string, string> = {
  weight: "var(--chart-1)",
  volume: "var(--chart-2)",
  money: "var(--warning)",
  calories: "var(--chart-5)",
};

const kindColor = (kind: string): string => {
  if (kind.startsWith("nutrient:")) return "var(--muted-foreground)";
  return KIND_COLOR[kind] ?? "var(--muted-foreground)";
};

const unitLabel = (unit: string): string => (unit === "dollar" ? "$" : unit);

// USDA nutrition synthesis emits a per-nutrient edge (100 g = N g protein, mg
// zinc, ug folate…). Those explode the node count and aren't relevant to
// convertibility, so drop them. They always take the shape "<mass-prefix>
// <nutrient name>", which clean cooking units (g, cup, each, large, $, kcal)
// never do — so a mass prefix followed by a descriptor word is the tell.
const NUTRIENT_UNIT_RE = /^(g|mg|ug|µg|mcg|iu|kj)\s+\S/i;
const isDisplayUnit = (unit: string): boolean => !NUTRIENT_UNIT_RE.test(unit);

const amountKind = (unit: string): string => {
  try {
    return wasm.amount_kind({ value: 1, unit });
  } catch {
    return "other";
  }
};

export function UnitMappingGraph({
  mappings,
  height = 200,
}: {
  mappings: UnitMapping[];
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dim = useContainerDimensions(containerRef, {
    minHeight: height,
    initialWidth: 248,
    initialHeight: height,
  });
  const width = dim.width;

  const { nodes, links } = useMemo(() => {
    const nodeMap = new Map<string, UNode>();
    const linkArr: ULink[] = [];
    const ensure = (unit: string) => {
      if (!nodeMap.has(unit)) {
        nodeMap.set(unit, {
          id: unit,
          label: unitLabel(unit),
          kind: amountKind(unit),
        });
      }
    };
    for (const m of mappings) {
      if (!isDisplayUnit(m.a.unit) || !isDisplayUnit(m.b.unit)) continue;
      ensure(m.a.unit);
      ensure(m.b.unit);
      linkArr.push({ source: m.a.unit, target: m.b.unit });
    }
    return { nodes: [...nodeMap.values()], links: linkArr };
  }, [mappings]);

  // Persist node positions across re-layouts so typing nudges the graph instead
  // of teleporting every node to a new random spot.
  const posRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const [simNodes, setSimNodes] = useState<UNode[]>([]);
  const [simLinks, setSimLinks] = useState<ULink[]>([]);

  useEffect(() => {
    if (nodes.length === 0) {
      setSimNodes([]);
      setSimLinks([]);
      return;
    }
    const nodesCopy: UNode[] = nodes.map((n) => {
      const saved = posRef.current.get(n.id);
      return {
        ...n,
        x: saved?.x ?? width / 2 + (Math.random() - 0.5) * 40,
        y: saved?.y ?? height / 2 + (Math.random() - 0.5) * 40,
      };
    });
    const linksCopy: ULink[] = links.map((l) => ({
      source: l.source,
      target: l.target,
    }));

    const sim = d3Force
      .forceSimulation<UNode>(nodesCopy)
      .force(
        "link",
        d3Force
          .forceLink<UNode, ULink>(linksCopy)
          .id((d) => d.id)
          .distance(44),
      )
      .force("charge", d3Force.forceManyBody().strength(-130))
      .force("center", d3Force.forceCenter(width / 2, height / 2))
      .force("collision", d3Force.forceCollide<UNode>().radius(17));

    sim.on("tick", () => {
      // Clamp with enough margin for the centered label, which is wider than the
      // 11px circle — otherwise edge nodes (e.g. a drifting islanded cluster)
      // clip against the container's overflow-hidden.
      for (const n of nodesCopy) {
        n.x = Math.max(24, Math.min(width - 24, n.x ?? 0));
        n.y = Math.max(16, Math.min(height - 16, n.y ?? 0));
        posRef.current.set(n.id, { x: n.x, y: n.y });
      }
      setSimNodes([...nodesCopy]);
      setSimLinks([...linksCopy]);
    });

    sim.alpha(0.6).restart();
    return () => {
      sim.stop();
    };
  }, [nodes, links, width, height]);

  return (
    <div
      ref={containerRef}
      className="w-full overflow-hidden rounded-md border bg-background/40"
      style={{ height }}
    >
      {nodes.length === 0 ? (
        <div className="flex h-full items-center justify-center text-2xs text-muted-foreground">
          No mappings yet.
        </div>
      ) : (
        <svg aria-hidden="true" width={width} height={height}>
          <g>
            {simLinks.map((link, i) => {
              const s = link.source as UNode;
              const t = link.target as UNode;
              if (s.x == null || t.x == null) return null;
              return (
                <line
                  // biome-ignore lint/suspicious/noArrayIndexKey: sim links lack stable ids
                  key={i}
                  x1={s.x}
                  y1={s.y}
                  x2={t.x}
                  y2={t.y}
                  stroke="var(--border)"
                  strokeWidth={1.5}
                />
              );
            })}
          </g>
          <g>
            {simNodes.map((n) => (
              <g key={n.id} transform={`translate(${n.x ?? 0}, ${n.y ?? 0})`}>
                <circle
                  r={11}
                  fill={kindColor(n.kind)}
                  stroke="var(--card)"
                  strokeWidth={1.5}
                />
                <text
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="pointer-events-none fill-white font-medium text-2xs"
                  style={{ textShadow: "0 1px 2px rgba(0,0,0,0.6)" }}
                >
                  {n.label.length > 5 ? `${n.label.slice(0, 4)}…` : n.label}
                </text>
              </g>
            ))}
          </g>
        </svg>
      )}
    </div>
  );
}
