import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { statementRowExternalId } from "../src/server/repo/statement-row-identity";

/**
 * Reconcile the stored ledger against the batch files it was built from.
 *
 * A stored row whose identity is absent from the source batches did not come
 * from any export — it is a fabricated statement line, which is worse than a
 * missing one because it reads as real evidence. This finds them (and anything
 * from the source that never landed) by recomputing every identity locally with
 * the same shipped hash the write path used.
 *
 * Read-only unless --delete is passed, which soft-deletes the extras.
 */

const arg = (name: string) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");
const DIR = arg("dir")!;
const DELETE = process.argv.includes("--delete");

async function main() {
  const expected = new Map<string, Set<string>>();
  for (const f of readdirSync(DIR).filter(
    (f) => f.endsWith(".json") && !f.startsWith("_"),
  )) {
    const payload = JSON.parse(readFileSync(join(DIR, f), "utf8"));
    const source: string = payload.import.source;
    if (!expected.has(source)) expected.set(source, new Set());
    for (const r of payload.rows) {
      expected.get(source)!.add(
        await statementRowExternalId({
          source,
          account: r.accountDescriptor,
          date: r.statementDate,
          amount: r.providerAmount,
          originalStatement: r.rawDescription,
        }),
      );
    }
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    for (const [source, ids] of expected) {
      const { rows } = await client.query<{
        externalId: string;
        accountDescriptor: string;
        statementDate: string;
        providerAmount: string;
        rawDescription: string;
      }>(
        `SELECT "externalId", "accountDescriptor", "statementDate"::text, "providerAmount"::text, "rawDescription"
         FROM "StatementRow" WHERE source = $1 AND "deletedAt" IS NULL`,
        [source],
      );
      const storedIds = new Set(rows.map((r) => r.externalId));
      const extra = rows.filter((r) => !ids.has(r.externalId));
      const missing = [...ids].filter((id) => !storedIds.has(id));
      console.log(
        `\n${source}: stored=${rows.length} expected=${ids.size} ` +
          `NOT-IN-SOURCE=${extra.length} MISSING=${missing.length}`,
      );
      for (const r of extra) {
        console.log(
          `  extra ${r.externalId.slice(0, 14)}… ${r.statementDate} ${r.providerAmount.padStart(10)} ` +
            `| ${r.accountDescriptor.slice(0, 26)} | ${r.rawDescription.slice(0, 46)}`,
        );
      }
      if (DELETE && extra.length > 0) {
        const res = await client.query(
          `UPDATE "StatementRow" SET "deletedAt" = now()
           WHERE source = $1 AND "externalId" = ANY($2::text[]) AND "deletedAt" IS NULL`,
          [source, extra.map((r) => r.externalId)],
        );
        console.log(`  soft-deleted ${res.rowCount}`);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
