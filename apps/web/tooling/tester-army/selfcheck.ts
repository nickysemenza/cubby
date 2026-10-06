import { assertDatabase, JourneyIds, type DbCheck } from "./journey";

/**
 * Deterministic proof, with no model call, that a journey's read-back bites:
 * the matching expectation passes, a deliberately wrong one (`wrong = true`)
 * fails, and a changed value fails. Run through a disposable Postgres:
 * `node scripts/test-services.ts -- pnpm --dir apps/web exec tsx tooling/tester-army/selfcheck.ts`
 */
process.env.TESTER_ARMY_DB_TIMEOUT_MS = "400";
// test-services hands over the database host it started (a container
// address on macOS); localhost only holds where the port is published.
process.env.DATABASE_URL ??= `postgresql://postgres:password@${process.env.INTEGRESQL_DATABASE_HOST ?? "localhost"}:${process.env.INTEGRESQL_DATABASE_PORT ?? "5432"}/cubby`;
const ids = new JourneyIds({ code: "X-1" }, "selfcheck");
const check = (value: number): DbCheck => ({
  label: "constant row",
  sql: `SELECT $1::text AS code, 3::float8 AS amount`,
  params: (known) => [known.get("code")],
  rows: (known) => [{ code: known.get("code"), amount: value }],
});

async function refuses(run: () => Promise<void>, label: string) {
  try {
    await run();
  } catch {
    console.log(`[selfcheck] ${label}: failed as required`);
    return;
  }
  throw new Error(`[selfcheck] ${label}: did not fail`);
}

await assertDatabase({ id: "selfcheck" }, [check(3)], ids, false);
console.log("[selfcheck] matching expectation: passed");
await refuses(
  () => assertDatabase({ id: "selfcheck" }, [check(3)], ids, true),
  "deliberately wrong expectation (--wrong)",
);
await refuses(
  () => assertDatabase({ id: "selfcheck" }, [check(4)], ids, false),
  "changed value",
);
