import { entitySchema } from "@cubby/schemas/entity";
import { inArray } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { externalSource } from "~/server/db/schema";

import { getDb } from "./database-helpers";
import { identityShortcodes } from "./entity-identity";

type Json = z.infer<ReturnType<typeof z.json>>;

function identityCandidate(value: string) {
  if (z.uuid().safeParse(value).success)
    return { id: value.toLowerCase(), kind: null };
  const match = /^([a-zA-Z][a-zA-Z-]*)-([0-9a-f-]{36})$/i.exec(value);
  if (!match) return null;
  const kind = entitySchema.safeParse(match[1]);
  const id = z.uuid().safeParse(match[2]);
  return kind.success && id.success
    ? { id: id.data.toLowerCase(), kind: kind.data }
    : null;
}

function mapStrings(
  value: Json,
  map: (value: string, property?: string) => string,
  property?: string,
): Json {
  const text = z.string().safeParse(value);
  if (text.success) return map(text.data, property);
  if (Array.isArray(value))
    return value.map((item) => mapStrings(item, map, property));
  const record = z.record(z.string(), z.json()).safeParse(value);
  if (record.success)
    return Object.fromEntries(
      Object.entries(record.data).map(([key, item]) => [
        key,
        mapStrings(item, map, key),
      ]),
    );
  return value;
}

/** Link presentation only: raw evidence still owns interpretation and fingerprints.
 * Source ownership comes from the registry; a slug's spelling is not authority.
 * External identifier values, arbitrary row ids and unowned source slugs remain literal. */
export async function explanationReferenceValues(
  db: Database,
  values: Json[],
): Promise<Json[]> {
  const ids = new Set<string>();
  const sourceSlugs = new Set<string>();
  for (const value of values)
    mapStrings(value, (text, property) => {
      if (property === "externalId") return text;
      if (property === "source") {
        sourceSlugs.add(text);
        return text;
      }
      const candidate = identityCandidate(text);
      if (candidate) ids.add(candidate.id);
      return text;
    });
  const registrations =
    sourceSlugs.size > 0
      ? await getDb(db)
          .select({
            slug: externalSource.slug,
            vendorId: externalSource.vendorId,
          })
          .from(externalSource)
          .where(inArray(externalSource.slug, [...sourceSlugs]))
      : [];
  const sourceOwners = new Map(
    registrations.map((source) => [source.slug, source.vendorId]),
  );
  for (const source of registrations)
    if (source.vendorId) ids.add(source.vendorId);
  const identities = await identityShortcodes(db, [...ids]);
  return values.map((value) =>
    mapStrings(value, (text, property) => {
      if (property === "externalId") return text;
      const sourceOwner = property === "source" ? sourceOwners.get(text) : null;
      const candidate =
        property === "source"
          ? sourceOwner
            ? { id: sourceOwner, kind: "vendor" }
            : null
          : identityCandidate(text);
      if (!candidate) return text;
      const identity = identities.get(candidate.id);
      if (
        !identity ||
        (candidate.kind !== null && candidate.kind !== identity.kind)
      )
        return text;
      return identity.canonicalShortcode ?? identity.shortcode ?? text;
    }),
  );
}
