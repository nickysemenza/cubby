/**
 * The `derived` sidecar a list page or record read returns (ADR 0021): per
 * row, each stored derived field's state, deciding level and computation time,
 * plus the deciding level of inherited fields from their resolution.
 */
import type {
  DecidedBy,
  DerivedMeta,
  DerivedSidecar,
} from "@cubby/schemas/derived-value";
import type { Entity } from "@cubby/schemas/entity";
import type { FieldResolution } from "@cubby/schemas/field-resolution";

import type { Database, DrizzleTransaction } from "~/server/db";
import { storedDerivedDeclarations } from "~/server/db/derived-declarations";
import { loadStoredDerived } from "~/server/generic/derived/repo/read";

export interface SidecarRow {
  /** The internal id stored values are keyed by. */
  readonly internalId: string;
  /** The public id the response keys rows by. */
  readonly id: string;
  readonly fieldResolutions?: Readonly<Record<string, FieldResolution>> | null;
}

/** The level a field resolution decided at, in the envelope's vocabulary. */
export const resolutionDecidedBy = (resolution: FieldResolution): DecidedBy => {
  if (resolution.mode === "explicit" || resolution.mode === "none")
    return { level: "own" };
  if (resolution.sourceEntity)
    return {
      level: "inherited",
      source: {
        entity: resolution.sourceEntity.entityKind,
        id: resolution.sourceEntity.entityId,
        label: resolution.sourceEntity.name,
      },
    };
  return resolution.value === null
    ? { level: "unresolved" }
    : { level: "default", source: null };
};

/** One page's sidecar: stored fields from `DerivedValue`, inherited ones from resolutions. */
export async function loadDerivedSidecar(
  db: Database | DrizzleTransaction,
  entity: Entity,
  rows: readonly SidecarRow[],
): Promise<Record<string, DerivedSidecar>> {
  const keys = storedDerivedDeclarations()
    .filter((declaration) => declaration.entity === entity)
    .map((declaration) => declaration.key);
  const stored = keys.length
    ? await loadStoredDerived(
        db,
        entity,
        rows.map((row) => row.internalId),
        keys,
      )
    : new Map();
  const out: Record<string, DerivedSidecar> = {};
  for (const row of rows) {
    const sidecar: Record<string, DerivedMeta> = {};
    for (const [field, resolution] of Object.entries(
      row.fieldResolutions ?? {},
    ))
      sidecar[field] = {
        state: "fresh",
        decidedBy: resolutionDecidedBy(resolution),
        asOf: null,
      };
    for (const [key, read] of stored.get(row.internalId) ?? [])
      sidecar[key] = read.meta;
    if (Object.keys(sidecar).length > 0) out[row.id] = sidecar;
  }
  return out;
}
