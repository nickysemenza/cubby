import { scoredEntities } from "@cubby/schemas/data-quality";
import { and, asc, count, gt, inArray, lte } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { entityIdentity } from "~/server/db/entity-identity-schema";
import { getDb } from "~/server/db/helpers";
import { recordChange } from "~/server/generic/changes/repo/change";
import { REFRESH_PAGE_SIZE } from "~/server/generic/derived-refresh/repo/families";

import { storedEntryFor } from "./entries";
import {
  changedQualityIds,
  prepareQualityPublications,
  publishQualityRows,
} from "./stored";

const cursor = z.object({ after: z.uuid().optional() });
const migratedKinds = () =>
  scoredEntities.filter((kind) => storedEntryFor(kind));
const sources = (boundary: string) =>
  and(
    inArray(entityIdentity.kind, migratedKinds()),
    lte(entityIdentity.createdAt, new Date(boundary)),
  );

/** Tombstones remain in the bounded pass so historical projections are retired too. */
export const qualityRefreshDriver = {
  count: async (db: Database, boundary: string) => {
    const [row] = await getDb(db)
      .select({ n: count() })
      .from(entityIdentity)
      .where(sources(boundary));
    return row?.n ?? 0;
  },
  page: async (
    db: Database,
    at: Record<string, string> | null,
    boundary: string,
  ) => {
    const { after } = cursor.parse(at ?? {});
    const refs = await getDb(db)
      .select({ id: entityIdentity.id, kind: entityIdentity.kind })
      .from(entityIdentity)
      .where(
        and(
          sources(boundary),
          after ? gt(entityIdentity.id, after) : undefined,
        ),
      )
      .orderBy(asc(entityIdentity.id))
      .limit(REFRESH_PAGE_SIZE);
    const ids = refs.map((ref) => ref.id);
    const prepare = async (readDb: Database) => {
      const rows = [];
      for (const kind of migratedKinds()) {
        const selected = refs
          .filter((ref) => ref.kind === kind)
          .map((ref) => ref.id);
        if (selected.length)
          rows.push(
            ...(await prepareQualityPublications(readDb, kind, selected)),
          );
      }
      return rows;
    };
    const prepared = await prepare(db);
    const changed = await changedQualityIds(db, ids, prepared);
    return {
      next:
        refs.length === REFRESH_PAGE_SIZE ? { after: refs.at(-1)!.id } : null,
      scanned: refs.length,
      pending: changed.length,
      publish: async (tx: Database) => {
        // The Job token/generation is checked by routine publication. Compare
        // the current inputs' verdicts too before publishing prepared output.
        if (JSON.stringify(await prepare(tx)) !== JSON.stringify(prepared))
          throw new Error("Quality inputs changed during preparation");
        await publishQualityRows(tx, ids, prepared);
        if (changed.length)
          await recordChange(tx, {
            kind: "projection",
            categories: migratedKinds(),
          });
        return { evaluated: prepared.length, changed: changed.length };
      },
    };
  },
};
