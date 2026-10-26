import type { Entity } from "@cubby/schemas/entity";
import {
  detailBreadcrumbSchema,
  type DetailBreadcrumb,
} from "@cubby/schemas/entity-detail-summary";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { eq } from "drizzle-orm";
import { z } from "zod";

import {
  readDisplayReferenceField,
  readRecordField,
} from "~/entity/entity-references";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { location } from "~/server/db/schema";
import { loadLocationAncestorsWithIds } from "~/server/domains/location/repo/tree";

const placementSchema = z.object({ locationId: z.string() }).nullable();

/** A location and the locations above it, outermost first. */
async function locationBreadcrumb(
  db: Database,
  shortcode: string,
): Promise<DetailBreadcrumb> {
  // Deleted rows stay in the walk, matching `loadLocationAncestorsWithIds`.
  const [row] = await getDb(db)
    .select({ id: location.id, name: location.name })
    .from(location)
    .where(eq(location.shortcode, shortcode))
    .limit(1);
  if (row === undefined) return [];
  const ancestors =
    (await loadLocationAncestorsWithIds(db, [row.id])).get(row.id) ?? [];
  return [
    ...ancestors.map((rung) => ({
      entity: "location",
      id: rung.id,
      name: rung.name,
    })),
    { entity: "location", id: shortcode, name: row.name },
  ];
}

/**
 * The detail read's `breadcrumb`, projected from the declared
 * `hero.breadcrumb` field: a location (or placement) yields its ancestry,
 * any other reference the one record. `undefined` when none is declared; a
 * repository that already projected one (Product's placement) keeps it.
 */
export async function detailBreadcrumb<TRecord extends object>(
  db: Database,
  entity: Entity,
  item: TRecord,
): Promise<DetailBreadcrumb | undefined> {
  const key = entitySummary[entity].detail.hero.breadcrumb;
  if (key === null) return undefined;
  const projected = readRecordField(
    item,
    "breadcrumb",
    detailBreadcrumbSchema.optional(),
  );
  if (projected !== undefined) return projected;
  const field = entityFieldModels[entity].fields.find(
    (candidate) => candidate.key === key,
  );
  if (field === undefined) return [];
  if (field.reference === null) {
    const placement =
      field.readKey === null
        ? null
        : readRecordField(item, field.readKey, placementSchema.optional());
    return placement == null
      ? []
      : locationBreadcrumb(db, placement.locationId);
  }
  const [target] = readDisplayReferenceField(item, field)?.items ?? [];
  if (target === undefined) return [];
  if (field.reference.entity === "location")
    return locationBreadcrumb(db, target.id);
  return [
    {
      entity: field.reference.entity,
      id: target.id,
      name: target.name ?? target.id,
    },
  ];
}
