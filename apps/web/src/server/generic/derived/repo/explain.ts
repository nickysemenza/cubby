import type { DerivedMeta } from "@cubby/schemas/derived-value";
/**
 * A stored derived field's explanation (ADR 0021): the published value and
 * its meta beside a live recompute for this one record. Reads never write:
 * a differing live value waits for the queued recompute.
 */
import type { Entity } from "@cubby/schemas/entity";

import type { Database, DrizzleTransaction } from "~/server/db";
import { storedDerived } from "~/server/db/derived-declarations";
import type { DerivedComputes } from "~/server/generic/derived/repo/compute";
import { loadStoredDerived } from "~/server/generic/derived/repo/read";

export interface StoredDerivedExplanation {
  readonly meta: DerivedMeta;
  readonly stored: unknown;
  readonly live: unknown;
}

export async function explainStoredDerived(
  db: Database | DrizzleTransaction,
  computes: DerivedComputes,
  entity: Entity,
  key: string,
  internalId: string,
): Promise<StoredDerivedExplanation | null> {
  const declaration = storedDerived(entity, key);
  if (!declaration) return null;
  const compute = computes[declaration.compute];
  const [stored, live] = await Promise.all([
    loadStoredDerived(db, entity, [internalId], [key]),
    compute ? compute(db, [internalId]) : Promise.resolve(null),
  ]);
  const read = stored.get(internalId)?.get(key);
  return {
    meta: read?.meta ?? { state: "missing", decidedBy: null, asOf: null },
    stored: read?.value ?? null,
    live: live ? (live.get(internalId)?.value ?? null) : null,
  };
}
