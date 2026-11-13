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
  // The earlier pending migration creates this source empty on a predecessor.
  const hasConnections = (
    await client.query(
      `SELECT to_regclass('public."ConnectionCandidateEvidence"') IS NOT NULL present`,
    )
  ).rows[0].present;
  const projection = hasConnections
    ? acceptedInputCutoverSelect()
    : acceptedInputCutoverSelect().replace(
        'FROM "ConnectionCandidateEvidence"',
        'FROM (SELECT NULL::text AS "scopeKey" WHERE false) "ConnectionCandidateEvidence"',
      );
  const result =
    await client.query(`WITH expected AS MATERIALIZED (${projection}),
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
    UNION ALL SELECT 'destination','total/'||k.mapping,count(DISTINCT CASE WHEN e.source_id IS NULL THEN NULL ELSE CASE k.mapping
      WHEN 'scope' THEN jsonb_build_array(e.row->'scopeKind',e.row->'scopeKey')::text
      WHEN 'askScope' THEN jsonb_build_array(e.row->'askId',e.row->'scopeKind',e.row->'scopeKey')::text
      WHEN 'recordKey' THEN jsonb_build_array(e.row->'scopeKind',e.row->'scopeKey',e.row->'entity',e.row->'naturalKey')::text
      WHEN 'binding' THEN jsonb_build_array(e.row->'factKind',e.row->'factId',e.row->'basis')::text
      WHEN 'answer' THEN e.row->>'inputHash' ELSE e.row->>'id' END END)::int
      FROM (VALUES ('recordKey'),('manualEntry'),('binding'),('scope'),('decision'),('ask'),('answer'),('askScope')) k(mapping)
      LEFT JOIN expected e ON e.mapping=k.mapping GROUP BY k.mapping
    UNION ALL SELECT 'verification',k.mapping,coalesce(f.n,0) FROM (VALUES ('recordKey'),('manualEntry'),('binding'),('scope'),('decision'),('ask'),('answer'),('askScope')) k(mapping) LEFT JOIN failures f ON f.mapping=k.mapping
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
