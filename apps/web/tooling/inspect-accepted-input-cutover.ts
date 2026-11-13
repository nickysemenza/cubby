import { Client } from "pg";
import { acceptedInputCutoverSelect } from "./accepted-input-cutover-select";

/** No environment fallback: the caller supplies an isolated read-only copy URL. */
const url = process.argv[2];
if (!url || process.argv.length !== 3)
  throw new Error(
    "Usage: pnpm --dir apps/web exec tsx tooling/inspect-accepted-input-cutover.ts <database-url>",
  );
let client: Client | undefined;
try {
  client = new Client({
    connectionString: url,
    application_name: "cubby-cutover-inspect",
  });
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
    money AS (
      SELECT 'Expense'::text source,id,"purchaseId" owner,date_trunc('month',date)::date month_key,"costMinor" amount FROM "Expense"
      UNION ALL SELECT 'Purchase',id,id,date_trunc('month',date)::date,"statedTotalMinor" FROM "Purchase"
      UNION ALL SELECT 'FinancialTransaction',id,NULL,date_trunc('month',"transactionDate")::date,"amountMinor" FROM "FinancialTransaction"
      UNION ALL SELECT 'FinancialTransactionAllocation',id,"purchaseId",NULL,"amountMinor" FROM "FinancialTransactionAllocation"
    ), money_copy AS (
      SELECT DISTINCT ON (m.source,m.id) m.*, (CASE m.source WHEN 'Expense' THEN e.row->'payload'->'values'->>'cost' WHEN 'Purchase' THEN e.row->'payload'->'values'->>'statedTotal' ELSE coalesce(e.row->'payload'->'values'->>'amountMinor',e.row->'payload'->'values'->>'amount') END)::numeric copied
      FROM money m LEFT JOIN expected e ON e.mapping='manualEntry' AND e.row->'payload'->>'table'=m.source AND e.row->'payload'->>'naturalKey'='legacy:'||m.id
    ), failures AS (
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
    UNION ALL SELECT 'destination','archive/AuditLog_authority_preimage',count(*)::int FROM "AuditLog"
    UNION ALL SELECT 'destination','archive/AiEvaluation_preimage',count(*)::int FROM "AiEvaluation"
    UNION ALL SELECT 'destination','archive/AiEvaluationRequest_preimage',count(*)::int FROM "AiEvaluationRequest"
    UNION ALL SELECT 'verification','audit preimage',count(*) FILTER(WHERE id IS NULL)::int FROM "AuditLog"
    UNION ALL SELECT 'verification','evaluation preimage',count(*) FILTER(WHERE id IS NULL)::int FROM "AiEvaluation"
    UNION ALL SELECT 'verification','requester preimage',count(*) FILTER(WHERE id IS NULL)::int FROM "AiEvaluationRequest"
    UNION ALL SELECT 'verification','money row',count(*)::int FROM money_copy WHERE amount::numeric IS DISTINCT FROM copied
    UNION ALL SELECT 'verification','money totals',count(*)::int FROM (
      SELECT 1 FROM money_copy GROUP BY GROUPING SETS ((source),(source,owner),(source,month_key)) HAVING sum(amount) IS DISTINCT FROM sum(copied)
    ) totals
    UNION ALL SELECT 'verification','audit count',count(*) FILTER(WHERE id IS NULL)::int FROM "AuditLog"
    UNION ALL SELECT 'verification','evaluation count',count(*) FILTER(WHERE id IS NULL)::int FROM "AiEvaluation"
    UNION ALL SELECT 'verification','requester count',count(*) FILTER(WHERE id IS NULL)::int FROM "AiEvaluationRequest"
    UNION ALL SELECT 'verification','accepted occurrence',count(*)::int FROM "SourceOccurrence" o
      WHERE o."deletedAt" IS NULL AND o."withdrawnAt" IS NULL AND o."supersededByOccurrenceId" IS NULL AND o.disposition<>'ignored' AND o."acceptedTransactionId" IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM expected e WHERE e.mapping='recordKey' AND e.row->>'scopeKind'='bankEvent' AND e.row->>'scopeKey'=o.id::text AND e.row->>'entity'='financialTransaction' AND e.row->>'naturalKey'='legacy:'||o."acceptedTransactionId")
    UNION ALL SELECT 'identity','transactions with multiple accepting occurrences',count(*)::int FROM
      (SELECT "acceptedTransactionId" FROM "SourceOccurrence" WHERE "deletedAt" IS NULL AND "withdrawnAt" IS NULL AND "supersededByOccurrenceId" IS NULL AND disposition<>'ignored' AND "acceptedTransactionId" IS NOT NULL GROUP BY "acceptedTransactionId" HAVING count(*)>1) multiple
    UNION ALL SELECT 'identity','occurrences left unbound',count(*)::int FROM "SourceOccurrence" o
      WHERE o."deletedAt" IS NULL AND o."withdrawnAt" IS NULL AND o."supersededByOccurrenceId" IS NULL AND o.disposition<>'ignored' AND o."acceptedTransactionId" IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM expected e WHERE e.mapping='recordKey' AND e.row->>'scopeKind'='bankEvent' AND e.row->>'scopeKey'=o.id::text AND e.row->>'entity'='financialTransaction' AND e.row->>'naturalKey'='legacy:'||o."acceptedTransactionId")
    UNION ALL SELECT 'ask-state',CASE WHEN row->>'cancelledAt' IS NOT NULL THEN 'cancelled' ELSE row->>'state' END,count(*)::int FROM (SELECT DISTINCT ON (row->>'id') row FROM expected WHERE mapping='ask') planned GROUP BY 2
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
  await client?.end();
}
