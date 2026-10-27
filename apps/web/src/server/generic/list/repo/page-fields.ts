import type { Entity } from "@cubby/schemas/entity";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { z } from "zod";

import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";
import { loadCurrentFieldOwnership } from "~/server/generic/assessment/repo/automatic-fields";
import { loadCurrentAssignmentFacts } from "~/server/generic/derived/repo/assignment-read";
import {
  loadPageStoredMeta,
  type PageStoredMeta,
} from "~/server/generic/derived/repo/read";
import type {
  CurrentReadFacts,
  PageFieldReadContexts,
} from "~/server/generic/derived/repo/read-context";

const identitySchema = z.object({ id: z.string(), shortcode: z.string() });
const rowValues = z.record(z.string(), z.unknown());

/** Start stored metadata alongside page hydration, while storage identities are still available. */
export async function withPageFields<Row>(
  db: RepositoryQueryInput,
  entity: Entity,
  rows: readonly unknown[],
  hydrate: () => Promise<Row[]> | Row[],
  /** The page's stored meta, when the caller started it with the page ids. */
  started?: Promise<PageStoredMeta>,
  startedOwnership?: ReturnType<typeof loadCurrentFieldOwnership>,
): Promise<{ data: Row[]; fieldReads: PageFieldReadContexts }> {
  const identities = rows.map((row) => {
    const identity = identitySchema.parse(row);
    return {
      internalId: identity.id,
      id: identity.shortcode,
      raw: rowValues.parse(row),
    };
  });
  const ids = identities.map((identity) => identity.internalId);
  const shortcodeEntity = z.enum(shortcodeEntities).safeParse(entity);
  const [data, stored, ownership, assignments] = await Promise.all([
    hydrate(),
    started ?? loadPageStoredMeta(db, entity, ids),
    startedOwnership ?? loadCurrentFieldOwnership(db, entity, ids),
    shortcodeEntity.success
      ? loadCurrentAssignmentFacts(db, shortcodeEntity.data, ids)
      : Promise.resolve(new Map<string, CurrentReadFacts>()),
  ]);
  return {
    data,
    fieldReads: new Map(
      identities.map((identity) => [
        identity.id,
        {
          raw: { ...identity.raw, ...assignments.get(identity.internalId) },
          stored: stored.get(identity.internalId) ?? new Map(),
          ownership: ownership.get(identity.internalId) ?? {},
        },
      ]),
    ),
  };
}
