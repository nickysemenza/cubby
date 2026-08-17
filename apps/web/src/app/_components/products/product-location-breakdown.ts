import type { Amount } from "@cubby/schemas/codec";
import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type {
  LocationAncestorOut,
  LocationType,
} from "@cubby/schemas/location";
import type { HierarchyDrilldownNode } from "~/app/_components/visualizations/hierarchy-drilldown";
import { tryFormatAmount } from "../inventory/format-amount";

interface LocationPathRef {
  id: LocationShortcode;
  name: string;
  type: LocationType | null;
  /** Root -> immediate parent; the location itself is appended by the adapter. */
  ancestors: readonly LocationAncestorOut[];
}

type LocationRung = Pick<LocationPathRef, "id" | "name" | "type">;

export interface ProductLocationBreakdownInput {
  inventoryEntry: ReadonlyArray<{
    amount: Amount;
    placement: "stock" | "installed";
    location: LocationPathRef;
  }>;
  servingAsLocations: readonly LocationPathRef[];
}

interface Contribution {
  path: readonly LocationRung[];
  amount: Amount;
  annotation: "stock" | "installed" | "is this location";
}

interface MutableNode {
  id: string;
  label: string;
  locationShortcode?: LocationShortcode;
  directByUnit: Map<string, number>;
  annotations: Set<string>;
  children: Map<string, MutableNode>;
}

const syntheticRoot = (): MutableNode => ({
  id: "product-location-root",
  label: "All locations",
  directByUnit: new Map(),
  annotations: new Set(),
  children: new Map(),
});

const locationPath = (location: LocationPathRef): LocationRung[] => [
  ...location.ancestors,
  location,
];

const addAmount = (totals: Map<string, number>, amount: Amount) => {
  totals.set(amount.unit, (totals.get(amount.unit) ?? 0) + amount.value);
};

const mergeTotals = (
  target: Map<string, number>,
  source: ReadonlyMap<string, number>,
) => {
  for (const [unit, value] of source) {
    target.set(unit, (target.get(unit) ?? 0) + value);
  }
};

const formatTotals = (totals: ReadonlyMap<string, number>): string =>
  [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([unit, value]) => tryFormatAmount({ value, unit }))
    .join(" + ");

const scalarValue = (
  totals: ReadonlyMap<string, number>,
  globallyMixed: boolean,
): number | null => {
  if (globallyMixed || totals.size !== 1) return null;
  return totals.values().next().value ?? null;
};

const finalizeNode = (
  node: MutableNode,
  globallyMixed: boolean,
): { node: HierarchyDrilldownNode; totals: Map<string, number> } => {
  const totals = new Map(node.directByUnit);
  const children = [...node.children.values()].map((child) => {
    const finalized = finalizeNode(child, globallyMixed);
    mergeTotals(totals, finalized.totals);
    return finalized.node;
  });

  const directMetricLabel =
    node.directByUnit.size > 0 ? formatTotals(node.directByUnit) : undefined;

  return {
    totals,
    node: {
      id: node.id,
      label: node.label,
      metricLabel: formatTotals(totals),
      metricValue: scalarValue(totals, globallyMixed),
      ...(directMetricLabel
        ? {
            directMetricLabel,
            directMetricValue: scalarValue(node.directByUnit, globallyMixed),
          }
        : {}),
      ...(node.locationShortcode
        ? { locationShortcode: node.locationShortcode }
        : {}),
      ...(node.annotations.size > 0
        ? { annotations: [...node.annotations].sort() }
        : {}),
      ...(children.length > 0 ? { children } : {}),
    },
  };
};

const sharedPrefix = (
  paths: ReadonlyArray<readonly LocationRung[]>,
): readonly LocationRung[] => {
  const first = paths[0];
  if (!first) return [];
  let length = first.length;
  for (const path of paths.slice(1)) {
    length = Math.min(length, path.length);
    let index = 0;
    while (index < length && first[index]?.id === path[index]?.id) index += 1;
    length = index;
  }
  return first.slice(0, length);
};

const findByPath = (
  root: HierarchyDrilldownNode,
  path: readonly LocationRung[],
): HierarchyDrilldownNode => {
  let current = root;
  for (const rung of path) {
    const next = current.children?.find((child) => child.id === rung.id);
    if (!next) return root;
    current = next;
  }
  return current;
};

/**
 * Adapt a product's two presence kinds into one zoomable location hierarchy.
 *
 * Inventory rows contribute their stored amount at the holding location.
 * Locations that ARE the product contribute one `each` at their own leaf.
 * Aggregation stays per-unit; if the product mixes units, every numeric bar is
 * disabled while the formatted labels continue to show each honest subtotal.
 */
export const buildProductLocationBreakdown = (
  product: ProductLocationBreakdownInput,
): HierarchyDrilldownNode | null => {
  const contributions: Contribution[] = [
    ...product.inventoryEntry.map((entry) => ({
      path: locationPath(entry.location),
      amount: entry.amount,
      annotation: entry.placement,
    })),
    ...product.servingAsLocations.map((location) => ({
      path: locationPath(location),
      amount: { value: 1, unit: "each" },
      annotation: "is this location" as const,
    })),
  ];
  if (contributions.length === 0) return null;

  const root = syntheticRoot();
  const globalUnits = new Set(contributions.map((row) => row.amount.unit));

  for (const contribution of contributions) {
    let current = root;
    for (const rung of contribution.path) {
      let child = current.children.get(rung.id);
      if (!child) {
        child = {
          id: rung.id,
          label: rung.name,
          locationShortcode: rung.id,
          directByUnit: new Map(),
          annotations: new Set(),
          children: new Map(),
        };
        current.children.set(rung.id, child);
      }
      current = child;
    }
    addAmount(current.directByUnit, contribution.amount);
    current.annotations.add(contribution.annotation);
  }

  const finalized = finalizeNode(root, globalUnits.size > 1).node;
  return findByPath(
    finalized,
    sharedPrefix(contributions.map((row) => row.path)),
  );
};
