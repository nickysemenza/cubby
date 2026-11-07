import { dataQuality } from "@cubby/schemas/data-quality";
import { workQueueInput } from "@cubby/schemas/work-queue";
import { expect, it } from "vitest";
import { getDb } from "~/server/db/helpers";
import { sql } from "drizzle-orm";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { readWorkQueue } from "~/server/domains/work/service/work-queue-read";
import { withTestDb } from "../test-setup";
import { seedPerformanceCorpus } from "./performance";
import { shipmentScaffold } from "~/server/domains/shipment/repo/entity-repository";
import { drainStoredDerived } from "~/server/testing/background-queue";
import { run } from "~/server/db/schema";
import { loadRunDetail } from "~/server/domains/purchase-import/repo/run-service";

// Failure modes: scale adds disconnected filler instead of kit/ledger fanout;
// historical Email work lacks retained evidence or a frozen Run roster; future
// ledger entries become current acquisitions; fixture writes dispatch providers.
// Receipt counts alone miss unmatched work keys: the actual Run projection must
// use the receipt's completion time instead of falling back to Email.updatedAt.
// A small copy of the same graph verifies semantics without a timing threshold.
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
  await seedPerformanceCorpus(ctx.db, ctx.actor.userId, { bundles: 2 });
  const roster = await getDb(ctx.db).execute<{
    count: number;
  }>(sql`SELECT count(*)::int AS count
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
  await drainStoredDerived(ctx.db);
  const parcels = await shipmentScaffold.read(ctx.db, {
    filters: { dataStatus: ["needs_data"] },
    sorts: [{ orderBy: "dataQuality", direction: "asc" }],
    pagination: { pageIndex: 0, pageSize: 25 },
    projection: ["dataQuality"],
  });
  expect(parcels.count).toBe(1);
  expect(dataQuality.parse(parcels.data[0]?.dataQuality).gaps).not.toEqual([]);
  const queue = await readWorkQueue(ctx.db, {
    input: workQueueInput.parse({ pageSize: 25 }),
    memberPartyId: null,
    memberOnly: false,
  });
  expect(queue.items.length).toBeGreaterThan(0);
}, 120_000);
