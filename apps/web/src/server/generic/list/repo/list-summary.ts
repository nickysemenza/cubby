import { listGroupMetricSchema } from "@cubby/schemas/pagination";
import { createLogger } from "@cubby/worker-tracing";
import { and, eq, lt, or, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { afterResponse } from "~/server/cf-env";
import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers/core";
import { listSummary } from "~/server/db/retained-tables";
import { sha256CanonicalJson } from "~/server/lib/canonical-json";

const log = createLogger("list-summary");

/**
 * A read after this age republishes, which bounds writes that bypass
 * `recordChange`; recorded commits mark publications dirty instead.
 */
const LIST_SUMMARY_MAX_AGE_MS = 10 * 60_000;
/** A population nobody has read for this long is dropped at the next publish. */
const LIST_SUMMARY_RETENTION = "7 days";

const listSummaryValueSchema = z.object({
  totals: z
    .object({
      sums: z.record(z.string(), z.number()),
      incompleteSums: z.array(z.string()),
    })
    .optional(),
  metrics: z.record(z.string(), listGroupMetricSchema).optional(),
  viewCounts: z
    .object({
      total: z.number(),
      views: z.array(
        z.object({
          id: z.string(),
          count: z.number(),
          unresolvedCount: z.number().optional(),
        }),
      ),
    })
    .optional(),
});
export type ListSummaryValue = z.infer<typeof listSummaryValueSchema>;

type Db = Database | DrizzleTransaction;

/** The population inputs: the summary kind, the list's filters (with scope, or the saved views) and its reader. */
export const listSummaryKey = (input: {
  summary: "metrics" | "totals" | "viewCounts";
  filters: object;
  reader: string;
}) => sha256CanonicalJson(JSON.parse(JSON.stringify(input)));

/** A member write committed after this publication: its totals must show it. */
const dirty = (row: { publishedAt: Date; dirtyAt: Date | null }) =>
  row.dirtyAt !== null && row.dirtyAt > row.publishedAt;

/** Past its age: background-only changes may have landed since. */
const aged = (row: { publishedAt: Date }, now = new Date()) =>
  now.getTime() - row.publishedAt.getTime() > LIST_SUMMARY_MAX_AGE_MS;

/**
 * Store a computed summary unless a newer publication already landed. A write
 * that committed after `publishedAt` stays dirty and is read next time.
 */
async function storeListSummary(
  db: Db,
  input: { entity: string; key: string; publishedAt: Date },
  summary: ListSummaryValue,
) {
  await unwrapDb(db)
    .insert(listSummary)
    .values({ ...input, summary })
    .onConflictDoUpdate({
      target: [listSummary.entity, listSummary.key],
      set: {
        summary,
        publishedAt: input.publishedAt,
        dirtyAt: sql`CASE WHEN ${listSummary.dirtyAt} > ${input.publishedAt} THEN ${listSummary.dirtyAt} END`,
      },
      setWhere: sql`${listSummary.publishedAt} <= ${input.publishedAt}`,
    });
  await unwrapDb(db)
    .delete(listSummary)
    .where(
      sql`${listSummary.publishedAt} < now() - interval '${sql.raw(LIST_SUMMARY_RETENTION)}'`,
    );
}

/**
 * Whole-population totals and metrics for a list page, read from the last
 * publication. A commit since that publication computes live, so the next
 * read shows it; a publication past its age is still served and
 * replaced after the response as a tracked `waitUntil` task. A live read
 * publishes after the response.
 */
export async function readPublishedListSummary(
  db: Db,
  input: { entity: string; key: string },
  compute: () => Promise<ListSummaryValue>,
): Promise<ListSummaryValue> {
  const [row] = await unwrapDb(db)
    .select({
      summary: listSummary.summary,
      publishedAt: listSummary.publishedAt,
      dirtyAt: listSummary.dirtyAt,
    })
    .from(listSummary)
    .where(
      and(eq(listSummary.entity, input.entity), eq(listSummary.key, input.key)),
    );
  if (row && !dirty(row)) {
    if (aged(row))
      await afterResponse(
        (async () => {
          const publishedAt = new Date();
          await storeListSummary(
            db,
            { ...input, publishedAt },
            await compute(),
          );
        })().catch((error: unknown) => {
          // SILENT: the previous summary keeps serving; the next read retries.
          log.error("list summary republish failed", { error });
        }),
      );
    return listSummaryValueSchema.parse(row.summary);
  }
  const publishedAt = new Date();
  const value = await compute();
  await afterResponse(
    storeListSummary(db, { ...input, publishedAt }, value).catch(
      (error: unknown) => {
        // SILENT: this read already answered live; the next read publishes.
        log.error("list summary publish failed", { error });
      },
    ),
  );
  return value;
}

/** Any committed change: every published population computes live next time. */
export async function markListSummariesDirty(db: Database): Promise<void> {
  const now = new Date();
  await unwrapDb(db)
    .update(listSummary)
    .set({ dirtyAt: now })
    .where(or(isNull(listSummary.dirtyAt), lt(listSummary.dirtyAt, now)));
}
