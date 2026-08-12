import "dotenv/config";
import { readFileSync } from "node:fs";
import { Client } from "pg";

/**
 * Apply agent-judged dispositions to statement rows in bulk.
 *
 * Takes a plan of `{source, reason, note, externalIds}` groups — computed from
 * the provider exports, where the classification actually lives — and marks each
 * row `ignored`. That takes it off the drift worklist while keeping the evidence
 * and the reasoning, which is the whole point of dispositioning rather than
 * deleting.
 *
 * Only rows still `open` are touched, so this never overwrites a judgment
 * someone already made, and re-running it is a no-op.
 *
 * Usage:
 *   # 1. Review. This is the default — no flag writes anything.
 *   pnpm --filter @cubby/web exec tsx scripts/disposition-statement-rows.ts --plan=<file>
 *
 *   # 2. Write, naming the row count you reviewed. A mismatch aborts.
 *   pnpm --filter @cubby/web exec tsx scripts/disposition-statement-rows.ts \
 *     --plan=<file> --write --confirm-count=7146
 *
 * To undo a group, set its rows back to `open` — the CHECK constraint requires
 * reason and note to be NULL in that state, so clear all three together.
 */

type Group = {
  source: string;
  reason: string;
  note: string;
  externalIds: string[];
};

const arg = (name: string) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");
const PLAN = arg("plan");
const WRITE = process.argv.includes("--write");
const CONFIRM = arg("confirm-count") ? Number(arg("confirm-count")) : null;

if (!PLAN) {
  console.error("--plan=<dispositions.json> is required");
  process.exit(1);
}

async function main() {
  const plan = JSON.parse(readFileSync(PLAN!, "utf8")) as Group[];
  const total = plan.reduce((n, g) => n + g.externalIds.length, 0);
  for (const g of plan) {
    console.log(
      `${g.source.padEnd(9)} ${g.reason.padEnd(16)} ${String(g.externalIds.length).padStart(6)}`,
    );
  }
  console.log(`total ${total}`);

  if (!WRITE) {
    console.log(
      "\nDRY RUN — nothing written. Re-run with --write --confirm-count=<n>.",
    );
    return;
  }
  if (CONFIRM !== total) {
    console.error(
      `\nABORT: --confirm-count=${CONFIRM} does not match ${total}.`,
    );
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  let updated = 0;
  let absent = 0;
  try {
    for (const g of plan) {
      let groupUpdated = 0;
      for (let i = 0; i < g.externalIds.length; i += 1000) {
        const chunk = g.externalIds.slice(i, i + 1000);
        const res = await client.query(
          `UPDATE "StatementRow"
             SET disposition = 'ignored', "dispositionReason" = $1,
                 "dispositionNote" = $2, "updatedAt" = now()
           WHERE source = $3 AND "externalId" = ANY($4::text[])
             AND "deletedAt" IS NULL AND disposition = 'open'`,
          [g.reason, g.note, g.source, chunk],
        );
        groupUpdated += res.rowCount ?? 0;
      }
      // A plan id with no live open row is not an error: it may already carry a
      // judgment, or belong to an export that was never ingested.
      absent += g.externalIds.length - groupUpdated;
      updated += groupUpdated;
      console.log(
        `  ${g.source} ${g.reason}: updated ${groupUpdated} of ${g.externalIds.length}`,
      );
    }
  } finally {
    await client.end();
  }
  console.log(`\nupdated=${updated} not-open-or-absent=${absent}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
