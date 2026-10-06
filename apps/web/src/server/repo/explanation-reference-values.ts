import { entitySchema } from "@cubby/schemas/entity";
import { z } from "zod";

import type { Database } from "~/server/db";

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

function mapStrings(value: Json, map: (value: string) => string): Json {
  const text = z.string().safeParse(value);
  if (text.success) return map(text.data);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map));
  const record = z.record(z.string(), z.json()).safeParse(value);
  if (record.success)
    return Object.fromEntries(
      Object.entries(record.data).map(([key, item]) => [
        key,
        mapStrings(item, map),
      ]),
    );
  return value;
}

/** Link presentation only: raw evidence still owns interpretation and fingerprints.
 * One batch resolves registered identities; arbitrary row ids and source slugs
 * remain literal rather than acquiring a guessed entity route. */
export async function explanationReferenceValues(
  db: Database,
  values: Json[],
): Promise<Json[]> {
  const ids = new Set<string>();
  for (const value of values)
    mapStrings(value, (text) => {
      const candidate = identityCandidate(text);
      if (candidate) ids.add(candidate.id);
      return text;
    });
  const identities = await identityShortcodes(db, [...ids]);
  return values.map((value) =>
    mapStrings(value, (text) => {
      const candidate = identityCandidate(text);
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
