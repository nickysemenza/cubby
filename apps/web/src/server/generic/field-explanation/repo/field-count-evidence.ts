import type { Entity } from "@cubby/schemas/entity";

import type { Database, DrizzleTransaction } from "~/server/db";
import { kernelScaffold } from "~/server/entity-kernel/scaffolds";
import type { FieldCountEvidence } from "~/server/generic/field-explanation/repo/field-explanation-evidence";

/** Concrete, linked inputs for count fields whose public projections only carry a scalar. */
export async function loadFieldCountEvidence(
  db: Database | DrizzleTransaction,
  entityKind: Entity,
  shortcode: string,
  field: string,
): Promise<FieldCountEvidence | null> {
  const loader = kernelScaffold(entityKind)?.evidence?.[field];
  return loader ? loader(db, shortcode) : null;
}
