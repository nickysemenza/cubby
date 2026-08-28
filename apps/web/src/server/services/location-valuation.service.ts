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

import type { Database } from "~/server/db";
import {
  getLocationValuationInputs,
  writeLocationValuations,
} from "~/server/repo/location";

import { rollupLocationValuations } from "./location-valuation-rollup";

export class LocationValuationService {
  constructor(private readonly db: Database) {}

  /**
   * Recompute every location's persisted valuation rollup in one pass.
   * Returns the number of locations written.
   */
  async recompute(): Promise<number> {
    const db = this.db;

    // Inputs (repo owns the schema access): every non-deleted inventory item
    // (location, valuation, product name) and every non-deleted location.
    const { entries, locations: locs } = await getLocationValuationInputs(db);

    // Pure tree rollup (direct + descendants).
    const rollups = rollupLocationValuations(entries, locs);

    // Persist (repo owns the write).
    await writeLocationValuations(
      db,
      locs.map((l) => ({ id: l.id, valuation: rollups.get(l.id) ?? null })),
    );

    return locs.length;
  }
}
