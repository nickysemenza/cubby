import { Client } from "pg";
import { acceptedInputCutoverSelect } from "./accepted-input-cutover-select";

/** No environment fallback: the caller supplies an isolated read-only copy URL. */
const url = process.argv[2];
if (!url || process.argv.length !== 3)
  throw new Error(
    "Usage: pnpm --dir apps/web exec tsx tooling/inspect-accepted-input-cutover.ts <database-url>",
  );
const client = new Client({
  connectionString: url,
  application_name: "cubby-cutover-inspect",
});
try {
  await client.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout='120s'");
  const result =
    await client.query(`WITH expected AS MATERIALIZED (${acceptedInputCutoverSelect()}),
    failures AS (
      SELECT mapping,count(*) FILTER(WHERE
        CASE mapping
          WHEN 'recordKey' THEN row->>'entityId' IS NULL OR row->>'scopeKey' IS NULL
          WHEN 'manualEntry' THEN row->'payload' IS NULL OR row->>'id' IS NULL
          WHEN 'binding' THEN row->>'scopeKey' IS NULL OR row->>'factId' IS NULL
          WHEN 'scope' THEN row->>'scopeKey' IS NULL
          WHEN 'decision' THEN row->>'subject' IS NULL OR row->>'at' IS NULL
          WHEN 'ask' THEN row->>'id' IS NULL OR row->>'state' NOT IN ('queued','answered','unknown')
          WHEN 'answer' THEN row->>'inputHash' IS NULL OR row->'output' IS NULL
          WHEN 'askScope' THEN row->>'scopeKey' IS NULL OR NOT EXISTS(SELECT 1 FROM expected a WHERE a.mapping='ask' AND a.row->>'id'=expected.row->>'askId')
        END)::int n FROM expected GROUP BY mapping
    )
    SELECT 'destination' category,mapping||'/'||split_part(source_id,':',1) mapping,count(*)::int rows FROM expected GROUP BY 2
    UNION ALL SELECT 'verification',mapping,n FROM failures
    UNION ALL SELECT 'verification','audit preimage',count(*) FILTER(WHERE id IS NULL)::int FROM "AuditLog"
    UNION ALL SELECT 'verification','evaluation preimage',count(*) FILTER(WHERE id IS NULL)::int FROM "AiEvaluation"
    UNION ALL SELECT 'verification','requester preimage',count(*) FILTER(WHERE id IS NULL)::int FROM "AiEvaluationRequest"
    UNION ALL SELECT 'verification','money row',count(*)::int FROM expected WHERE mapping='manualEntry' AND row->'payload'->>'table' IN ('Expense','Purchase','FinancialTransaction','LedgerTransfer','FinancialTransactionAllocation') AND NOT (row->'payload' ? 'values')
    UNION ALL SELECT 'verification','money totals',count(*)::int FROM expected WHERE mapping='manualEntry' AND row->'payload'->>'table' IN ('Expense','Purchase','FinancialTransaction','LedgerTransfer','FinancialTransactionAllocation') AND row->'payload'->>'naturalKey' IS NULL
    UNION ALL SELECT 'authority','member-held',count(*)::int FROM expected WHERE mapping='decision' AND row->>'id' LIKE 'ffffffff%'
    UNION ALL SELECT 'authority','Cubby-held',count(*)::int FROM expected WHERE mapping='answer' AND row->>'feature'='legacy:field'
    ORDER BY category,mapping`);
  // Deliberately emit only aggregate labels/counts, never source ids, values or credentials.
  process.stdout.write(`${JSON.stringify(result.rows, null, 2)}\n`);
  await client.query("ROLLBACK");
} catch {
  process.stderr.write(
    "Cutover inspection failed; no data or credentials were printed. Check copy schema, read-only access and server diagnostics.\n",
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
