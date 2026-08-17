/**
 * Pure tree-rollup for per-location inventory valuation — no DB/IO, so it's
 * unit-testable in isolation. location-valuation.service feeds it the repo's
 * read and persists the result.
 *
 * `direct` = items placed at a location; `total` = direct + all descendants.
 */

import type { LocationId } from "@cubby/schemas/identifiers";
import type { LocationValuation } from "@cubby/schemas/location";
import { isMiscProduct } from "@cubby/shared";

// Inventory valuations are cents-precision reals; summing them can leave float
// dust, so round each persisted total to two decimals.
const round2 = (n: number): number => Math.round(n * 100) / 100;

interface DirectAgg {
  valuation: number;
  itemCount: number;
  priced: number;
  missingPricing: number;
  miscNoPrice: number;
  /** Fixed installations, tallied apart from the countable figures above. */
  installedValuation: number;
  installedItemCount: number;
  /**
   * The vessels standing directly in this location — the child locations that
   * ARE products. Their price is not stock held here, so it stays out of
   * `valuation` entirely.
   */
  containerValuation: number;
  containerItemCount: number;
}

const emptyAgg = (): DirectAgg => ({
  valuation: 0,
  itemCount: 0,
  priced: 0,
  missingPricing: 0,
  miscNoPrice: 0,
  installedValuation: 0,
  installedItemCount: 0,
  containerValuation: 0,
  containerItemCount: 0,
});

/**
 * Compute every location's valuation rollup from the flat inventory + location
 * lists. An item counts as `priced` when its precomputed valuation is > 0, else
 * `miscNoPrice` for misc-named products, else `missingPricing`.
 */
export function rollupLocationValuations(
  entries: {
    locationId: LocationId;
    valuation: number | null;
    placement?: "stock" | "installed";
    productName: string;
  }[],
  locations: {
    id: LocationId;
    parentId: LocationId | null;
    /** Effective price of the SKU this location IS, when it is one. */
    productPrice?: number | null;
  }[],
): Map<LocationId, LocationValuation> {
  // Direct aggregates per location.
  const direct = new Map<LocationId, DirectAgg>();
  for (const e of entries) {
    let agg = direct.get(e.locationId);
    if (!agg) {
      agg = emptyAgg();
      direct.set(e.locationId, agg);
    }
    // Fixtures never reach the countable tallies, including the pricing
    // breakdown: a "missing price" nudge you cannot act on by walking to a
    // shelf is noise, and it would cap the pricing coverage meter forever.
    if (e.placement === "installed") {
      agg.installedItemCount += 1;
      if (e.valuation != null && e.valuation > 0) {
        agg.installedValuation += e.valuation;
      }
      continue;
    }
    agg.itemCount += 1;
    if (e.valuation != null && e.valuation > 0) {
      agg.valuation += e.valuation;
      agg.priced += 1;
    } else if (isMiscProduct(e.productName)) {
      agg.miscNoPrice += 1;
    } else {
      agg.missingPricing += 1;
    }
  }

  // A location that IS a product contributes its own price to its PARENT's
  // container tally, never to its own: "what is on this shelf" and "what is
  // this shelf" are different questions — the same split `installed` draws.
  //
  // A top-level location with a product has no parent to attribute to, so its
  // own price lands in no rollup. Accepted: every vessel in the tree today
  // hangs off a room or area, and inventing a synthetic root to hold it would
  // put a number on a screen nobody asked about.
  for (const l of locations) {
    if (!l.parentId || l.productPrice == null) continue;
    let agg = direct.get(l.parentId);
    if (!agg) {
      agg = emptyAgg();
      direct.set(l.parentId, agg);
    }
    agg.containerValuation += l.productPrice;
    agg.containerItemCount += 1;
  }

  // Tree rollup: total = direct + Σ descendants (post-order, memoized).
  const childrenOf = new Map<LocationId, LocationId[]>();
  for (const l of locations) {
    if (l.parentId) {
      const sibs = childrenOf.get(l.parentId);
      if (sibs) sibs.push(l.id);
      else childrenOf.set(l.parentId, [l.id]);
    }
  }

  const rollups = new Map<LocationId, LocationValuation>();
  const visiting = new Set<LocationId>();
  const computeTotal = (id: LocationId): LocationValuation => {
    const memo = rollups.get(id);
    if (memo) return memo;
    const d = direct.get(id) ?? emptyAgg();
    let totalValuation = d.valuation;
    let totalItemCount = d.itemCount;
    let tPriced = d.priced;
    let tMissing = d.missingPricing;
    let tMisc = d.miscNoPrice;
    let totalInstalledValuation = d.installedValuation;
    let totalInstalledItemCount = d.installedItemCount;
    let totalContainerValuation = d.containerValuation;
    let totalContainerItemCount = d.containerItemCount;
    if (!visiting.has(id)) {
      // Guard against a malformed parent cycle (wouldCreateParentCycle should
      // prevent these, but never recurse forever on bad data).
      visiting.add(id);
      for (const childId of childrenOf.get(id) ?? []) {
        const ct = computeTotal(childId);
        totalValuation += ct.totalValuation;
        totalItemCount += ct.totalItemCount;
        tPriced += ct.total.priced;
        tMissing += ct.total.missingPricing;
        tMisc += ct.total.miscNoPrice;
        totalInstalledValuation += ct.installed?.totalValuation ?? 0;
        totalInstalledItemCount += ct.installed?.totalItemCount ?? 0;
        totalContainerValuation += ct.container?.totalValuation ?? 0;
        totalContainerItemCount += ct.container?.totalItemCount ?? 0;
      }
      visiting.delete(id);
    }
    const v: LocationValuation = {
      directValuation: round2(d.valuation),
      totalValuation: round2(totalValuation),
      directItemCount: d.itemCount,
      totalItemCount,
      direct: {
        priced: d.priced,
        missingPricing: d.missingPricing,
        miscNoPrice: d.miscNoPrice,
      },
      total: { priced: tPriced, missingPricing: tMissing, miscNoPrice: tMisc },
      installed: {
        directValuation: round2(d.installedValuation),
        totalValuation: round2(totalInstalledValuation),
        directItemCount: d.installedItemCount,
        totalItemCount: totalInstalledItemCount,
      },
      container: {
        directValuation: round2(d.containerValuation),
        totalValuation: round2(totalContainerValuation),
        directItemCount: d.containerItemCount,
        totalItemCount: totalContainerItemCount,
      },
    };
    rollups.set(id, v);
    return v;
  };
  for (const l of locations) computeTotal(l.id);
  return rollups;
}
