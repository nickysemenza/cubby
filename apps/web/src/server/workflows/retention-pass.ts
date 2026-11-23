import { sql } from "drizzle-orm";
import { z } from "zod";

import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { definePass } from "~/server/kernel/api";

const IMAGE_EVENT_PAGE_SIZE = 400;
const PASS_LIMIT = 2_000;
const imageEventPruneCursor = z.object({
  occurredAt: z.iso.datetime(),
  id: z.uuid(),
});

/** Prune expired execution history and keep answers, decisions, evidence, Run history, latest attempt receipts and unfinished work. */
export const retentionPass = definePass({
  name: "retention",
  async run(db, cursor) {
    const { repairImageProcessingExecution } =
      await import("~/server/domains/image-processing/repo/image-processing");
    const { readImageEventPrunePage, pruneImageProcessingEvents } =
      await import("~/server/domains/image-processing/repo/image-processing-history");
    const after = imageEventPruneCursor.safeParse(cursor).data ?? null;
    const page = await readImageEventPrunePage(
      db,
      after,
      IMAGE_EVENT_PAGE_SIZE,
    );
    return {
      cursor: page.next,
      done: false,
      availableAt: page.next ? undefined : new Date(Date.now() + 60 * 60_000),
      async publish(tx) {
        // A concurrent start may retain the old cursor. Replaying the range is safe.
        await repairImageProcessingExecution(tx, 500);
        await pruneImageProcessingEvents(tx, page.ids);
        await repositoryQueries(tx).execute(sql`
          WITH doomed AS (
            SELECT name, key FROM "Pass"
            WHERE ("doneAt" IS NOT NULL AND "updatedAt" < now() - interval '8 days')
              OR ("cancelledAt" IS NOT NULL AND "updatedAt" < now() - interval '14 days')
            LIMIT ${PASS_LIMIT} FOR UPDATE SKIP LOCKED
          ) DELETE FROM "Pass" p USING doomed d WHERE p.name = d.name AND p.key = d.key`);
      },
    };
  },
});
