import type { DerivedSidecar } from "@cubby/schemas/derived-value";
import type { Entity } from "@cubby/schemas/entity";
import { fieldResolutionsSchema } from "@cubby/schemas/field-resolution";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  derivedSidecarOf,
  loadPageStoredMeta,
  type PageStoredMeta,
  resolutionDecidedBy,
} from "~/server/generic/derived/repo/sidecar";

const identitySchema = z.object({ id: z.string(), shortcode: z.string() });
const resolvedRowSchema = z.object({
  id: z.string(),
  fieldResolutions: fieldResolutionsSchema.nullish(),
});

/** Start stored metadata alongside page hydration, while storage identities are still available. */
export async function withPageDerived<Row>(
  db: Database | DrizzleTransaction,
  entity: Entity,
  rows: readonly unknown[],
  hydrate: () => Promise<Row[]> | Row[],
  /** The page's stored meta, when the caller started it with the page ids. */
  started?: Promise<PageStoredMeta>,
): Promise<{ data: Row[]; derived: Record<string, DerivedSidecar> }> {
  const identities = rows.map((row) => {
    const identity = identitySchema.parse(row);
    const resolutions = resolvedRowSchema.parse(row);
    return {
      internalId: identity.id,
      id: identity.shortcode,
      fieldResolutions: resolutions.fieldResolutions,
    };
  });
  const [data, stored] = await Promise.all([
    hydrate(),
    started ??
      loadPageStoredMeta(
        db,
        entity,
        identities.map((identity) => identity.internalId),
      ),
  ]);
  const derived = derivedSidecarOf(identities, stored);
  // Inheritance bindings can add resolutions during hydration. Merge their pure
  // provenance after both loads, preserving stored state for cached fields.
  for (const row of data) {
    const resolved = resolvedRowSchema.parse(row);
    for (const [field, resolution] of Object.entries(
      resolved.fieldResolutions ?? {},
    )) {
      const sidecar = (derived[resolved.id] ??= {});
      sidecar[field] ??= {
        state: "fresh",
        decidedBy: resolutionDecidedBy(resolution),
        asOf: null,
      };
    }
  }
  return { data, derived };
}
