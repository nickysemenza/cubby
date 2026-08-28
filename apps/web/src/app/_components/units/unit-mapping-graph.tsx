import type { UnitMapping } from "@cubby/schemas/unitmapping";
import * as d3Force from "d3-force";
import { useEffect, useMemo, useRef, useState } from "react";

import { Row } from "~/components/layout";
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
  /** A built-in conversion (e.g. g↔lb) rather than a stored mapping. */
  native?: boolean;
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

// Shorten the verbose USDA portion units that clutter the graph — drop the
// parenthetical size ("(2-3/8 inch dia)"), the "NLEA" prefix, and "… or X"
// tails, keeping the head noun. Full unit stays as the node id (hover <title>).
const unitLabel = (unit: string): string => {
  if (unit === "dollar") return "$";
  const short = unit
    .replace(/\([^)]*\)/g, "")
    .replace(/\bNLEA\b/gi, "")
    .replace(/\s+or\s+.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return short || unit;
};

// USDA nutrition synthesis emits a per-nutrient edge (100 g = N g protein, mg
// zinc, ug folate…). Those explode the node count and aren't relevant to
// convertibility, so drop them. They always take the shape "<mass-prefix>
// <nutrient name>", which clean cooking units (g, cup, each, large, $, kcal)
// never do — so a mass prefix followed by a descriptor word is the tell.
const NUTRIENT_UNIT_RE = /^(g|mg|ug|µg|mcg|iu|kj)\s+\S/i;
const isDisplayUnit = (unit: string): boolean => !NUTRIENT_UNIT_RE.test(unit);

/**
 * A mapping worth showing to the user: both endpoints are real units, not USDA
 * per-nutrient edges. Unlike a core-4 filter this keeps bridge conversions
 * between two count/other units (e.g. `1 each = 1 large`) — which matter, since
 * they connect an islanded unit into the rest of the graph. Shared by the
 * graph and the workbench's "Current conversions" table so they never disagree.
 */
export const isDisplayMapping = (m: UnitMapping): boolean =>
  isDisplayUnit(m.a.unit) && isDisplayUnit(m.b.unit);

const amountKind = (unit: string): string => {
  try {
    return wasm.amount_kind({ value: 1, unit });
  } catch {
    return "other";
  }
};

export function UnitMappingGraph({
  mappings,
  height = 260,
  includeNutrients = false,
}: {
  mappings: UnitMapping[];
  height?: number;
  /**
   * Show the USDA per-nutrient edges (100 g = N mg potassium…). Off by default —
   * they explode the node count and aren't about convertibility — but the
   * conversion dialog's "Show nutrient mappings" toggle opts in.
   */
  includeNutrients?: boolean;
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
      if (!includeNutrients && !isDisplayMapping(m)) continue;
      ensure(m.a.unit);
      ensure(m.b.unit);
      linkArr.push({ source: m.a.unit, target: m.b.unit });
    }

    // Add the engine's built-in conversions: standard same-dimension units
    // (g↔lb, cup↔ml) and portion-modifier stripping ("tbsp, drained" ↔ cup)
    // aren't stored as mappings, so without these bridges a unit looks islanded
    // even though the engine — and the coverage panel — treat it as connected.
    // `unit_graph_bridges` computes the minimal dashed bridges in Rust, against
    // the real conversion graph, so the viz mirrors it by construction. It works
    // over the full mapping set, so only draw bridges between present nodes.
    for (const [a, b] of wasm.unit_graph_bridges(mappings)) {
      if (nodeMap.has(a) && nodeMap.has(b)) {
        linkArr.push({ source: a, target: b, native: true });
      }
    }

    return { nodes: [...nodeMap.values()], links: linkArr };
  }, [mappings, includeNutrients]);

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
      // Preserve `native` so the tick handler's setSimLinks carries it to render
      // (these draw dashed); without it every edge would render solid.
      native: l.native,
    }));

    const sim = d3Force
      .forceSimulation<UNode>(nodesCopy)
      .force(
        "link",
        d3Force
          .forceLink<UNode, ULink>(linksCopy)
          .id((d) => d.id)
          .distance(62),
      )
      .force("charge", d3Force.forceManyBody().strength(-280))
      .force("center", d3Force.forceCenter(width / 2, height / 2))
      .force("collision", d3Force.forceCollide<UNode>().radius(28));

    sim.on("tick", () => {
      // Labels sit beside the dot pointing inward, so only the small dot needs
      // margin against the container's overflow-hidden.
      for (const n of nodesCopy) {
        n.x = Math.max(12, Math.min(width - 12, n.x ?? 0));
        n.y = Math.max(12, Math.min(height - 12, n.y ?? 0));
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
      className="w-full overflow-hidden border border-[var(--border)] bg-background/40"
      style={{ height }}
    >
      {nodes.length === 0 ? (
        <Row
          align="center"
          justify="center"
          className="h-full text-2xs text-muted-foreground"
        >
          No mappings yet.
        </Row>
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
                  strokeDasharray={link.native ? "3 3" : undefined}
                  strokeOpacity={link.native ? 0.5 : 1}
                />
              );
            })}
          </g>
          <g>
            {simNodes.map((n) => {
              // Label beside the dot, pointing toward center so it never clips
              // the container edge — far more readable than cramming text into a
              // tiny circle. Full unit on hover via <title>.
              const onRight = (n.x ?? 0) > width / 2;
              return (
                <g key={n.id} transform={`translate(${n.x ?? 0}, ${n.y ?? 0})`}>
                  <title>{n.id}</title>
                  <circle
                    r={5}
                    fill={kindColor(n.kind)}
                    stroke="var(--card)"
                    strokeWidth={1.5}
                  />
                  <text
                    x={onRight ? -8 : 8}
                    textAnchor={onRight ? "end" : "start"}
                    dominantBaseline="middle"
                    className="pointer-events-none fill-foreground"
                    style={{ fontSize: 11 }}
                  >
                    {n.label.length > 13 ? `${n.label.slice(0, 12)}…` : n.label}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      )}
    </div>
  );
}
