import type { Entity } from "@cubby/schemas/entity-core";
import { sql } from "drizzle-orm";

import {
  repositoryQueries as unwrapDb,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { derivedRefreshPublication } from "~/server/db/retained-tables";

/** Call inside the output transaction; retain the row even for absent/deleted output. */
export async function claimDerivedPublication(
  db: RepositoryQueryInput,
  ref: { entityKind: Entity; entityId: string },
  phase: string,
  revision: number,
) {
  const rows = await unwrapDb(db)
    .insert(derivedRefreshPublication)
    .values({ ...ref, phase, revision })
    .onConflictDoUpdate({
      target: [
        derivedRefreshPublication.entityKind,
        derivedRefreshPublication.entityId,
        derivedRefreshPublication.phase,
      ],
      set: { revision },
      setWhere: sql`${derivedRefreshPublication.revision} <= ${revision}`,
    })
    .returning({ revision: derivedRefreshPublication.revision });
  return rows.length > 0;
}
