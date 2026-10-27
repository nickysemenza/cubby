import type { Entity } from "@cubby/schemas/entity";
import { fieldDecision } from "@cubby/schemas/field-envelope";
import { fieldLiveComparison } from "@cubby/schemas/field-explanation";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { storedDerived } from "~/server/db/derived-declarations";
import {
  type DerivedComputes,
  computedDecision,
  isDerivedSink,
} from "~/server/generic/derived/repo/compute";
/** The caller owns the read snapshot; comparisons never publish or replace its result. */
export async function explainLiveDerived(
  db: Database | DrizzleTransaction,
  computes: DerivedComputes,
  entity: Entity,
  key: string,
  internalId: string,
): Promise<z.output<typeof fieldLiveComparison> | null> {
  const declaration = storedDerived(entity, key);
  if (!declaration) return null;
  const compute = computes[declaration.compute];
  if (!compute || isDerivedSink(compute))
    return {
      kind: "unavailable",
      reason: "This computation publishes no single live field result",
    };
  const computed = (await compute(db, [internalId])).get(internalId);
  if (!computed)
    return {
      kind: "unavailable",
      reason: "The live computation produced no result for this record",
    };
  const metadata = computedDecision(computed);
  const decision = fieldDecision(z.json()).parse({
    provenance: metadata.provenance,
    outcome:
      metadata.outcome.kind === "value"
        ? { kind: "value", value: computed.value }
        : metadata.outcome,
  });
  return { kind: "available", result: { kind: "live", decision } };
}
