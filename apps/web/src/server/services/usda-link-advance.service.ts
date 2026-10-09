import type { ProductId } from "@cubby/schemas/identifiers";

import { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import { listProductFdcLinks } from "~/server/repo/product/lookup";
import { systemActor } from "~/server/runs/ensure-run";
import type { UsdaReleaseRpc } from "~/server/usda-release/rpc";

import { updateProductWithSideEffects } from "./product-orchestration.service";
import { createProductWriteActions } from "./product.service";
import { RecipeCostingService } from "./recipe-costing.service";

// Bounds each lookupBatch response; a full FoodSummary is a few KB.
const LOOKUP_CHUNK = 200;

export type UsdaLinkAdvance = {
  productId: ProductId;
  fromFdcId: number;
  toFdcId: number;
};

/**
 * Point every Product linked to a superseded food revision at the active
 * release's current revision (ADR 0008). Idempotent. A link the release no
 * longer knows is left alone: the UPC fallback and the Problems detectors own
 * it. Each change is an ordinary product update, so it records history and
 * recomputes nutrition. Applied advances drop out of the next pass, so a run
 * cut short resumes on the next cron.
 */
export async function advanceProductUsdaLinks(
  db: Database,
  usdaClient: USDAClient,
): Promise<UsdaLinkAdvance[]> {
  const rows = await listProductFdcLinks(db);
  const advances: UsdaLinkAdvance[] = [];
  for (let start = 0; start < rows.length; start += LOOKUP_CHUNK) {
    const chunk = rows.slice(start, start + LOOKUP_CHUNK);
    const foods = await usdaClient.findFoodsBatch(
      chunk.map((row) => ({ kind: "fdc", fdc_id: row.fdcId })),
    );
    chunk.forEach((row, i) => {
      const current = foods[i]?.fdc_id;
      if (current !== undefined && current !== row.fdcId)
        advances.push({
          productId: row.id,
          fromFdcId: row.fdcId,
          toFdcId: current,
        });
    });
  }
  if (advances.length === 0) return [];

  const services = {
    db,
    product: createProductWriteActions(db, usdaClient),
    recipeCosting: new RecipeCostingService(db, usdaClient),
  };
  const actor = systemActor();
  for (const advance of advances)
    await updateProductWithSideEffects(
      services,
      advance.productId,
      { fdc_id: advance.toFdcId },
      actor,
    );
  return advances;
}

/**
 * The daily activation step. Reading the status starts a newly activated
 * release's load; once that release is ready, its superseded links advance.
 * A failed load throws its raw error so the cron reports it every day until
 * someone resumes it.
 */
export async function advanceLinksWhenReady(
  db: Database,
  release: UsdaReleaseRpc,
) {
  const status = await release.status();
  if (status.state === "failed")
    throw new Error(
      `USDA release ${status.release} failed to load: ${status.error}`,
    );
  const { state } = status;
  return {
    state,
    advanced:
      state === "ready"
        ? await advanceProductUsdaLinks(db, new USDAClient(release))
        : [],
  };
}
