import type { ScoredEntity } from "@cubby/schemas/data-quality";

import type { Database } from "~/server/db";
import { unwrapDb, withTransaction } from "~/server/db/helpers";
import { dataQualityEntries } from "~/server/generic/data-quality/repo/entries";
import {
  prepareQualityPublications,
  publishQualityRows,
} from "~/server/generic/data-quality/repo/stored";
import { REFRESH_PAGE_SIZE } from "~/server/generic/derived-refresh/repo/families";

/** Explicit publication for read-contract fixtures, including deliberately raw input edits. */
export async function publishQualityFixtures(db: Database, kind: ScoredEntity) {
  const table = dataQualityEntries[kind].table;
  const rows = await unwrapDb(db).select({ id: table.id }).from(table);
  for (let index = 0; index < rows.length; index += REFRESH_PAGE_SIZE) {
    const ids = rows
      .slice(index, index + REFRESH_PAGE_SIZE)
      .map((row) => row.id);
    await withTransaction(db, async (tx) => {
      await publishQualityRows(
        tx,
        ids,
        await prepareQualityPublications(tx, kind, ids),
      );
    });
  }
}
