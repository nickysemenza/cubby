import "dotenv/config";
import type { ExpenseLineKind } from "@cubby/schemas/expense-line-kind";
import { Client } from "pg";
import {
  type ExpenseLineKindBackfillRow,
  planExpenseLineKindBackfill,
} from "../src/server/repo/expense/line-kind-backfill";

/**
 * Audited, idempotent rollout for historical productless adjustment rows.
 *
 * Dry-run is the default and prints every high-confidence candidate plus every
 * ambiguous name hint:
 *   pnpm --filter @cubby/web db:backfill-expense-line-kind
 *
 * Applying requires an explicit existing Cubby user for AuditLog ownership:
 *   pnpm --filter @cubby/web db:backfill-expense-line-kind -- --apply --user-id=...
 */

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const apply = process.argv.includes("--apply");
const userId = process.argv
  .find((arg) => arg.startsWith("--user-id="))
  ?.slice("--user-id=".length);
if (apply && !userId) {
  console.error("--apply requires --user-id=<existing Cubby user id>.");
  process.exit(1);
}

type QueryRow = ExpenseLineKindBackfillRow & {
  cost: number | null;
  date: string | null;
  purchaseId: string | null;
  vendor: string | null;
  orderId: string | null;
};

const client = new Client({ connectionString: databaseUrl });

try {
  await client.connect();
  await client.query(apply ? "BEGIN" : "BEGIN READ ONLY");
  if (apply) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('cubby:expense-line-kind-backfill'))",
    );
    const foundUser = await client.query(
      'SELECT 1 FROM "user" WHERE "id" = $1 LIMIT 1',
      [userId],
    );
    if (foundUser.rowCount !== 1) {
      throw new Error(`Audit user does not exist: ${userId}`);
    }
  }

  const rows = (
    await client.query<QueryRow>(`
      SELECT
        e."id",
        e."shortcode",
        e."name",
        e."lineKind",
        e."productId",
        e."deletedAt",
        e."cost"::float8 AS "cost",
        e."date",
        pu."shortcode" AS "purchaseId",
        v."name" AS "vendor",
        pu."orderId"
      FROM "Expense" e
      LEFT JOIN "Purchase" pu
        ON pu."id" = e."purchaseId"
       AND pu."deletedAt" IS NULL
      LEFT JOIN "Vendor" v
        ON v."id" = pu."vendorId"
       AND v."deletedAt" IS NULL
      ORDER BY e."shortcode"
    `)
  ).rows;
  const plan = planExpenseLineKindBackfill(rows);
  const detailsById = new Map(rows.map((row) => [row.id, row]));
  const candidates = plan.candidates.map((candidate) => {
    const detail = detailsById.get(candidate.id);
    return {
      expenseId: candidate.shortcode,
      name: candidate.name,
      from: candidate.from,
      to: candidate.to,
      cost: detail?.cost ?? null,
      date: detail?.date ?? null,
      purchaseId: detail?.purchaseId ?? null,
      vendor: detail?.vendor ?? null,
      orderId: detail?.orderId ?? null,
    };
  });

  if (!apply) {
    await client.query("ROLLBACK");
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          dryRun: true,
          summary: {
            candidates: candidates.length,
            ambiguous: plan.ambiguous.length,
            unchanged: plan.unchanged.length,
            skipped: plan.skipped.length,
          },
          candidates,
          ambiguous: plan.ambiguous,
        },
        null,
        2,
      ),
    );
  } else {
    const updated: Array<{
      expenseId: string;
      lineKind: Exclude<ExpenseLineKind, "principal">;
    }> = [];
    for (const candidate of plan.candidates) {
      const result = await client.query<{ shortcode: string }>(
        `
          UPDATE "Expense"
          SET "lineKind" = $2, "updatedAt" = now()
          WHERE "id" = $1
            AND "deletedAt" IS NULL
            AND "productId" IS NULL
            AND "lineKind" = 'principal'
          RETURNING "shortcode"
        `,
        [candidate.id, candidate.to],
      );
      const shortcode = result.rows[0]?.shortcode;
      if (!shortcode) continue;

      await client.query(
        `
          INSERT INTO "AuditLog"
            ("entityType", "entityId", "action", "changes", "userId", "source")
          VALUES ('expense', $1, 'update', $2::jsonb, $3, 'script:expense-line-kind-backfill')
        `,
        [
          candidate.id,
          JSON.stringify({
            lineKind: { from: "principal", to: candidate.to },
          }),
          userId,
        ],
      );
      updated.push({ expenseId: shortcode, lineKind: candidate.to });
    }

    await client.query("COMMIT");
    console.log(
      JSON.stringify(
        {
          completedAt: new Date().toISOString(),
          dryRun: false,
          planned: candidates.length,
          updated: updated.length,
          rows: updated,
          ambiguous: plan.ambiguous,
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
