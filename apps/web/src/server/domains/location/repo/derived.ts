/**
 * Location's stored valuation rollup (ADR 0021). The rollup is a whole-tree
 * fold over the published inventory valuations, so recomputing a batch of
 * locations reads the tree once and never values inventory itself.
 */
import type { LocationId } from "@cubby/schemas/identifiers";

import { loadStoredInventoryValuations } from "~/server/domains/inventory/repo/valuation";
import type {
  DerivedCompute,
  DerivedComputed,
} from "~/server/generic/derived/repo/compute";

import { computeLocationValuations } from "./valuation";

const locationRollupCompute: DerivedCompute = async (db, ids) => {
  const rollups = await computeLocationValuations(
    db,
    await loadStoredInventoryValuations(db),
  );
  const out = new Map<string, DerivedComputed>();
  for (const id of ids) {
    // SAFETY: the drain passes ids of `location.valuationRollup` marks only.
    const rollup = rollups.get(id as LocationId);
    if (rollup) out.set(id, { value: rollup, sort: rollup.totalValuation });
  }
  return out;
};

export const locationDerivedComputes = {
  "location.valuationRollup": locationRollupCompute,
};
