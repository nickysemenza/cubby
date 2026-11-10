import type { Entity } from "@cubby/schemas/entity";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { z } from "zod";

import { entityStoredDerivedDeclarations } from "~/server/db/derived-declarations";
import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";
import { loadCurrentAssignmentFacts } from "~/server/generic/derived/repo/assignment-read";
import {
  loadStoredDerived,
  type PageStoredMeta,
} from "~/server/generic/derived/repo/read";
import type {
  CurrentReadFacts,
  CurrentFieldOwnership,
  StoredDerivedRead,
  PageFieldReadContexts,
} from "~/server/generic/derived/repo/read-context";
import {
  compileReadDemand,
  type ReadDemand,
} from "~/server/generic/list/repo/read-demand";
import { loadCurrentFieldOwnership } from "~/server/generic/suggestions/repo/automatic-fields";

const identitySchema = z.object({ id: z.string(), shortcode: z.string() });
const rowValues = z.record(z.string(), z.unknown());

/** Start stored metadata alongside page hydration, while storage identities are still available. */
export async function withPageFields<Row>(
  db: RepositoryQueryInput,
  entity: Entity,
  rows: readonly unknown[],
  hydrate: () => Promise<Row[]> | Row[],
  {
    stored: started,
    ownership: startedOwnership,
    projection,
    demand: suppliedDemand,
  }: {
    /** The page's stored meta, when the caller started it with the page ids. */
    stored?: Promise<PageStoredMeta>;
    ownership?: ReturnType<typeof loadCurrentFieldOwnership>;
    projection?: readonly string[];
    demand?: ReadDemand;
  } = {},
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
  const demand = suppliedDemand ?? compileReadDemand(entity, projection);
  const shortcodeEntity = z.enum(shortcodeEntities).safeParse(entity);
  const [data, storedRows, ownership, assignments] = await Promise.all([
    hydrate(),
    demand.facts
      ? (started ?? loadStoredDerived(db, entity, ids, demand.facts.stored))
      : Promise.resolve(
          new Map<string, ReadonlyMap<string, StoredDerivedRead>>(),
        ),
    demand.facts && demand.facts.ownership.length
      ? (startedOwnership ??
        loadCurrentFieldOwnership(db, entity, ids, demand.facts.ownership))
      : Promise.resolve(new Map<string, CurrentFieldOwnership>()),
    demand.facts && shortcodeEntity.success
      ? loadCurrentAssignmentFacts(
          db,
          shortcodeEntity.data,
          ids,
          new Map(
            identities.map((identity) => [identity.internalId, identity.raw]),
          ),
          demand.facts.assignments,
        )
      : Promise.resolve(new Map<string, CurrentReadFacts>()),
  ]);
  for (const id of ids)
    for (const key of demand.facts?.stored ?? [])
      if (!storedRows.get(id)?.has(key))
        throw new Error(`Stored field was not loaded: ${entity}.${key}`);
  let stored = storedRows;
  const recordPublications = entityStoredDerivedDeclarations().filter(
    (declaration) =>
      declaration.entity === entity &&
      declaration.recordSource !== null &&
      demand.facts?.stored.includes(declaration.key),
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
          covered: demand.envelope,
          raw: { ...identity.raw, ...assignments.get(identity.internalId) },
          stored: stored.get(identity.internalId) ?? new Map(),
          ownership: ownership.get(identity.internalId) ?? {},
        },
      ]),
    ),
  };
}
