import { workQueueHouseholdInput } from "@cubby/schemas/work-queue";
import { expect, it } from "vitest";
import { getDb } from "~/server/db/helpers";
import { sql } from "drizzle-orm";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { readWorkQueue } from "~/server/generic/work-queue/service/work-queue-read";
import { withTestDb } from "../test-setup";
import { seedPerformanceCorpus } from "./performance";

// Failure modes: scale adds disconnected filler instead of kit/ledger fanout;
// historical Email work lacks retained evidence or a frozen Run roster; future
// ledger entries become current acquisitions; fixture writes dispatch providers.
// A small copy of the same graph verifies semantics without a timing threshold.
const ctx = withTestDb();
it("seeds connected performance history readable by the real Work queue", async () => {
  await insertWithShortcode(ctx.db, "ledgerParty", {
    kind: "member",
    name: "Synthetic performance member",
    userId: ctx.actor.userId,
  });
  await seedPerformanceCorpus(ctx.db, ctx.actor.userId, { bundles: 2 });
  const result = await getDb(ctx.db).execute(sql`SELECT
    (SELECT count(*)::int FROM "Product") AS products,
    (SELECT count(*)::int FROM "Expense") AS expenses,
    (SELECT count(*)::int FROM "Email") AS emails,
    (SELECT count(*)::int FROM "Run") AS runs,
    (SELECT count(*)::int FROM "EntityLink" WHERE kind = 'productComponent') AS kit_edges,
    (SELECT count(*)::int FROM "Expense" WHERE future) AS future_expenses,
    (SELECT count(*)::int FROM "Email" e JOIN "OrderMail" m ON e."orderMailId" = m.id WHERE m.content IS NOT NULL) AS retained_emails,
    (SELECT count(*)::int FROM "RunOperation" WHERE kind = 'target_outcome') AS outcomes,
    (SELECT count(*)::int FROM "ImageProcessingAttempt") AS dispatched_images`);
  expect(result.rows[0]).toMatchObject({
    products: 12,
    expenses: 24,
    emails: 16,
    runs: 10,
    kit_edges: 6,
    future_expenses: 2,
    retained_emails: 16,
    outcomes: 10,
    dispatched_images: 0,
  });
  const roster = await getDb(ctx.db).execute(sql`SELECT count(*)::int AS count
    FROM "Run" r JOIN "Email" e ON e."runId" = r.id
    WHERE r.input->'sources' @> jsonb_build_array(jsonb_build_object('orderMailId', e."orderMailId", 'checksum', e.checksum))`);
  expect(roster.rows[0]).toMatchObject({ count: 10 });
  const queue = await readWorkQueue(
    ctx.db,
    null,
    workQueueHouseholdInput.parse({ pageSize: 25 }),
    false,
  );
  expect(queue.items.length).toBeGreaterThan(0);
}, 120_000);
