import type { Entity } from "@cubby/schemas/entity";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { z } from "zod";

import { storedDerivedDeclarations } from "~/server/db/derived-declarations";
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
  const [data, storedRows, ownership, assignments] = await Promise.all([
    hydrate(),
    started ?? loadPageStoredMeta(db, entity, ids),
    startedOwnership ?? loadCurrentFieldOwnership(db, entity, ids),
    shortcodeEntity.success
      ? loadCurrentAssignmentFacts(db, shortcodeEntity.data, ids)
      : Promise.resolve(new Map<string, CurrentReadFacts>()),
  ]);
  let stored = storedRows;
  const recordPublications = storedDerivedDeclarations().filter(
    (declaration) =>
      declaration.entity === entity && declaration.recordSource !== null,
  );
  if (recordPublications.length > 0) {
    const publications = new Map(storedRows);
    for (const identity of identities) {
      const values = new Map(storedRows.get(identity.internalId));
      for (const declaration of recordPublications) {
        const source = declaration.recordSource;
        if (
          !source ||
          !Object.hasOwn(identity.raw, source.value) ||
          !Object.hasOwn(identity.raw, source.computedAt)
        )
          continue;
        const stamp = identity.raw[source.computedAt];
        const computedAt =
          stamp == null ? null : z.coerce.date().parse(stamp).toISOString();
        const value = identity.raw[source.value];
        const work = values.get(declaration.key);
        // The payload and its timestamp come from the same base SELECT. Hydrated
        // projections still need the existing version witness before using them.
        values.set(declaration.key, {
          value,
          computedAt,
          resultExists: computedAt !== null,
          decision: {
            outcome:
              value == null
                ? { kind: "empty", reason: "unset" }
                : { kind: "value", value },
            provenance: { kind: "computed" },
          },
          stale:
            (work?.stale ?? false) ||
            (source.freshAt !== undefined &&
              identity.raw[source.freshAt] == null),
          pending: work?.pending ?? false,
          error: work?.error ?? null,
          retryAt: work?.retryAt ?? null,
        });
      }
      publications.set(identity.internalId, values);
    }
    stored = publications;
  }
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
