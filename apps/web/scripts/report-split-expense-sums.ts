import "dotenv/config";
import {
  RECONCILIATION_TOLERANCE,
  reconcilePurchase,
} from "@cubby/schemas/purchase";
import { Client } from "pg";
import { postedRefundTotalSql } from "../src/server/repo/financial-reconciliation";

/**
 * Read-only partition of `purchasesNotReconciling` (the Problems detector at
 * `findPurchasesNotReconciling`) by cause: for each mismatching Purchase, was a
 * `split_expense` involved, and if so, did its parts sum to what they
 * replaced? Performs no writes and proposes no fix — a `splitExpense` mismatch
 * is a deliberate, undocumented-in-DB feature (see its doc comment in
 * `repo/purchase.ts`), not a bug to correct; this only tells a human which of
 * the current mismatches are explained by one.
 *
 * ## How a "split group" is identified
 *
 * `splitExpense` soft-deletes the original Expense and inserts its parts in
 * ONE transaction, writing every audit entry (the parts' `create`s and the
 * original's `delete`) through a SINGLE `logAuditEntries` batch insert
 * (`repo/audit-log.ts`). Postgres's `now()` — what `AuditLog.createdAt`
 * defaults to — is frozen for the whole transaction, so every row in that
 * batch carries the IDENTICAL `createdAt` down to the microsecond. That
 * (`userId`, `createdAt`) pair is therefore a reliable fingerprint for "one
 * `splitExpense` call": this script joins a `delete` audit entry to every
 * `create` entry sharing it.
 *
 * This is a heuristic, not a foreign key — flag it if it ever looks wrong:
 *   - A part later merged, hard-deleted (never happens — soft delete is
 *     permanent), or itself re-split would no longer be live, so it drops out
 *     of `partsSum` silently. `partCount` vs `originalPartCount is not tracked
 *     separately here — a low part count on an old split is worth a manual
 *     check against the audit log directly.
 *   - Two DIFFERENT splits by the same actor in the exact same transaction
 *     instant would merge into one group — not ruled out here, just unlikely
 *     for a single-user, one-request-at-a-time tool. A group whose `parts`
 *     don't visibly belong together (different names/products entirely) is
 *     the tell; treat it as two groups when reviewing.
 *
 * Usage:
 *   pnpm --filter @cubby/web db:report-split-sums
 *   pnpm --filter @cubby/web db:report-split-sums -- --limit=25
 */

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required to report split-expense sums.");
  process.exit(1);
}

const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const parsedLimit = limitArg
  ? Number.parseInt(limitArg.slice("--limit=".length), 10)
  : 50;
if (!Number.isInteger(parsedLimit) || parsedLimit < 0 || parsedLimit > 500) {
  console.error("--limit must be a whole number from 0 to 500.");
  process.exit(1);
}

type MismatchRow = {
  purchaseUuid: string;
  purchaseId: string;
  vendorName: string | null;
  orderId: string | null;
  date: string;
  statedTotal: number;
  expenseTotal: number;
  unpricedExpenseCount: number;
  postedRefundTotal: number;
};

type SplitGroupRow = {
  purchaseUuid: string;
  deletedExpenseId: string;
  originalShortcode: string;
  originalName: string;
  originalCost: number;
  partCount: number;
  partsSum: number;
  parts: { shortcode: string; name: string; cost: number | null }[];
};

const centsOf = (dollars: number) => Math.round(dollars * 100);

const client = new Client({ connectionString: databaseUrl });

try {
  await client.connect();
  await client.query("BEGIN READ ONLY");

  // Same shape as `findPurchasesNotReconciling` — the SQL side computes the
  // grouped sums, `reconcilePurchase` (imported, not restated) applies the
  // exact same verdict so this always agrees with what Problems currently
  // shows, including the `refund_adjusted` carve-out.
  const mismatchRes = await client.query<MismatchRow>(
    `
      SELECT
        p."id" AS "purchaseUuid",
        p."shortcode" AS "purchaseId",
        v."name" AS "vendorName",
        p."orderId" AS "orderId",
        p."date"::text AS "date",
        p."statedTotal" AS "statedTotal",
        COALESCE(sum(e."cost"), 0) AS "expenseTotal",
        count(e.id) FILTER (WHERE e."cost" IS NULL)::int AS "unpricedExpenseCount",
        ${postedRefundTotalSql("p")} AS "postedRefundTotal"
      FROM "Purchase" p
      LEFT JOIN "Vendor" v
        ON v."id" = p."vendorId" AND v."deletedAt" IS NULL
      LEFT JOIN "Expense" e
        ON e."purchaseId" = p."id" AND e."deletedAt" IS NULL
      WHERE p."deletedAt" IS NULL AND p."statedTotal" IS NOT NULL
      GROUP BY p."id", v."name"
      HAVING abs(p."statedTotal" - COALESCE(sum(e."cost"), 0)) > $1
      ORDER BY abs(p."statedTotal" - COALESCE(sum(e."cost"), 0)) DESC
    `,
    [RECONCILIATION_TOLERANCE],
  );

  const mismatches = mismatchRes.rows.filter(
    (row) =>
      reconcilePurchase({
        statedTotal: row.statedTotal,
        expenseTotal: row.expenseTotal,
        unpricedExpenseCount: row.unpricedExpenseCount,
        postedRefundTotal: row.postedRefundTotal,
      }) === "mismatch",
  );

  const purchaseUuids = mismatches.map((row) => row.purchaseUuid);

  const groupsRes = purchaseUuids.length
    ? await client.query<SplitGroupRow>(
        `
          WITH deletes AS (
            SELECT
              e."id" AS "deletedExpenseId",
              e."purchaseId" AS "purchaseUuid",
              e."shortcode" AS "originalShortcode",
              e."name" AS "originalName",
              e."cost" AS "originalCost",
              al."userId" AS "actorId",
              al."createdAt" AS "batchAt"
            FROM "Expense" e
            JOIN "AuditLog" al
              ON al."entityType" = 'expense'
             AND al."entityId" = e."id"
             AND al."action" = 'delete'
            -- includes-deleted: the whole point is to read what a split
            -- soft-deleted, since that is "what the parts replaced".
            WHERE e."deletedAt" IS NOT NULL
              AND e."purchaseId" = ANY($1::uuid[])
          ),
          parts AS (
            SELECT
              d."deletedExpenseId",
              d."purchaseUuid",
              d."originalShortcode",
              d."originalName",
              d."originalCost",
              e2."shortcode" AS "partShortcode",
              e2."name" AS "partName",
              e2."cost" AS "partCost"
            FROM deletes d
            JOIN "AuditLog" al2
              ON al2."entityType" = 'expense'
             AND al2."action" = 'create'
             AND al2."userId" = d."actorId"
             AND al2."createdAt" = d."batchAt"
            JOIN "Expense" e2
              ON e2."id" = al2."entityId"
             AND e2."deletedAt" IS NULL
          )
          SELECT
            "purchaseUuid",
            "deletedExpenseId",
            "originalShortcode",
            "originalName",
            "originalCost",
            count(*)::int AS "partCount",
            COALESCE(sum("partCost"), 0) AS "partsSum",
            json_agg(
              json_build_object(
                'shortcode', "partShortcode",
                'name', "partName",
                'cost', "partCost"
              )
              ORDER BY "partShortcode"
            ) AS "parts"
          FROM parts
          GROUP BY "purchaseUuid", "deletedExpenseId", "originalShortcode", "originalName", "originalCost"
          ORDER BY "purchaseUuid", "originalShortcode"
        `,
        [purchaseUuids],
      )
    : { rows: [] as SplitGroupRow[] };

  const groupsByPurchase = new Map<string, SplitGroupRow[]>();
  for (const group of groupsRes.rows) {
    const list = groupsByPurchase.get(group.purchaseUuid) ?? [];
    list.push(group);
    groupsByPurchase.set(group.purchaseUuid, list);
  }

  const partitioned = mismatches.map((row) => {
    const groups = groupsByPurchase.get(row.purchaseUuid) ?? [];
    const groupDeltas = groups.map((group) => ({
      ...group,
      deltaCents: centsOf(group.partsSum) - centsOf(group.originalCost),
    }));
    const driftingGroups = groupDeltas.filter(
      (group) => group.deltaCents !== 0,
    );
    const cause: "split_drift" | "split_clean" | "no_split_found" =
      driftingGroups.length > 0
        ? "split_drift"
        : groups.length > 0
          ? "split_clean"
          : "no_split_found";
    return {
      purchaseId: row.purchaseId,
      vendorName: row.vendorName,
      orderId: row.orderId,
      date: row.date,
      statedTotal: row.statedTotal,
      expenseTotal: row.expenseTotal,
      gap: Math.round((row.expenseTotal - row.statedTotal) * 100) / 100,
      cause,
      splitGroups: groupDeltas.map((group) => ({
        originalExpenseId: group.originalShortcode,
        originalName: group.originalName,
        originalCost: group.originalCost,
        partCount: group.partCount,
        partsSum: Math.round(group.partsSum * 100) / 100,
        delta: group.deltaCents / 100,
        parts: group.parts,
      })),
    };
  });

  const summary = {
    mismatchingPurchases: partitioned.length,
    splitDrift: partitioned.filter((p) => p.cause === "split_drift").length,
    splitClean: partitioned.filter((p) => p.cause === "split_clean").length,
    noSplitFound: partitioned.filter((p) => p.cause === "no_split_found")
      .length,
  };

  await client.query("ROLLBACK");
  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        readOnly: true,
        summary,
        // The interesting rows for a human to review first: mismatches a
        // split can actually explain. `splitClean`/`noSplitFound` rows are
        // still in `partitioned` below the limit, for completeness.
        splitDrift: partitioned
          .filter((p) => p.cause === "split_drift")
          .slice(0, parsedLimit),
        partitioned: partitioned.slice(0, parsedLimit),
      },
      null,
      2,
    ),
  );
} finally {
  await client.end();
}
