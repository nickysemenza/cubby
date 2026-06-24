/**
 * Server-side per-location inventory-valuation rollup. Sums the precomputed
 * `inventoryEntry.valuation` column per location, rolls it up through the
 * location tree (direct + descendants), and persists the result on
 * `location.valuation` — so the home card, the locations list/gallery/detail,
 * and the sunburst/treemap read a tiny column instead of fetching hundreds–
 * thousands of inventory rows and summing on the client.
 *
 * Recompute is whole-tree (locations are few — dozens) and runs eagerly at every
 * inventory/price mutation, so nothing is ever left stale; mirrors the
 * recipe-costing.service eager model but without a drain.
 */

import type { LocationId } from "@cubby/schemas/identifiers";
import type { LocationValuation } from "@cubby/schemas/location";
import { isMiscProduct } from "@cubby/shared";
import type { Database } from "~/server/db";
import {
  getLocationValuationInputs,
  writeLocationValuations,
} from "~/server/repo/location";

// Inventory valuations are cents-precision reals; summing them can leave float
// dust, so round each persisted total to two decimals.
const round2 = (n: number): number => Math.round(n * 100) / 100;

interface DirectAgg {
  valuation: number;
  itemCount: number;
  priced: number;
  missingPricing: number;
  miscNoPrice: number;
}

const emptyAgg = (): DirectAgg => ({
  valuation: 0,
  itemCount: 0,
  priced: 0,
  missingPricing: 0,
  miscNoPrice: 0,
});

export class LocationValuationService {
  constructor(private readonly db: Database) {}

  /**
   * Recompute every location's persisted valuation rollup in one pass.
   * Returns the number of locations written.
   */
  async recompute(): Promise<number> {
    const db = this.db;

    // 1+2. Inputs (repo owns the schema access): every non-deleted inventory item
    //      (location, valuation, product name) and every non-deleted location.
    const { entries, locations: locs } = await getLocationValuationInputs(db);

    // 3. Direct aggregates per location.
    const direct = new Map<LocationId, DirectAgg>();
    for (const e of entries) {
      let agg = direct.get(e.locationId);
      if (!agg) {
        agg = emptyAgg();
        direct.set(e.locationId, agg);
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

    // 4. Tree rollup: total = direct + Σ descendants (post-order, memoized).
    const childrenOf = new Map<LocationId, LocationId[]>();
    for (const l of locs) {
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
        total: {
          priced: tPriced,
          missingPricing: tMissing,
          miscNoPrice: tMisc,
        },
      };
      rollups.set(id, v);
      return v;
    };
    for (const l of locs) computeTotal(l.id);

    // 5. Persist (repo owns the write).
    await writeLocationValuations(
      db,
      locs.map((l) => ({ id: l.id, valuation: rollups.get(l.id) ?? null })),
    );

    return locs.length;
  }
}
