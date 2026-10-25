import { automaticFieldValues } from "@cubby/schemas/derived-value";
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
import {
  loadStoredDerived,
  type StoredDerivedRead,
} from "~/server/generic/derived/repo/read";

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

export type PageStoredMeta = ReadonlyMap<
  string,
  ReadonlyMap<string, StoredDerivedRead>
>;

/**
 * The stored values with per-row meta for a page, keyed by internal id. Sink
 * values (search documents, recipe totals) have no `DerivedValue` row. Lists
 * start this as soon as page ids are known, beside the row load.
 */
export function loadPageStoredMeta(
  db: Database | DrizzleTransaction,
  entity: Entity,
  internalIds: readonly string[],
): Promise<PageStoredMeta> {
  const keys = storedDerivedDeclarations()
    .filter(
      (declaration) =>
        declaration.entity === entity && declaration.publishes === "value",
    )
    .map((declaration) => declaration.key);
  return keys.length
    ? loadStoredDerived(db, entity, internalIds, keys)
    : Promise.resolve(new Map());
}

/** One page's sidecar: stored fields from `DerivedValue`, inherited ones from resolutions. */
export function derivedSidecarOf(
  rows: readonly SidecarRow[],
  stored: PageStoredMeta,
) {
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
    for (const [key, read] of stored.get(row.internalId) ?? []) {
      if (key === "automaticFields") {
        for (const [field, { confidence }] of Object.entries(
          automaticFieldValues.parse(read.value ?? {}),
        ))
          sidecar[field] = {
            ...read.meta,
            decidedBy: { level: "suggested", auto: true, confidence },
          };
      } else sidecar[key] = read.meta;
    }
    if (Object.keys(sidecar).length > 0) out[row.id] = sidecar;
  }
  return out;
}
