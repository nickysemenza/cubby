import type { Entity } from "@cubby/schemas/entity";
import { generatedEntityListFields } from "@cubby/schemas/entity-list-fields";
import { fieldResult } from "@cubby/schemas/field-envelope";
import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  inheritedFieldDecisionSchema,
  inheritedFieldDecisionSql,
} from "~/server/db/computed/effective-field";
import type { Database } from "~/server/db/database";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { explanationReferenceValues } from "~/server/generic/field-explanation/repo/explanation-reference-values";

const resultSchema = fieldResult(z.json());

/** Exact, uncapped counterfactual; only explanation reads request this work. */
export async function inheritedResetPreview(
  db: Database,
  entity: Entity,
  field: string,
  internalId: string,
): Promise<z.output<typeof resultSchema> | null> {
  if (!Object.hasOwn(generatedEntityListFields[entity].inherit, field))
    return null;
  const rows = await repositoryQueries(db).execute(sql`SELECT
    ${inheritedFieldDecisionSql(entity, field, { id: sql`${internalId}::uuid` })} AS decision`);
  const decision = inheritedFieldDecisionSchema.parse(rows.rows[0]?.decision);
  const [publicDecision] = await explanationReferenceValues(db, [decision]);
  const current = inheritedFieldDecisionSchema.parse(publicDecision);
  return resultSchema.parse({
    kind: "live",
    decision: {
      outcome:
        current.kind === "value"
          ? { kind: "value", value: current.value }
          : { kind: "empty", reason: current.reason },
      provenance: current.source
        ? { kind: "inherited", source: { ...current.source, name: null } }
        : current.kind === "value"
          ? { kind: "default", source: null }
          : null,
    },
  });
}
