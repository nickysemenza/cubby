import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { fieldDecision } from "@cubby/schemas/field-envelope";
import { fieldLiveComparison } from "@cubby/schemas/field-explanation";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { storedDerived } from "~/server/db/derived-declarations";
import {
  type DerivedComputes,
  validateComputedResult,
  isDerivedSink,
} from "~/server/generic/derived/repo/compute";
import { projectStoredResult } from "~/server/generic/derived/repo/read";
/** The caller owns the read snapshot; comparisons never publish or replace its result. */
export async function explainLiveDerived(
  db: Database | DrizzleTransaction,
  computes: DerivedComputes,
  entity: Entity,
  key: string,
  internalId: string,
): Promise<z.output<typeof fieldLiveComparison> | null> {
  const field = entityFieldModels[entity].fields.find(
    (field) => field.key === key,
  );
  if (
    field &&
    "storedProjection" in field &&
    field.storedProjection &&
    !field.storedPath
  )
    return {
      kind: "unavailable",
      reason:
        "This value folds published facts with current context; inspect the displayed result and its source evidence.",
    };
  const declaration = storedDerived(entity, field?.storedKey ?? key);
  if (!declaration) return null;
  const compute = computes[declaration.compute];
  if (!compute || isDerivedSink(compute))
    return {
      kind: "unavailable",
      reason: "This computation publishes no single live field result",
    };
  const value = (await compute(db, [internalId])).get(internalId);
  if (!value)
    return {
      kind: "unavailable",
      reason: "The live computation produced no result for this record",
    };
  const computed = validateComputedResult({
    target: declaration.target,
    computed: value,
  });
  const metadata = computed.decision;
  const decision = fieldDecision(z.json()).parse({
    provenance: metadata.provenance,
    outcome:
      metadata.outcome.kind === "value"
        ? { kind: "value", value: computed.value }
        : metadata.outcome,
  });
  const selected = field?.storedPath
    ? projectStoredResult(
        {
          value: computed.value,
          decision,
          resultExists: true,
          computedAt: null,
          stale: false,
          error: null,
          retryAt: null,
        },
        field.storedPath,
      ).decision
    : decision;
  return selected
    ? { kind: "available", result: { kind: "live", decision: selected } }
    : {
        kind: "unavailable",
        reason: "The live result omitted the declared projection",
      };
}
