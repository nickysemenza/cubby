import { auditLogEntryOut } from "@cubby/schemas/audit";
import { workQueueHouseholdInput } from "@cubby/schemas/work-queue";
import { expect, it } from "vitest";
import { getDb } from "~/server/db/helpers";
import { sql } from "drizzle-orm";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { readWorkQueue } from "~/server/generic/work-queue/service/work-queue-read";
import { countTestDbQueries, withTestDb } from "../test-setup";
import { seedPerformanceCorpus } from "./performance";
import { run } from "~/server/db/schema";
import { loadRunDetail } from "~/server/domains/purchase-import/repo/run-service";

// Failure modes: scale adds disconnected filler instead of kit/ledger fanout;
// historical Email work lacks retained evidence or a frozen Run roster; future
// ledger entries become current acquisitions; fixture writes dispatch providers.
// Receipt counts alone miss unmatched work keys: the actual Run projection must
// use the receipt's completion time instead of falling back to Email.updatedAt.
// A small copy of the same graph verifies semantics without a timing threshold.
// Volume setup must batch stored rows and canonical projections instead of
// paying interactive reads and side effects once per record.
// Narrow originals hide out-of-line reads; volume must include wide text,
// HTML-only originals and cleared content, not just more tiny rows. Clearing
// must preserve each admitted source fingerprint rather than hashing emptiness.
const ctx = withTestDb();
it("seeds connected performance history readable by the real Work queue", async () => {
  await insertWithShortcode(ctx.db, "ledgerParty", {
    kind: "member",
    name: "Synthetic performance member",
    userId: ctx.actor.userId,
  });
  const seeded = await countTestDbQueries(() =>
    seedPerformanceCorpus(ctx.db, ctx.actor.userId, { bundles: 2 }),
  );
  const result = await getDb(ctx.db).execute(sql`SELECT
    (SELECT count(*)::int FROM "Product") AS products,
    (SELECT count(*)::int FROM "Expense") AS expenses,
    (SELECT count(*)::int FROM "Email") AS emails,
    (SELECT count(*)::int FROM "Run") AS runs,
    (SELECT count(*)::int FROM "EntityLink" WHERE kind = 'productComponent') AS kit_edges,
    (SELECT count(*)::int FROM "Expense" WHERE future) AS future_expenses,
    (SELECT count(*)::int FROM "Email" e JOIN "OrderMail" m ON e."orderMailId" = m.id WHERE m.content IS NOT NULL) AS original_records,
    (SELECT count(*)::int FROM "OrderMail" WHERE GREATEST(COALESCE(octet_length(content->>'bodyText'),0),COALESCE(octet_length(content->>'bodyHtml'),0)) >= 32768) AS wide_originals,
    (SELECT count(*)::int FROM "OrderMail" WHERE content->>'snippet' IS NULL AND content->>'bodyText' IS NOT NULL) AS body_only_originals,
    (SELECT count(*)::int FROM "OrderMail" WHERE content->>'bodyText' IS NULL AND content->>'bodyHtml' IS NOT NULL) AS html_only_originals,
    (SELECT count(*)::int FROM "OrderMail" WHERE COALESCE(NULLIF(BTRIM(content->>'snippet'),''),NULLIF(BTRIM(content->>'bodyText'),''),NULLIF(BTRIM(content->>'bodyHtml'),'')) IS NULL) AS cleared_originals,
    (SELECT count(DISTINCT "rawChecksum")::int FROM "OrderMail") AS source_fingerprints,
    (SELECT count(*)::int FROM "Email" WHERE "contentClearedAt" IS NOT NULL) AS cleared_markers,
    (SELECT count(*)::int FROM "RunOperation" WHERE kind = 'target_outcome') AS outcomes,
    (SELECT count(*)::int FROM "ImageProcessingAttempt") AS dispatched_images,
    (SELECT count(*)::int FROM "SearchDocument") AS searchable,
    (SELECT count(*)::int FROM "AuditLog" WHERE action = ${auditLogEntryOut.shape.action.enum.create}) AS created_audits,
    (SELECT sum(cost)::int FROM "Expense") AS cost`);
  expect(result.rows[0]).toMatchObject({
    products: 12,
    expenses: 24,
    emails: 16,
    runs: 10,
    kit_edges: 6,
    future_expenses: 2,
    original_records: 16,
    wide_originals: 12,
    body_only_originals: 4,
    html_only_originals: 4,
    cleared_originals: 4,
    source_fingerprints: 16,
    cleared_markers: 4,
    outcomes: 10,
    dispatched_images: 0,
    searchable: 44,
    created_audits: 44,
    cost: 200,
  });
  const roster = await getDb(ctx.db).execute(sql`SELECT count(*)::int AS count
    FROM "Run" r JOIN "Email" e ON e."runId" = r.id
    JOIN "OrderMail" m ON m.id=e."orderMailId" AND m."rawChecksum"=e.checksum
    WHERE r.input->'sources' @> jsonb_build_array(jsonb_build_object('orderMailId', e."orderMailId", 'checksum', e.checksum))`);
  expect(roster.rows[0]).toMatchObject({ count: 10 });
  const [historical] = await getDb(ctx.db)
    .select({ shortcode: run.shortcode })
    .from(run)
    .limit(1);
  if (!historical) throw new Error("Missing historical fixture Run");
  expect((await loadRunDetail(ctx.db, historical.shortcode)).targets).toEqual([
    expect.objectContaining({
      state: "completed",
      outcome: "verified",
      completedAt: "2026-01-15T12:01:00.000Z",
    }),
  ]);
  const queue = await readWorkQueue(
    ctx.db,
    null,
    workQueueHouseholdInput.parse({ pageSize: 25 }),
    false,
  );
  expect(queue.items.length).toBeGreaterThan(0);
  expect(seeded.queryCount).toBeLessThan(100);
}, 120_000);
