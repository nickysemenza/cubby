import {
  derivedSidecar,
  type DerivedMeta,
  type DerivedSidecar,
  type DecidedBy,
} from "@cubby/schemas/derived-value";
import {
  fieldResolutionsSchema,
  type FieldResolution,
} from "@cubby/schemas/field-resolution";
import { z } from "zod";

const recordMeta = z.object({
  derived: derivedSidecar.optional(),
  fieldResolutions: fieldResolutionsSchema.optional(),
});

/** Transitional read adapter; a supplied envelope always wins over live resolution metadata. */
export function resolutionDecidedBy(resolution: FieldResolution): DecidedBy {
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
}

export function derivedMetaFor(
  record: unknown,
  field: string,
  pageSidecar?: DerivedSidecar,
): DerivedMeta | undefined {
  const parsed = recordMeta.safeParse(record);
  if (!parsed.success) return undefined;
  const { derived, fieldResolutions } = parsed.data;
  const keys = [field, `${field}Id`];
  // An inspector's record read may be newer than the page it opened from.
  for (const key of keys) if (derived?.[key]) return derived[key];
  for (const key of keys) if (pageSidecar?.[key]) return pageSidecar[key];
  for (const key of keys) {
    const resolution = fieldResolutions?.[key];
    if (resolution)
      return {
        state: "fresh",
        decidedBy: resolutionDecidedBy(resolution),
        asOf: null,
      };
  }
  return undefined;
}
