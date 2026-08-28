import type { Amount } from "@cubby/schemas/codec";
import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
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
  /**
   * Resolved server-side: own photo, else the cover of the SKU this location
   * IS. Ancestors carry it too, so a whole path flattens to one rung shape.
   */
  displayImage: ImageUrlSummary | null;
  /** Root -> immediate parent; the location itself is appended by the adapter. */
  ancestors: readonly LocationPathAncestor[];
}

type LocationPathAncestor = LocationAncestorOut & {
  displayImage: ImageUrlSummary | null;
};

type LocationRung = Pick<
  LocationPathRef,
  "id" | "name" | "type" | "displayImage"
>;

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
  displayImage?: ImageUrlSummary;
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

const finalizeNode = (node: MutableNode, globallyMixed: boolean) => {
  const totals = new Map(node.directByUnit);
  const children = [...node.children.values()].map((child) => {
    const finalized = finalizeNode(child, globallyMixed);
    mergeTotals(totals, finalized.totals);
    return finalized.node;
  });

  const directMetricLabel =
    node.directByUnit.size > 0 ? formatTotals(node.directByUnit) : undefined;

  const resultNode: HierarchyDrilldownNode = {
    id: node.id,
    label: node.label,
    metricLabel: formatTotals(totals),
    metricValue: scalarValue(totals, globallyMixed),
  };
  if (directMetricLabel !== undefined) {
    resultNode.directMetricLabel = directMetricLabel;
    resultNode.directMetricValue = scalarValue(
      node.directByUnit,
      globallyMixed,
    );
  }
  if (node.locationShortcode !== undefined) {
    resultNode.locationShortcode = node.locationShortcode;
  }
  if (node.displayImage !== undefined) {
    resultNode.displayImage = node.displayImage;
  }
  if (node.annotations.size > 0) {
    resultNode.annotations = [...node.annotations].sort();
  }
  if (children.length > 0) {
    resultNode.children = children;
  }
  return { totals, node: resultNode };
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
        if (rung.displayImage !== null) {
          child.displayImage = rung.displayImage;
        }
        current.children.set(rung.id, child);
      } else if (!child.displayImage && rung.displayImage) {
        // Every rung with this id names the SAME location, so whichever
        // contribution reaches it first must not decide whether it has a
        // picture. A stock entry and an identity row arrive from two payload
        // branches; only one of them is guaranteed to carry the thumbnail.
        child.displayImage = rung.displayImage;
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
