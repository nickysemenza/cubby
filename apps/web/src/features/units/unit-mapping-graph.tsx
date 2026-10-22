import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { useMemo } from "react";

import { wasm } from "~/lib/wasm";
import {
  NetworkChart,
  type NetworkChartNode,
  type NetworkChartLink,
} from "~/ui/charts/network-chart";
import { Row } from "~/ui/layout";

const KIND_COLOR = {
  weight: "var(--chart-1)",
  volume: "var(--chart-2)",
  money: "var(--warning)",
  calories: "var(--chart-5)",
} satisfies Record<"weight" | "volume" | "money" | "calories", string>;

const kindColor = (kind: string): string => {
  if (kind.startsWith("nutrient:")) return "var(--muted-foreground)";
  const knownKind = (value: string): value is keyof typeof KIND_COLOR =>
    Object.hasOwn(KIND_COLOR, value);
  return knownKind(kind) ? KIND_COLOR[kind] : "var(--muted-foreground)";
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
  includeNutrients?: boolean;
}) {
  const { nodes, links } = useMemo(() => {
    const nodeMap = new Map<string, NetworkChartNode>();
    const linkArr: NetworkChartLink[] = [];
    const ensure = (unit: string) => {
      if (!nodeMap.has(unit)) {
        nodeMap.set(unit, {
          id: unit,
          label: unitLabel(unit),
          color: kindColor(amountKind(unit)),
          size: 10,
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

  const data = useMemo(() => ({ nodes, links }), [nodes, links]);
  return (
    <div className="w-full border border-border bg-background/40">
      {nodes.length === 0 ? (
        <Row
          align="center"
          justify="center"
          style={{ height }}
          className="text-xs text-muted-foreground"
        >
          No mappings yet.
        </Row>
      ) : (
        <NetworkChart
          data={data}
          height={height}
          summary={`${nodes.length} units connected by ${links.length} conversions. Dashed lines are built-in conversions.`}
        />
      )}
      {links.length > 0 && (
        <details className="border-t border-border p-2 text-xs">
          <summary className="cursor-pointer">Conversion connections</summary>
          <ul className="max-h-64 overflow-auto py-2">
            {links.map((link, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- Conversion rows can share endpoints; the list has no per-row state.
              <li key={index}>
                {link.source} ↔ {link.target}
                {link.native ? " · built-in" : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
