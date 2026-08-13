import "dotenv/config";
import { buildActorContext } from "@cubby/schemas/context";
import {
  unsafeFinancialTransactionShortcode,
  unsafeUserId,
} from "@cubby/schemas/identifiers";
import { db } from "../src/server/db";
import { getDb } from "../src/server/repo/database-helpers";
import {
  getFinancialTransactionByShortcode,
  updateFinancialTransaction,
} from "../src/server/repo/financial-transaction";

/**
 * Close statement rows that are unmatched only because their source ref was
 * never a content hash.
 *
 * Copilot's stored refs were hand-minted in ad-hoc formats, so a charge already
 * reconciled in Cubby still reads as drift: the ledger row hashes to an
 * identity no transaction carries. This appends that identity to the
 * transaction the charge already has, after which the row derives as `matched`
 * with no write to the row itself.
 *
 * It goes through `updateFinancialTransaction` rather than a raw UPDATE, so the
 * append is validated, audited, and passes `assertSourceRefsAvailable` — the
 * global uniqueness guarantee the ledger's whole join depends on. A one-off
 * script is the documented exception for a backfill too large to carry through
 * a model (2,052 read-merge-writes); forking the write path is not.
 *
 * A pair is only proposed when BOTH hold, because either alone is a coin flip
 * on common amounts:
 *   - exactly one live transaction has the same cents within ±5 days, and
 *   - the statement merchant and the transaction merchant corroborate
 *     (pg_trgm similarity >= --min-similarity).
 * Generic descriptors are excluded outright: several $8,000 rows named "Check"
 * would pair on amount and date alone and could pair the wrong two.
 *
 * Usage:
 *   # 1. Review. This is the default — no flag writes anything.
 *   pnpm --filter @cubby/web exec tsx scripts/backfill-statement-source-refs.ts
 *
 *   # 2. Write, naming the pair count you reviewed. A mismatch aborts.
 *   pnpm --filter @cubby/web exec tsx scripts/backfill-statement-source-refs.ts \
 *     --write --confirm-count=2052
 */

const arg = (name: string) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");
const WRITE = process.argv.includes("--write");
const SOURCE = arg("source") ?? "copilot";
const MIN_SIM = Number(arg("min-similarity") ?? "0.35");
const CONFIRM = arg("confirm-count") ? Number(arg("confirm-count")) : null;
const ACTOR = buildActorContext(
  unsafeUserId("7OqBNriPzksqDu0aKnM6pL26EoTMyXGM"),
  "script:backfill-statement-source-refs",
);

const GENERIC = [
  "check",
  "cashed check",
  "zelle",
  "withdrawal",
  "transfer",
  "deposit",
  "payment",
  "venmo",
  "wire",
  "atm",
  "cash",
];

type Pair = {
  externalId: string;
  shortcode: string;
  merchant: string;
  txnMerchant: string;
};

async function findPairs(): Promise<Pair[]> {
  const { rows } = await getDb(db).execute<Pair>(`
    WITH work AS (
      SELECT sr."externalId", sr.merchant, sr.amount, sr."statementDate"
      FROM "StatementRow" sr
      WHERE sr."deletedAt" IS NULL AND sr.disposition = 'open'
        AND sr.source = '${SOURCE}' AND sr.amount > 0 AND sr.merchant IS NOT NULL
        AND lower(sr.merchant) NOT IN (${GENERIC.map((g) => `'${g}'`).join(",")})
        AND NOT EXISTS (
          SELECT 1 FROM "FinancialTransaction" ft
          WHERE ft."deletedAt" IS NULL
            AND ft."sourceRefs" @> jsonb_build_array(
                  jsonb_build_object('source', sr.source, 'externalId', sr."externalId")))
    )
    SELECT w."externalId", c.shortcode, w.merchant, c.txn_merchant AS "txnMerchant"
    FROM work w
    CROSS JOIN LATERAL (
      SELECT ft.shortcode, ft.merchant AS txn_merchant,
             similarity(lower(w.merchant), lower(COALESCE(ft.merchant, ''))) AS sim,
             count(*) OVER () AS n
      FROM "FinancialTransaction" ft
      WHERE ft."deletedAt" IS NULL
        AND round(ft.amount::numeric, 2) = round(w.amount::numeric, 2)
        AND COALESCE(ft."postedDate", ft."transactionDate")
            BETWEEN w."statementDate"::date - 5 AND w."statementDate"::date + 5
      LIMIT 2
    ) c
    WHERE c.n = 1 AND c.sim >= ${MIN_SIM}
  `);
  return rows;
}

async function main() {
  const candidates = await findPairs();

  // The pairing must be one-to-one in BOTH directions. `findPairs` already
  // requires a statement row to have exactly one candidate transaction; this
  // drops the reverse case, where several rows point at the same transaction.
  // Those are real and common — four separate $0.01 Amazon rows, two same-day
  // $16.36 Prime charges — and appending all of them would assert that one card
  // line was several statement lines. Which row is the true one cannot be
  // decided from amount and date, so none of them is claimed.
  const claims = new Map<string, number>();
  for (const p of candidates)
    claims.set(p.shortcode, (claims.get(p.shortcode) ?? 0) + 1);
  const pairs = candidates.filter((p) => claims.get(p.shortcode) === 1);
  const contested = candidates.length - pairs.length;

  const byTxn = new Map<string, Pair[]>();
  for (const p of pairs) {
    if (!byTxn.has(p.shortcode)) byTxn.set(p.shortcode, []);
    byTxn.get(p.shortcode)!.push(p);
  }
  console.log(
    `${pairs.length} one-to-one pairs (source=${SOURCE}, min-similarity=${MIN_SIM}); ` +
      `${contested} skipped as contested`,
  );
  for (const p of pairs.slice(0, 5)) {
    console.log(`  ${p.shortcode}  ${p.merchant}  ->  ${p.txnMerchant}`);
  }

  if (!WRITE) {
    console.log(
      "\nDRY RUN — nothing written. Re-run with --write --confirm-count=<n>.",
    );
    return;
  }
  if (CONFIRM !== pairs.length) {
    console.error(
      `\nABORT: --confirm-count=${CONFIRM} does not match ${pairs.length}.`,
    );
    process.exit(1);
  }

  let updated = 0;
  let failed = 0;
  for (const [shortcode, group] of byTxn) {
    try {
      const code = unsafeFinancialTransactionShortcode(shortcode);
      const existing = await getFinancialTransactionByShortcode(db, code);
      if (!existing) {
        failed += 1;
        continue;
      }
      // Read–merge–write: sourceRefs replaces the whole array on update, so a
      // blind set would discard whatever evidence the transaction already had.
      const merged = [
        ...existing.sourceRefs,
        ...group
          .filter(
            (p) =>
              !existing.sourceRefs.some(
                (r) => r.source === SOURCE && r.externalId === p.externalId,
              ),
          )
          .map((p) => ({ source: SOURCE, externalId: p.externalId })),
      ];
      if (merged.length === existing.sourceRefs.length) continue;
      await updateFinancialTransaction(db, code, { sourceRefs: merged }, ACTOR);
      updated += 1;
      if (updated % 100 === 0)
        process.stdout.write(`\r  updated ${updated}   `);
    } catch (error) {
      failed += 1;
      console.error(`\n  ${shortcode}: ${(error as Error).message}`);
    }
  }
  console.log(`\ntransactions updated=${updated} failed=${failed}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
