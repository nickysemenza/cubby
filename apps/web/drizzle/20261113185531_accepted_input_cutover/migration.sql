-- Accepted inputs and retained producer results. Ordinary runner transaction: copy,
-- verification and contraction are atomic. Acquire every lock before the first read.
SET LOCAL lock_timeout='2s';
--> statement-breakpoint
-- Tables later altered or dropped, and the tables their dropped foreign keys reference.
LOCK TABLE "AiEvaluation", "AiEvaluationRequest", "AuditLog", "EmailClassificationObservation", "Run", "Suggestion" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "AiAnalysis", "Answer", "Ask", "AskScope", "ConnectionCandidateEvidence", "Cookbook", "Decision", "Device", "Entity", "EvidenceBinding", "Expense", "ExpenseAttribution", "FactKey", "FinancialAccount", "FinancialTransaction", "FinancialTransactionAllocation", "GardenEntry", "Location", "ManualEntry", "Meal", "Planting", "Product", "ProductCategory", "Project", "Purchase", "RecordKey", "ScopeDirty", "ScopeState", "SourceOccurrence", "SourceTransactionRecord", "SpendingCategory", "Task", "Vendor" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TEMP TABLE cutover_money ON COMMIT DROP AS
SELECT 'Expense'::text source, id, "purchaseId" owner, date_trunc('month',date)::date month_key,"costMinor" amount FROM "Expense"
UNION ALL SELECT 'Purchase',id,id,date_trunc('month',date)::date,"statedTotalMinor" FROM "Purchase"
UNION ALL SELECT 'FinancialTransaction',id,NULL,date_trunc('month',"transactionDate")::date,"amountMinor" FROM "FinancialTransaction"
UNION ALL SELECT 'FinancialTransactionAllocation',id,"purchaseId",NULL,"amountMinor" FROM "FinancialTransactionAllocation";
--> statement-breakpoint
CREATE TEMP TABLE cutover_money_totals ON COMMIT DROP AS
 SELECT source,CASE WHEN grouping(owner)=0 THEN 'purchase' WHEN grouping(month_key)=0 THEN 'month' ELSE 'overall' END bucket,owner,month_key,count(*) n,sum(amount)::numeric amount
 FROM cutover_money GROUP BY GROUPING SETS ((source),(source,owner),(source,month_key));
--> statement-breakpoint
CREATE TEMP TABLE cutover_expected ON COMMIT DROP AS
-- cutover:select:start
WITH RECURSIVE redirects AS (
 SELECT id,kind,"mergedIntoId" target, ARRAY[id] path FROM "Entity" WHERE "mergedIntoId" IS NOT NULL
 UNION ALL SELECT r.id,r.kind,e."mergedIntoId",r.path||e.id FROM redirects r JOIN "Entity" e ON e.id=r.target WHERE e."mergedIntoId" IS NOT NULL AND NOT e.id=ANY(r.path)
), survivors AS (SELECT r.id,r.kind,r.target FROM redirects r JOIN "Entity" e ON e.id=r.target WHERE e."mergedIntoId" IS NULL), records AS (
-- Every asked field of every fields plan; a plan that asks none still gets its scope.
SELECT 'product'::text entity, 'Product'::text table_name, 'fields'::text scope_kind, 'product:' || r.id::text scope_key, r.id, to_jsonb(r) payload, ARRAY['tags','brandId','categoryId','ingredientId','growsPlantId']::text[] fields FROM "Product" r
UNION ALL
SELECT 'cookbook'::text entity, 'Cookbook'::text table_name, 'fields'::text scope_kind, 'cookbook:' || r.id::text scope_key, r.id, to_jsonb(r) payload, ARRAY['productId']::text[] fields FROM "Cookbook" r
UNION ALL
SELECT 'location'::text entity, 'Location'::text table_name, 'fields'::text scope_kind, 'location:' || r.id::text scope_key, r.id, jsonb_build_object('deletedAt',r."deletedAt") payload, ARRAY[]::text[] fields FROM "Location" r
UNION ALL
SELECT 'meal'::text entity, 'Meal'::text table_name, 'fields'::text scope_kind, 'meal:' || r.id::text scope_key, r.id, to_jsonb(r) payload, ARRAY['mealType','mealKind']::text[] fields FROM "Meal" r
UNION ALL
SELECT 'project'::text entity, 'Project'::text table_name, 'fields'::text scope_kind, 'project:' || r.id::text scope_key, r.id, to_jsonb(r) payload, ARRAY['emoji','kind','defaultTrade']::text[] fields FROM "Project" r
UNION ALL
SELECT 'task'::text entity, 'Task'::text table_name, 'fields'::text scope_kind, 'task:' || r.id::text scope_key, r.id, to_jsonb(r) payload, ARRAY['trade']::text[] fields FROM "Task" r
UNION ALL
SELECT 'vendor'::text entity, 'Vendor'::text table_name, 'fields'::text scope_kind, 'vendor:' || r.id::text scope_key, r.id, to_jsonb(r) payload, ARRAY['itemizationExpectation']::text[] fields FROM "Vendor" r
UNION ALL
SELECT 'financialAccount'::text entity, 'FinancialAccount'::text table_name, 'fields'::text scope_kind, 'financialAccount:' || r.id::text scope_key, r.id, to_jsonb(r) payload, ARRAY['providerVendorId']::text[] fields FROM "FinancialAccount" r
UNION ALL
SELECT 'planting'::text entity, 'Planting'::text table_name, 'fields'::text scope_kind, 'planting:' || r.id::text scope_key, r.id, to_jsonb(r) payload, ARRAY['status']::text[] fields FROM "Planting" r
UNION ALL
SELECT 'gardenEntry'::text entity, 'GardenEntry'::text table_name, 'fields'::text scope_kind, 'gardenEntry:' || r.id::text scope_key, r.id, to_jsonb(r) payload, ARRAY['kind']::text[] fields FROM "GardenEntry" r
UNION ALL
SELECT 'productCategory'::text entity, 'ProductCategory'::text table_name, 'fields'::text scope_kind, 'productCategory:' || r.id::text scope_key, r.id, to_jsonb(r) payload, ARRAY['emoji','feature']::text[] fields FROM "ProductCategory" r
UNION ALL
SELECT 'run'::text entity, 'Run'::text table_name, 'fields'::text scope_kind, 'run:' || r.id::text scope_key, r.id, jsonb_build_object('deletedAt',r."deletedAt") payload, ARRAY[]::text[] fields FROM "Run" r
UNION ALL
SELECT 'device'::text entity, 'Device'::text table_name, 'fields'::text scope_kind, 'device:' || r.id::text scope_key, r.id, to_jsonb(r) payload, ARRAY['productId']::text[] fields FROM "Device" r
UNION ALL
SELECT 'spendingCategory'::text entity, 'SpendingCategory'::text table_name, 'fields'::text scope_kind, 'spendingCategory:' || r.id::text scope_key, r.id, to_jsonb(r) payload, ARRAY['emoji','itemizationExpectation','productExpectation']::text[] fields FROM "SpendingCategory" r
UNION ALL
SELECT 'financialTransaction', 'FinancialTransaction', 'bankEvent', coalesce(o.id::text,'manual:'||r.id), r.id, (to_jsonb(r)-'amountMinor')||jsonb_build_object('amount',coalesce(to_jsonb(r)->>'amountMinor',((to_jsonb(r)->>'amount')::numeric*100)::text)), ARRAY['accountId','kind','status','amount','transactionDate','postedDate','merchant','rawDescription','sourceCategory','notes','spendingCategoryId','itemizationExpectation']::text[] FROM "FinancialTransaction" r LEFT JOIN "SourceOccurrence" o ON o."acceptedTransactionId"=r.id AND o."deletedAt" IS NULL AND o."withdrawnAt" IS NULL AND o."supersededByOccurrenceId" IS NULL AND o.disposition IS DISTINCT FROM 'ignored'
UNION ALL
SELECT 'purchase', 'Purchase', 'purchaseEvent', coalesce((SELECT min(a."transactionId"::text) FROM "FinancialTransactionAllocation" a WHERE a."purchaseId"=r.id AND a."deletedAt" IS NULL),r.id::text), r.id, (to_jsonb(r)-'statedTotalMinor')||jsonb_build_object('statedTotal',coalesce(to_jsonb(r)->>'statedTotalMinor',((to_jsonb(r)->>'statedTotal')::numeric*100)::text)), ARRAY['vendorId','vendorAccountId','purchaserOverrideId','defaultProjectId','defaultTrade','spendingCategoryId','spendingCategoryOrigin','itemizationExpectation','orderId','displayLabel','date','statedTotal','notes']::text[] FROM "Purchase" r
UNION ALL
SELECT 'expense', 'Expense', 'purchaseEvent', coalesce((SELECT coalesce((SELECT min(a."transactionId"::text) FROM "FinancialTransactionAllocation" a WHERE a."purchaseId"=p.id AND a."deletedAt" IS NULL),p.id::text) FROM "Purchase" p WHERE p.id=r."purchaseId"),r.id::text), r.id, (to_jsonb(r)-'costMinor')||jsonb_build_object('cost',coalesce(to_jsonb(r)->>'costMinor',round((to_jsonb(r)->>'cost')::numeric*100)::text)), ARRAY['name','cost','date','lineKind','lineBasis','costType','trade','url','notes','future','projectId','productId','productQuantity','purchaseId','spendingCategoryId','economicRole','bookingTransactionCode']::text[] FROM "Expense" r
UNION ALL
SELECT 'FinancialTransactionAllocation', 'FinancialTransactionAllocation', 'purchaseEvent', r."transactionId"::text, r.id, (to_jsonb(r)-'amountMinor')||jsonb_build_object('amountMinor',r."amountMinor"::text), ARRAY['transactionId','purchaseId','amountMinor','confirmsMerchant']::text[] FROM "FinancialTransactionAllocation" r
UNION ALL
SELECT 'ExpenseAttribution', 'ExpenseAttribution', 'purchaseEvent', coalesce((SELECT coalesce((SELECT min(a."transactionId"::text) FROM "FinancialTransactionAllocation" a WHERE a."purchaseId"=e."purchaseId" AND a."deletedAt" IS NULL),e."purchaseId"::text,e.id::text) FROM "Expense" e WHERE e.id=r."expenseId"),r.id::text), r.id, to_jsonb(r), ARRAY['expenseId','role','ledgerPartyId','weight']::text[] FROM "ExpenseAttribution" r
), record_ids AS (
 SELECT entity,id,min(scope_key) scope_key FROM records GROUP BY entity,id
), audited_money_fields AS MATERIALIZED (
 SELECT a."entityKind" entity,a."entityId" id,array_agg(DISTINCT f.field) fields
 FROM "AuditLog" a CROSS JOIN LATERAL jsonb_object_keys(CASE WHEN jsonb_typeof(a.changes)='object' THEN a.changes ELSE '{}'::jsonb END) f(field)
 WHERE a."entityKind" IN ('financialTransaction','purchase','expense','FinancialTransactionAllocation','ExpenseAttribution')
 GROUP BY a."entityKind",a."entityId"
), allocation_authority AS MATERIALIZED (
 SELECT DISTINCT ON ("entityId") a.* FROM "AuditLog" a WHERE "entityKind"='financialTransaction' AND changes ? 'allocations'
 ORDER BY "entityId","createdAt" DESC,id DESC
), held_allocations AS (
 SELECT r.*,a."userId",a."oauthClientId" FROM records r
 JOIN allocation_authority a ON a."entityId"=(r.payload->>'transactionId')::uuid
 JOIN "Purchase" p ON p.id=(r.payload->>'purchaseId')::uuid
 WHERE r.entity='FinancialTransactionAllocation' AND a.authority IS NULL AND a.channel IS DISTINCT FROM 'system' AND a."userId" IS DISTINCT FROM 'cubby-system'
 AND a.changes->'allocations'->'to' @> jsonb_build_array(p.shortcode||':'||round((r.payload->>'amountMinor')::numeric/100,2)::text)
), field_values AS (
 SELECT r.entity,r.id, f.field, r.payload->f.field value, a.id audit_id, a.authority,
 a."userId", a."oauthClientId", a.channel, a."createdAt" audit_at, a.changes, a.action audit_action, a.audit_value,
 -- Only an exact, affirmative automatic trail establishes Cubby ownership; a
 -- member's Keep of that value after its acceptance makes it the member's.
 a.authority IN ('automatic','released') AND a.audit_value=r.payload->f.field AND kept.at IS NULL cubby_holds,
 kept.at kept_at, kept.by kept_by, r.scope_kind, r.payload
 FROM record_ids k JOIN records r USING(entity,id,scope_key)
 LEFT JOIN audited_money_fields audited USING(entity,id)
 CROSS JOIN LATERAL unnest(CASE WHEN r.scope_kind='fields' THEN r.fields ELSE ARRAY(SELECT field FROM unnest(r.fields) field WHERE field=ANY(coalesce(audited.fields,ARRAY[]::text[])) OR r.entity='purchase' AND (field='purchaserOverrideId' OR field='spendingCategoryId' AND r.payload->>'spendingCategoryOrigin'='manual')) END) f(field)
 LEFT JOIN LATERAL (SELECT a.*, CASE WHEN jsonb_typeof(a.changes->f.field->'to') IN ('number','string') AND (a.changes->f.field->'to' #>> '{}') ~ '^[+-]?[0-9]+([.][0-9]+)?$' THEN CASE
 WHEN ((r.entity='financialTransaction' AND f.field='amount') OR (r.entity='purchase' AND f.field='statedTotal') OR (r.entity='expense' AND f.field='cost'))
  AND abs((a.changes->f.field->'to' #>> '{}')::numeric*100-round((a.changes->f.field->'to' #>> '{}')::numeric*100))<0.0000001 THEN to_jsonb(round((a.changes->f.field->'to' #>> '{}')::numeric*100)::text)
 WHEN r.entity='FinancialTransactionAllocation' AND f.field='amountMinor' AND (a.changes->f.field->'to' #>> '{}')::numeric=trunc((a.changes->f.field->'to' #>> '{}')::numeric) THEN to_jsonb(trunc((a.changes->f.field->'to' #>> '{}')::numeric)::text)
 ELSE a.changes->f.field->'to' END ELSE a.changes->f.field->'to' END audit_value FROM "AuditLog" a WHERE a."entityKind"=r.entity AND a."entityId"=r.id
   AND (a.changes ? f.field OR a.action='create') ORDER BY a."createdAt" DESC,a.id DESC LIMIT 1) a ON true
 LEFT JOIN LATERAL (SELECT s.decisions,s."acceptanceReceipt" receipt FROM "Suggestion" s
   WHERE a.authority='automatic' AND s.family='field' AND s.entity=r.entity AND s."recordId"=r.id AND s.field=f.field AND s."acceptanceReceipt"->'auditIds' ? a.id::text
   ORDER BY s."createdAt" DESC LIMIT 1) accepted ON true
 LEFT JOIN LATERAL (SELECT (keep.event->>'createdAt')::timestamptz AT TIME ZONE 'UTC' at,keep.event->>'actorUserId' by
   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(accepted.decisions)='array' THEN accepted.decisions ELSE '[]'::jsonb END) keep(event)
   WHERE keep.event->>'authority'='member' AND keep.event->>'verdict'='correct' AND (keep.event->>'createdAt')::timestamptz>=(accepted.receipt->>'acceptedAt')::timestamptz
   ORDER BY (keep.event->>'createdAt')::timestamptz DESC LIMIT 1) kept ON true
), source_answers AS (
 SELECT 'AiEvaluation'::text source_table, e.id, CASE WHEN e.result IS NULL THEN to_jsonb(e) ELSE jsonb_build_object('id',e.id,'sourceTable','AiEvaluation','updatedAt',e."updatedAt",'receipt',e.receipt) END legacy, e.feature, e.provenance->>'model' model,
 coalesce(e.provenance->>'promptVersion',(SELECT d->>'promptVersion' FROM jsonb_array_elements(coalesce(e.provenance->'dependencies','[]'::jsonb)) d WHERE d->>'feature'=e.feature LIMIT 1),'legacy:unknown') prompt_version, e."createdAt" created_at, e."runId" run_id,
 e.result result, CASE WHEN e.result IS NOT NULL THEN 'answered' WHEN e."leaseToken" IS NOT NULL OR e.attempts>0 OR e.state IN ('result_ready','completed') THEN 'unknown' ELSE 'queued' END state,
 e.state IN ('cancelled','obsolete','failed','completed') cancelled, coalesce(e."runAt",e."createdAt") available_at,
 e.attempts, e.error, e.target target
 FROM "AiEvaluation" e
 UNION ALL
 SELECT 'AiAnalysis', a.id,to_jsonb(a),a.feature,a.model,a."promptVersion",a."createdAt",NULL,a.result,'answered',false,a."createdAt",0,NULL,
 jsonb_build_object('entity',a."entityKind",'recordId',a."entityId") FROM "AiAnalysis" a
 UNION ALL
 SELECT 'Suggestion',s.id,to_jsonb(s),'legacy:suggestion:'||s.family,s.model,'legacy:unknown',s."createdAt",s."runId",s."suggestedValue",'answered',false,s."createdAt",0,NULL,
 jsonb_build_object('entity',s.entity,'recordId',s."recordId") FROM "Suggestion" s WHERE s.family IN ('field','statement_transaction','recommendation')
 -- Preserve complete proposals, including negative/undecided paid results and review receipts.
), baseline_answers AS (
 -- The fields scope reads a Cubby-held value at its baseline Ask's envelope (fieldBaselineAsk).
 SELECT md5('cutover:baseline:'||entity||':'||id||':'||field)::uuid id,entity,id record_id,field,
 jsonb_build_object('feature','legacy:field','producer','model','tier',NULL,'model',NULL,'outputRevision','legacy-field.v1','parameters',NULL,'promptVersion','legacy','input',jsonb_build_object('entity',entity,'field',field,'recordId',id)) envelope
 FROM field_values WHERE cubby_holds AND scope_kind='fields'
), all_envelopes AS (SELECT id,envelope FROM baseline_answers), envelope_nodes(id,path,value,prefix) AS (
 SELECT id,ARRAY[]::text[],envelope,''::text FROM all_envelopes
 UNION ALL
 SELECT n.id,n.path||child.part,child.value,child.prefix FROM envelope_nodes n
 CROSS JOIN LATERAL (
   SELECT '1'||key part,value,CASE WHEN row_number() OVER(ORDER BY key COLLATE "C")>1 THEN ',' ELSE '' END||to_jsonb(key)::text||':' prefix FROM jsonb_each(CASE WHEN jsonb_typeof(n.value)='object' THEN n.value ELSE '{}'::jsonb END)
   UNION ALL
   SELECT '1'||lpad(ord::text,20,'0'),value,CASE WHEN ord>1 THEN ',' ELSE '' END FROM jsonb_array_elements(CASE WHEN jsonb_typeof(n.value)='array' THEN n.value ELSE '[]'::jsonb END) WITH ORDINALITY a(value,ord)
 ) child
), envelope_hashes AS (
 SELECT id,encode(sha256(convert_to(string_agg(piece,'' ORDER BY path COLLATE "C"),'UTF8')),'hex') hash FROM (
 SELECT id,path||ARRAY['0'] path,prefix||CASE jsonb_typeof(value) WHEN 'object' THEN '{' WHEN 'array' THEN '[' WHEN 'number' THEN CASE WHEN position('.' IN value::text)>0 THEN rtrim(rtrim(value::text,'0'),'.') ELSE value::text END ELSE value::text END piece FROM envelope_nodes
 UNION ALL SELECT id,path||ARRAY['2'],CASE jsonb_typeof(value) WHEN 'object' THEN '}' ELSE ']' END FROM envelope_nodes WHERE jsonb_typeof(value) IN ('object','array')
 ) tokens GROUP BY id
), imports AS (
 SELECT s.*,'legacy:'||s.source_table||':'||s.id::text hash,
 CASE WHEN s.source_table='Suggestion' AND (s.legacy->'producer'->>'kind'='rule' OR s.legacy->>'model'='rule') THEN 'source' ELSE 'model' END producer,
 s.id ask_id,
 s.source_table='AiEvaluation' AND (s.result IS NULL AND (NOT s.cancelled OR s.attempts>0 OR s.legacy->>'leaseToken' IS NOT NULL) OR s.result IS NOT NULL AND EXISTS(SELECT 1 FROM "AiEvaluationRequest" r WHERE r."evaluationId"=s.id)) needs_ask,
 s.cancelled OR s.source_table='AiEvaluation' AND s.state='queued' cancel_import,
 CASE WHEN s.target->>'entity' IN ('product','cookbook','location','meal','project','task','vendor','financialAccount','planting','gardenEntry','productCategory','run','device','spendingCategory') AND s.target->>'recordId' IS NOT NULL THEN (s.target->>'entity')||':'||(s.target->>'recordId') END fields_scope
 FROM source_answers s
), ask_rows AS (
 SELECT * FROM imports WHERE needs_ask
), review_events AS (
 SELECT s.id, d.event, d.ord FROM "Suggestion" s CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.decisions)='array' THEN s.decisions ELSE '[]'::jsonb END) WITH ORDINALITY d(event,ord) WHERE s.family IN ('field','statement_transaction','recommendation')
 UNION ALL
 SELECT s.id,jsonb_build_object('verdict',CASE WHEN s.suppression IS NOT NULL THEN 'wrong' ELSE 'correct' END,
 'intent','apply','correction',CASE WHEN s."confirmedValue"->>'present'='true' THEN s."confirmedValue" ELSE jsonb_build_object('present',s."correctValue" IS NOT NULL,'value',s."correctValue") END,
 'authority',CASE WHEN s."acceptanceReceipt"->>'mode'='automatic' THEN 'automatic' ELSE 'unknown' END,
 'createdAt',coalesce(nullif(s."acceptanceReceipt"->>'acceptedAt',''),s."updatedAt"::text,s."createdAt"::text)),
 0::bigint FROM "Suggestion" s WHERE s.family IN ('field','statement_transaction','recommendation') AND jsonb_array_length(CASE WHEN jsonb_typeof(s.decisions)='array' THEN s.decisions ELSE '[]'::jsonb END)=0
 AND (s.suppression IS NOT NULL OR s."confirmedValue"->>'present'='true' OR s."acceptanceReceipt"->>'mode'='member')
), review_times AS MATERIALIZED (
 SELECT s.entity,s."recordId" id,s.field,max((v.event->>'createdAt')::timestamp) review_at
 FROM review_events v JOIN "Suggestion" s ON s.id=v.id GROUP BY s.entity,s."recordId",s.field
), reviews AS (
 SELECT s.*, d.event, d.ord,
 CASE WHEN d.event->'correction'->>'present'='true' THEN d.event->'correction'->'value' ELSE s."suggestedValue" END accepted
 FROM "Suggestion" s JOIN review_events d ON d.id=s.id
 WHERE d.event->>'authority' IS DISTINCT FROM 'automatic'
), current_reviews AS MATERIALIZED (
 SELECT v.id,v.ord FROM reviews v JOIN field_values f ON f.entity=v.entity AND f.id=v."recordId" AND f.field=v.field
 WHERE f.cubby_holds IS NOT TRUE AND f.value IS NOT DISTINCT FROM v.accepted
), statement_applications AS (
 SELECT v.*,o.id occurrence_id,o."acceptedTransactionId" transaction_id
 FROM reviews v JOIN "SourceTransactionRecord" observation ON observation.id=v."recordId"
 JOIN "SourceOccurrence" o ON o.id=observation."occurrenceId"
 WHERE v.family='statement_transaction' AND v.event->>'authority'='member'
), connection_reviews AS (
 SELECT v.*, candidate.value candidate,
 coalesce((SELECT target FROM survivors WHERE id=coalesce(src_uuid.id,src_code.id)),src_uuid.id,src_code.id) source_id,
 coalesce((SELECT target FROM survivors WHERE id=coalesce(dst_uuid.id,dst_code.id)),dst_uuid.id,dst_code.id) target_id
 FROM reviews v CROSS JOIN LATERAL (SELECT coalesce(v.evidence->'candidate',v.data->'candidate')) candidate(value)
 LEFT JOIN "Entity" src_uuid ON src_uuid.kind=candidate.value->'source'->>'entityKind' AND src_uuid.id=CASE WHEN candidate.value->'source'->>'entityId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN (candidate.value->'source'->>'entityId')::uuid END
 LEFT JOIN "Entity" src_code ON src_code.kind=candidate.value->'source'->>'entityKind' AND src_code.shortcode=candidate.value->'source'->>'entityId' 
 LEFT JOIN "Entity" dst_uuid ON dst_uuid.kind=candidate.value->'target'->>'entityKind' AND dst_uuid.id=CASE WHEN candidate.value->'target'->>'entityId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN (candidate.value->'target'->>'entityId')::uuid END
 LEFT JOIN "Entity" dst_code ON dst_code.kind=candidate.value->'target'->>'entityKind' AND dst_code.shortcode=candidate.value->'target'->>'entityId' 
 WHERE v.family='recommendation'
), expected AS (
 SELECT 'recordKey'::text mapping, entity||':'||id source_id,
 jsonb_build_object('scopeKind',scope_kind,'scopeKey',scope_key,'entity',entity,'naturalKey','legacy:'||id,'entityId',coalesce((SELECT target FROM survivors WHERE survivors.id=records.id),id),'rejectedAt',CASE WHEN EXISTS(SELECT 1 FROM survivors WHERE survivors.id=records.id) THEN NULL ELSE payload->'deletedAt' END) row
 FROM records
 UNION ALL
 SELECT 'manualEntry',entity||':'||id,
 jsonb_build_object('id',md5('cutover:'||entity||':'||id||CASE WHEN scope_kind='bankEvent' THEN ':'||scope_key ELSE '' END)::uuid,'entity',entity,'userId','legacy:unknown',
 'payload',jsonb_build_object('purchaseEvent',CASE WHEN scope_kind='purchaseEvent' THEN scope_key END,'table',table_name,'naturalKey','legacy:'||id,'values',CASE WHEN cardinality(fields)>0 THEN (SELECT jsonb_object_agg(f,payload->f) FROM unnest(fields) f) ELSE payload END,'legacy',payload,'acceptedScope',jsonb_build_object('kind',scope_kind,'key',scope_key)))
 FROM records WHERE scope_kind<>'fields'
 UNION ALL
 SELECT 'manualInput',entity||':'||id,jsonb_build_object('id',id,'entity',entity,'userId','legacy:unknown','payload',jsonb_build_object(
 'accountId',(SELECT shortcode FROM "FinancialAccount" WHERE id=(records.payload->>'accountId')::uuid),'kind',payload->'kind','status',payload->'status','amount',(payload->>'amount')::numeric/100,
 'transactionDate',payload->'transactionDate','postedDate',payload->'postedDate','merchant',payload->'merchant','rawDescription',payload->'rawDescription','sourceCategory',payload->'sourceCategory','notes',payload->'notes','itemizationExpectation',payload->'itemizationExpectation','sourceRefs','[]'::jsonb,'allocations','[]'::jsonb)
) FROM records WHERE scope_kind='bankEvent' AND scope_key='manual:'||id
 UNION ALL
 SELECT 'binding',entity||':'||id,jsonb_build_object('factKind','manualEntry','factId',md5('cutover:'||entity||':'||id||CASE WHEN scope_kind='bankEvent' THEN ':'||scope_key ELSE '' END)::uuid,'basis','baseline','eventKey',CASE WHEN scope_kind='fields' THEN 'baseline:snapshot:'||entity||':'||id ELSE id::text END,'scopeKind',scope_kind,'scopeKey',scope_key) FROM records WHERE scope_kind<>'fields'
 UNION ALL
 SELECT 'scope',scope_kind||':'||scope_key,jsonb_build_object('scopeKind',scope_kind,'scopeKey',scope_key,'version',0,'rules','','stage','done') FROM records GROUP BY scope_kind,scope_key
 UNION ALL
 SELECT 'scope','bankEvent:'||id,jsonb_build_object('scopeKind','bankEvent','scopeKey',id,'version',0,'rules','','stage','done') FROM "SourceOccurrence"
 UNION ALL
 SELECT 'scope','purchaseEvent:'||id,jsonb_build_object('scopeKind','purchaseEvent','scopeKey',id,'version',0,'rules','','stage','done') FROM "FinancialTransaction"
 UNION ALL
 SELECT 'scope','connections:'||"scopeKey",jsonb_build_object('scopeKind','connections','scopeKey',"scopeKey",'version',0,'rules','','stage','done') FROM "ConnectionCandidateEvidence" GROUP BY "scopeKey"
 UNION ALL
 SELECT 'decision',entity||':'||id||':'||field,jsonb_build_object('id',('ffffffff'||substr(md5('cutover-held:'||entity||':'||id||':'||field),9))::uuid,
 'channel','assignment','subject',entity||':'||id,'slot',field,'field',field,'kind',CASE WHEN value='null'::jsonb THEN 'none' ELSE 'set' END,'value',value,
 'actorKind',CASE WHEN kept_at IS NOT NULL THEN 'member' WHEN audit_id IS NULL OR authority IS NOT NULL OR audit_value IS DISTINCT FROM value OR channel='system' OR "userId"='cubby-system' THEN 'system' WHEN "oauthClientId" IS NOT NULL THEN 'agent' ELSE 'member' END,
 'actorId',CASE WHEN kept_at IS NOT NULL THEN kept_by WHEN authority IS NULL AND audit_value=value THEN "userId" END,'at',coalesce(kept_at,now() AT TIME ZONE 'UTC'))
 FROM field_values WHERE (entity NOT IN ('financialTransaction','purchase','expense','FinancialTransactionAllocation','ExpenseAttribution') OR kept_at IS NOT NULL OR audit_id IS NOT NULL AND authority IS NULL AND audit_value IS NOT DISTINCT FROM value AND channel IS DISTINCT FROM 'system' AND "userId" IS DISTINCT FROM 'cubby-system' OR entity='purchase' AND (field='purchaserOverrideId' OR field='spendingCategoryId' AND EXISTS(SELECT 1 FROM records r WHERE r.id=field_values.id AND r.payload->>'spendingCategoryOrigin'='manual'))) AND cubby_holds IS NOT TRUE AND value IS NOT NULL AND ((value<>'null'::jsonb AND value<>'""'::jsonb AND value<>'[]'::jsonb) OR audit_id IS NOT NULL AND audit_action<>'create' AND authority IS NULL AND changes->field ? 'to' AND audit_value IS NOT DISTINCT FROM value AND channel IS DISTINCT FROM 'system' AND "userId" IS DISTINCT FROM 'cubby-system')
 UNION ALL
 SELECT 'decision','ManualAllocation:'||id||':'||f,jsonb_build_object('id',md5('cutover:manual-allocation:'||id||':'||f)::uuid,
 'channel','assignment','subject','FinancialTransactionAllocation:'||id,'slot',f,'field',f,'kind','set','value',payload->f,
 'actorKind',CASE WHEN "oauthClientId" IS NOT NULL THEN 'agent' ELSE 'member' END,'actorId',"userId",'at',now() AT TIME ZONE 'UTC')
 FROM held_allocations CROSS JOIN LATERAL unnest(fields) f
 UNION ALL
 SELECT 'answer',f.entity||':'||f.id||':'||f.field,jsonb_build_object('inputHash',coalesce(h.hash,'legacy:field:'||f.entity||':'||f.id||':'||f.field),'feature','legacy:field','producer','model','promptVersion',CASE WHEN h.hash IS NULL THEN 'legacy:unknown' ELSE 'legacy' END,
 'output',jsonb_build_object('value',f.value,'auditId',f.audit_id,'subject',f.entity||':'||f.id,'field',f.field)||CASE WHEN h.hash IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('record',f.payload) END,'createdAt',f.audit_at)
 FROM field_values f LEFT JOIN baseline_answers b ON b.entity=f.entity AND b.record_id=f.id AND b.field=f.field LEFT JOIN envelope_hashes h ON h.id=b.id WHERE f.cubby_holds
 UNION ALL
 SELECT 'ask',i.source_table||':'||i.id,jsonb_build_object('id',c.ask_id,'inputHash',c.hash,'feature','legacy:'||c.feature,'producer',c.producer,'promptVersion',c.prompt_version,
 'input',jsonb_build_object('legacy',c.legacy,'sourceTable',c.source_table),'state',c.state,'cancelledAt',CASE WHEN c.cancel_import THEN coalesce(c.legacy->'updatedAt',to_jsonb(now() AT TIME ZONE 'UTC')) END,
 'availableAt',c.available_at,'attempts',c.attempts,'maxAttempts',greatest(3,c.attempts+1),'lastError',CASE WHEN c.cancel_import AND NOT c.cancelled THEN CASE WHEN c.fields_scope IS NOT NULL THEN 'Cutover cancelled legacy queued work: its fields scope runs again and asks from current inputs' ELSE 'Cutover cancelled legacy queued work: no current scope owns its record' END ELSE c.error END,'waitCause',CASE WHEN c.legacy->>'waitCause' IN ('funding','provider_capacity','in_flight','rate_limit','device') THEN c.legacy->>'waitCause' END,'createdAt',c.created_at,'executor',NULL) FROM imports i JOIN ask_rows c USING(ask_id) WHERE i.source_table='AiEvaluation'
 UNION ALL
 SELECT 'answer',source_table||':'||id,jsonb_build_object('inputHash',hash,'feature','legacy:'||feature,'producer',producer,'promptVersion',prompt_version,
 'output',jsonb_build_object('result',result,'legacy',legacy,'sourceTable',source_table),'model',model,'askId',CASE WHEN needs_ask THEN ask_id END,'runId',run_id,'createdAt',created_at) FROM imports WHERE result IS NOT NULL
 UNION ALL
 SELECT 'askScope',source_table||':'||id||':owner',jsonb_build_object('askId',ask_id,'scopeKind','run','scopeKey',run_id,'runId',run_id,'receipt',legacy->'receipt','createdAt',created_at) FROM imports WHERE needs_ask AND run_id IS NOT NULL
 UNION ALL
 SELECT 'askScope',source_table||':'||id||':record',jsonb_build_object('askId',ask_id,'scopeKind',CASE WHEN target->>'entity' IN ('product','cookbook','location','meal','project','task','vendor','financialAccount','planting','gardenEntry','productCategory','run','device','spendingCategory') THEN 'fields' ELSE 'record' END,
 'scopeKey',(target->>'entity')||':'||(target->>'recordId'),'createdAt',created_at) FROM imports WHERE needs_ask AND target->>'recordId' IS NOT NULL
 UNION ALL
 -- A cancelled queued evaluation's fields scope runs again under current rules.
 SELECT DISTINCT ON (fields_scope) 'dirty','fields:'||fields_scope,jsonb_build_object('scopeKind','fields','scopeKey',fields_scope,'lane','catalog','reason','cutover:cancelled-ask')
 FROM imports WHERE source_table='AiEvaluation' AND needs_ask AND cancel_import AND NOT cancelled AND fields_scope IS NOT NULL
 UNION ALL
 (SELECT DISTINCT ON (i.ask_id,r."runId") 'askScope','AiEvaluationRequest:'||r.id,jsonb_build_object('askId',i.ask_id,'scopeKind','run','scopeKey',r."runId",'runId',r."runId",'receipt',r.receipt,'sequence',r.sequence,'cancelledAt',r."cancelledAt",'createdAt',r."createdAt")
 FROM "AiEvaluationRequest" r JOIN imports i ON i.source_table='AiEvaluation' AND i.id=r."evaluationId" WHERE i.needs_ask
 ORDER BY i.ask_id,r."runId",r.sequence DESC NULLS LAST,r."createdAt" DESC,r.id DESC)
 UNION ALL
 SELECT 'decision','Suggestion:'||id||':'||ord,jsonb_build_object('id',md5('cutover-review:'||id||':'||ord)::uuid,'channel',CASE WHEN event->>'verdict' IN ('wrong','dismissed') THEN 'veto' ELSE 'assignment' END,
 'subject',entity||':'||"recordId",'slot',CASE WHEN event->>'verdict' IN ('wrong','dismissed') THEN field||chr(31)||encode(sha256(convert_to("suggestedValue"::text,'UTF8')),'hex') ELSE field END,'field',field,'kind',CASE WHEN event->>'verdict' IN ('wrong','dismissed') THEN 'veto' WHEN accepted='null'::jsonb THEN 'none' ELSE 'set' END,
 'value',CASE WHEN event->>'verdict' IN ('wrong','dismissed') THEN "suggestedValue" ELSE accepted END,'actorKind',CASE WHEN event->>'authority'='member' THEN 'member' ELSE 'system' END,'actorId',event->>'actorUserId','at',(event->>'createdAt')::timestamp)
 FROM reviews WHERE family='field' AND field<>'' AND "recordId" IS NOT NULL AND event->>'verdict' IN ('correct','wrong','dismissed') AND (event->>'verdict'<>'correct' OR event->>'intent'='apply' AND EXISTS (SELECT 1 FROM current_reviews v WHERE v.id=reviews.id AND v.ord=reviews.ord))
UNION ALL
SELECT 'decision','Suggestion:'||r.id,jsonb_build_object('id',md5('cutover:Suggestion:'||r.id)::uuid,'channel','assignment','subject','legacy:suggestion:'||r.id,'slot','review','field','review','kind','set','value',to_jsonb(r),'actorKind','system','actorId',NULL,'at',r."updatedAt") FROM "Suggestion" r WHERE r.family IN ('field','statement_transaction','recommendation') AND r.field='' AND (jsonb_array_length(CASE WHEN jsonb_typeof(r.decisions)='array' THEN r.decisions ELSE '[]'::jsonb END)>0 OR r.suppression IS NOT NULL OR r."confirmedValue" IS NOT NULL)
UNION ALL
SELECT 'decision','Connection:'||id||':'||ord,jsonb_build_object('id',md5('cutover:connection:'||id||':'||ord)::uuid,
 'channel','assignment','subject','connection/'||(candidate->>'relation')||':'||source_id||':'||target_id,'slot','link','field','link','kind','set',
 'value',event->>'verdict'='correct','actorKind',CASE WHEN event->>'authority'='member' THEN 'member' ELSE 'system' END,'actorId',event->>'actorUserId','at',(event->>'createdAt')::timestamp)
FROM connection_reviews WHERE source_id IS NOT NULL AND target_id IS NOT NULL AND candidate->>'relation' IS NOT NULL AND (event->>'verdict' IN ('wrong','dismissed') OR event->>'verdict'='correct' AND event->>'intent'='apply')
UNION ALL
SELECT 'decision','Suggestion:correction-veto:'||id||':'||ord,jsonb_build_object('id',md5('cutover:correction-veto:'||id||':'||ord)::uuid,
 'channel','veto','subject',entity||':'||"recordId",'slot',field||chr(31)||encode(sha256(convert_to("suggestedValue"::text,'UTF8')),'hex'),'field',field,'kind','veto','value',"suggestedValue",
 'actorKind',CASE WHEN event->>'authority'='member' THEN 'member' ELSE 'system' END,'actorId',event->>'actorUserId','at',(event->>'createdAt')::timestamp)
FROM reviews WHERE family='field' AND field<>'' AND "recordId" IS NOT NULL AND event->>'verdict'='correct' AND event->>'intent'='apply' AND event->'correction'->>'present'='true' AND accepted IS DISTINCT FROM "suggestedValue"
UNION ALL
SELECT 'decision','Suggestion:review:'||id||':'||ord,jsonb_build_object('id',md5('cutover:review-event:'||id||':'||ord)::uuid,
 'channel','assignment','subject','legacy:suggestion:'||id,'slot','review:'||ord,'field','review','kind','set','value',event,
 'actorKind',CASE WHEN event->>'authority'='member' THEN 'member' ELSE 'system' END,'actorId',event->>'actorUserId','at',(event->>'createdAt')::timestamp)
FROM reviews WHERE family<>'field' OR field=''

UNION ALL
SELECT 'decision','StatementApplication:'||id||':'||ord||':'||a.field,jsonb_build_object('id',md5('cutover:statement:'||id||':'||ord||':'||a.field)::uuid,
 'channel','assignment','subject','bank:'||occurrence_id,'slot',a.field,'field',a.field,'kind','set','value',a.value,'actorKind','member','actorId',event->>'actorUserId','at',(event->>'createdAt')::timestamp)
FROM statement_applications CROSS JOIN LATERAL (VALUES ('accountId',coalesce(accepted->'accountId',data->'accountId')),('kind',accepted->'kindOverride')) a(field,value)
WHERE event->>'intent'='apply' AND jsonb_typeof(a.value)='string'
UNION ALL
SELECT 'decision','StatementBooking:'||id||':'||ord||':'||b.key,jsonb_build_object('id',md5('cutover:booking:'||id||':'||ord||':'||b.key)::uuid,
 'channel','assignment','subject','purchaseEvent:'||transaction_id,'slot',CASE WHEN b.key='reviewedVendorName' THEN 'vendorName' ELSE b.key END,'field',CASE WHEN b.key='reviewedVendorName' THEN 'vendorName' ELSE b.key END,
 'kind',CASE WHEN b.value='null'::jsonb THEN 'none' ELSE 'set' END,'value',b.value,'actorKind','member','actorId',event->>'actorUserId','at',(event->>'createdAt')::timestamp)
FROM statement_applications CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(accepted->'booking')='object' THEN accepted->'booking' ELSE '{}'::jsonb END) b
WHERE event->>'intent'='apply' AND transaction_id IS NOT NULL
UNION ALL
SELECT 'decision','StatementBook:'||id||':'||ord,jsonb_build_object('id',md5('cutover:book:'||id||':'||ord)::uuid,
 'channel','assignment','subject','purchaseEvent:'||transaction_id,'slot','book','field','book','kind','set','value',true,'actorKind','member','actorId',event->>'actorUserId','at',(event->>'createdAt')::timestamp)
FROM statement_applications WHERE event->>'intent'='apply' AND accepted->>'action'='book' AND transaction_id IS NOT NULL
UNION ALL
SELECT 'decision','StatementDistinct:'||a.id||':'||a.ord||':'||candidate.id,jsonb_build_object('id',md5('cutover:distinct:'||a.id||':'||a.ord||':'||candidate.id)::uuid,
 'channel','identity','subject','financialTransaction:'||least(a.transaction_id::text,candidate.id::text),'other','financialTransaction:'||greatest(a.transaction_id::text,candidate.id::text),
 'slot','financialTransaction:'||greatest(a.transaction_id::text,candidate.id::text),'field','financialTransaction:'||greatest(a.transaction_id::text,candidate.id::text),'kind','distinct','value',NULL,'actorKind','member','actorId',a.event->>'actorUserId','at',(a.event->>'createdAt')::timestamp)
FROM statement_applications a CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(a.accepted->'rejectedCandidateIds')='array' THEN a.accepted->'rejectedCandidateIds' ELSE '[]'::jsonb END) rejected(code)
JOIN "Entity" candidate ON candidate.kind='financialTransaction' AND (candidate.shortcode=rejected.code OR candidate.id::text=rejected.code)
WHERE a.event->>'intent'='apply' AND a.transaction_id IS NOT NULL AND candidate.id<>a.transaction_id
UNION ALL
SELECT 'decision','StatementRejection:'||v.id||':'||v.ord,jsonb_build_object('id',md5('cutover:statement-rejection:'||v.id||':'||v.ord)::uuid,'channel','rejection','subject','bank:'||o.id,'slot','','kind','reject','value',v.event,'actorKind','member','actorId',v.event->>'actorUserId','at',(v.event->>'createdAt')::timestamp)
FROM reviews v JOIN "SourceTransactionRecord" observation ON observation.id=v."recordId" JOIN "SourceOccurrence" o ON o.id=observation."occurrenceId"
WHERE v.family='statement_transaction' AND v.event->>'authority'='member' AND v.event->>'verdict' IN ('wrong','dismissed') AND v.suppression->>'scope'='statement_transaction' AND o."acceptedTransactionId" IS NULL
UNION ALL
SELECT 'decision','Rejected:'||entity||':'||id,jsonb_build_object('id',md5('cutover:rejected:'||entity||':'||id)::uuid,
 'channel','rejection','subject',entity||':'||id,'slot','','kind','reject','value',NULL,'actorKind','system','actorId',NULL,'at',payload->'deletedAt')
FROM records WHERE payload->>'deletedAt' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM survivors WHERE survivors.id=records.id)

UNION ALL
-- A current automatic/released trail supersedes old held assignments. This is
-- an observation of authority at cutover, not a fabricated member release.
SELECT 'decision','CubbyRelease:'||entity||':'||id||':'||field,jsonb_build_object('id',md5('cutover:cubby-release:'||entity||':'||id||':'||field)::uuid,
 'channel','assignment','subject',entity||':'||id,'slot',field,'field',field,'kind','release','value',NULL,'actorKind','system','actorId',NULL,'at',greatest(now() AT TIME ZONE 'UTC',coalesce(review_at,audit_at))+interval '1 microsecond')
FROM field_values LEFT JOIN review_times USING(entity,id,field) WHERE cubby_holds
), empty_scopes AS (
 SELECT DISTINCT e.row->>'scopeKind' kind,e.row->>'scopeKey' key FROM expected e WHERE e.mapping='scope' AND e.row->>'scopeKind' IN ('bankEvent','purchaseEvent')
 AND NOT EXISTS (SELECT 1 FROM expected k WHERE k.mapping='recordKey' AND k.row->>'scopeKind'=e.row->>'scopeKind' AND k.row->>'scopeKey'=e.row->>'scopeKey')
), complete_expected AS (
 SELECT mapping,source_id,row FROM expected
 UNION ALL
 SELECT 'manualEntry','emptyScope:'||kind||':'||key,jsonb_build_object('id',md5('cutover:empty:'||kind||':'||key)::uuid,'entity','scope','userId','legacy:unknown',
 'payload',jsonb_build_object('emptyBaseline',true,'acceptedScope',jsonb_build_object('kind',kind,'key',key))) FROM empty_scopes
 UNION ALL
 SELECT 'binding','emptyScope:'||kind||':'||key,jsonb_build_object('factKind','manualEntry','factId',md5('cutover:empty:'||kind||':'||key)::uuid,'basis','baseline','eventKey','baseline:empty:'||kind||':'||key,'scopeKind',kind,'scopeKey',key) FROM empty_scopes
)
SELECT mapping,source_id,row FROM complete_expected
-- cutover:select:end
;
--> statement-breakpoint
CREATE INDEX ON cutover_expected (mapping,(row->>'id'));
CREATE INDEX ON cutover_expected (mapping,(row->>'scopeKind'),(row->>'scopeKey'));
ANALYZE cutover_expected;
--> statement-breakpoint
INSERT INTO "RecordKey" ("scopeKind","scopeKey","entity","naturalKey","entityId","rejectedAt")
SELECT r."scopeKind",r."scopeKey",r."entity",r."naturalKey",r."entityId",r."rejectedAt" FROM cutover_expected e
CROSS JOIN LATERAL jsonb_populate_record(NULL::"RecordKey",e.row) r
WHERE e.mapping='recordKey'
ON CONFLICT ("scopeKind","scopeKey",entity,"naturalKey") DO UPDATE SET "entityId"=excluded."entityId","rejectedAt"=excluded."rejectedAt";
--> statement-breakpoint
INSERT INTO "ManualEntry" ("id","entity","userId","payload")
SELECT r."id",r."entity",r."userId",r."payload" FROM cutover_expected e
CROSS JOIN LATERAL jsonb_populate_record(NULL::"ManualEntry",e.row) r
WHERE e.mapping IN ('manualEntry','manualInput')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "EvidenceBinding" ("factKind","factId","basis","eventKey","scopeKind","scopeKey")
SELECT r."factKind",r."factId",r."basis",r."eventKey",r."scopeKind",r."scopeKey" FROM cutover_expected e
CROSS JOIN LATERAL jsonb_populate_record(NULL::"EvidenceBinding",e.row) r
WHERE e.mapping='binding'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "ScopeState" ("scopeKind","scopeKey","version","rules","stage")
SELECT r."scopeKind",r."scopeKey",r."version",r."rules",r."stage" FROM cutover_expected e
CROSS JOIN LATERAL jsonb_populate_record(NULL::"ScopeState",e.row) r
WHERE e.mapping='scope'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "Decision" ("id","channel","subject","slot","field","kind","value","other","actorKind","actorId","at")
SELECT r."id",r."channel",r."subject",r."slot",r."field",r."kind",r."value",r."other",r."actorKind",r."actorId",r."at" FROM cutover_expected e
CROSS JOIN LATERAL jsonb_populate_record(NULL::"Decision",e.row) r
WHERE e.mapping='decision'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "Ask" ("id","inputHash","feature","producer","promptVersion","input","state","cancelledAt","availableAt","attempts","maxAttempts","lastError","waitCause","createdAt","executor")
SELECT r."id",r."inputHash",r."feature",r."producer",r."promptVersion",r."input",r."state",r."cancelledAt",r."availableAt",r."attempts",r."maxAttempts",r."lastError",r."waitCause",r."createdAt",r."executor" FROM cutover_expected e
CROSS JOIN LATERAL jsonb_populate_record(NULL::"Ask",e.row) r
WHERE e.mapping='ask'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "Answer" ("inputHash","feature","producer","promptVersion","output","model","askId","runId","createdAt")
SELECT r."inputHash",r."feature",r."producer",r."promptVersion",e.row->'output',r."model",r."askId",r."runId",r."createdAt" FROM cutover_expected e
CROSS JOIN LATERAL jsonb_populate_record(NULL::"Answer",e.row) r
WHERE e.mapping='answer'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "AskScope" ("askId","scopeKind","scopeKey","runId",receipt,sequence,"cancelledAt","createdAt")
SELECT DISTINCT ON (r."askId",r."scopeKind",r."scopeKey") r."askId",r."scopeKind",r."scopeKey",r."runId",r.receipt,r.sequence,r."cancelledAt",r."createdAt"
FROM cutover_expected e CROSS JOIN LATERAL jsonb_populate_record(NULL::"AskScope",e.row) r WHERE e.mapping='askScope'
ORDER BY r."askId",r."scopeKind",r."scopeKey",(e.source_id LIKE 'AiEvaluationRequest:%') DESC
ON CONFLICT ("askId","scopeKind","scopeKey") DO UPDATE SET receipt=excluded.receipt,sequence=excluded.sequence,"cancelledAt"=excluded."cancelledAt";
--> statement-breakpoint
INSERT INTO "ScopeDirty" ("scopeKind","scopeKey",lane,reason)
SELECT r."scopeKind",r."scopeKey",r.lane,r.reason FROM cutover_expected e
CROSS JOIN LATERAL jsonb_populate_record(NULL::"ScopeDirty",e.row) r
WHERE e.mapping='dirty'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "FactKey" (key,"factKind","factId")
SELECT row->'payload'->'acceptedScope'->>'kind'||':'||(row->'payload'->'acceptedScope'->>'key'),'manualEntry',row->>'id'
FROM cutover_expected WHERE mapping='manualEntry'
UNION ALL SELECT 'manual:'||(row->>'id'),'manualEntry',row->>'id' FROM cutover_expected WHERE mapping IN ('manualEntry','manualInput')
UNION ALL SELECT 'occurrence:'||id,'sourceOccurrence',id::text FROM "SourceOccurrence"
UNION ALL SELECT 'row:SourceOccurrence:'||id,'sourceOccurrence',id::text FROM "SourceOccurrence"
UNION ALL SELECT 'occurrence:'||"occurrenceId",'statementObservation',id::text FROM "SourceTransactionRecord"
UNION ALL SELECT 'row:SourceTransactionRecord:'||id,'statementObservation',id::text FROM "SourceTransactionRecord"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TEMP VIEW cutover_money_readback AS
 SELECT DISTINCT ON (m.payload->>'table',m.payload->>'naturalKey') m.payload->>'table' source,substr(m.payload->>'naturalKey',8)::uuid id,
 CASE WHEN m.payload->>'table'='Purchase' THEN substr(m.payload->>'naturalKey',8)::uuid ELSE (m.payload->'values'->>'purchaseId')::uuid END owner,
 date_trunc('month',coalesce(m.payload->'values'->>'transactionDate',m.payload->'values'->>'date')::date)::date month_key,
 (CASE m.payload->>'table' WHEN 'Expense' THEN m.payload->'values'->>'cost' WHEN 'Purchase' THEN m.payload->'values'->>'statedTotal' ELSE coalesce(m.payload->'values'->>'amountMinor',m.payload->'values'->>'amount') END)::numeric amount
 FROM "ManualEntry" m JOIN cutover_expected e ON e.mapping='manualEntry' AND (e.row->>'id')::uuid=m.id
 WHERE m.payload->>'table' IN ('Expense','Purchase','FinancialTransaction','FinancialTransactionAllocation');
--> statement-breakpoint
UPDATE "RecordKey" k SET "mergedAt"=coalesce(e."deletedAt",now() AT TIME ZONE 'UTC')
FROM "Entity" e WHERE k."naturalKey"='legacy:'||e.id AND e."mergedIntoId" IS NOT NULL;
--> statement-breakpoint
ANALYZE "RecordKey", "ManualEntry", "EvidenceBinding", "ScopeState", "Decision", "Ask", "Answer", "AskScope";
--> statement-breakpoint
DO $verify$ BEGIN

 IF EXISTS (SELECT 1 FROM cutover_money m LEFT JOIN cutover_money_readback d USING(source,id) WHERE d.id IS NULL OR m.amount::numeric IS DISTINCT FROM d.amount) THEN RAISE EXCEPTION 'Accepted-input cutover: money row preservation mismatch'; END IF;
 IF EXISTS (
 WITH actual AS (
 SELECT source,CASE WHEN grouping(owner)=0 THEN 'purchase' WHEN grouping(month_key)=0 THEN 'month' ELSE 'overall' END bucket,owner,month_key,count(*) n,sum(amount)::numeric amount
 FROM cutover_money_readback GROUP BY GROUPING SETS ((source),(source,owner),(source,month_key))
 ) (SELECT * FROM cutover_money_totals EXCEPT SELECT * FROM actual) UNION ALL (SELECT * FROM actual EXCEPT SELECT * FROM cutover_money_totals)
 ) THEN RAISE EXCEPTION 'Accepted-input cutover: money totals preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM cutover_expected e CROSS JOIN LATERAL jsonb_populate_record(NULL::"RecordKey",e.row) r WHERE mapping='recordKey' AND NOT EXISTS (SELECT 1 FROM "RecordKey" t WHERE t."scopeKind"=r."scopeKind" AND t."scopeKey"=r."scopeKey" AND t."entity"=r."entity" AND t."naturalKey"=r."naturalKey" AND ROW(t."scopeKind",t."scopeKey",t."entity",t."naturalKey",t."entityId",t."rejectedAt") IS NOT DISTINCT FROM ROW(r."scopeKind",r."scopeKey",r."entity",r."naturalKey",r."entityId",r."rejectedAt"))) THEN RAISE EXCEPTION 'Accepted-input cutover: recordKey preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM cutover_expected e CROSS JOIN LATERAL jsonb_populate_record(NULL::"ManualEntry",e.row) r WHERE mapping IN ('manualEntry','manualInput') AND NOT EXISTS (SELECT 1 FROM "ManualEntry" t WHERE t."id"=r."id" AND ROW(t."id",t."entity",t."userId",t."payload") IS NOT DISTINCT FROM ROW(r."id",r."entity",r."userId",r."payload"))) THEN RAISE EXCEPTION 'Accepted-input cutover: manualEntry preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM cutover_expected e CROSS JOIN LATERAL jsonb_populate_record(NULL::"EvidenceBinding",e.row) r WHERE mapping='binding' AND NOT EXISTS (SELECT 1 FROM "EvidenceBinding" t WHERE t."factKind"=r."factKind" AND t."factId"=r."factId" AND t."basis"=r."basis" AND ROW(t."factKind",t."factId",t."basis",t."eventKey",t."scopeKind",t."scopeKey") IS NOT DISTINCT FROM ROW(r."factKind",r."factId",r."basis",r."eventKey",r."scopeKind",r."scopeKey"))) THEN RAISE EXCEPTION 'Accepted-input cutover: binding preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM cutover_expected e WHERE mapping='scope' AND NOT EXISTS (SELECT 1 FROM "ScopeState" t WHERE t."scopeKind"::text=e.row->>'scopeKind' AND t."scopeKey"::text=e.row->>'scopeKey' AND t.version=0 AND (t."scopeKind" NOT IN ('bankEvent','purchaseEvent') OR EXISTS(SELECT 1 FROM "EvidenceBinding" b WHERE b."scopeKind"=t."scopeKind" AND b."scopeKey"=t."scopeKey" AND b.basis='baseline')))) THEN RAISE EXCEPTION 'Accepted-input cutover: scope preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM cutover_expected e WHERE mapping='dirty' AND NOT EXISTS (SELECT 1 FROM "ScopeDirty" t WHERE t."scopeKind"=e.row->>'scopeKind' AND t."scopeKey"=e.row->>'scopeKey')) THEN RAISE EXCEPTION 'Accepted-input cutover: cancelled ask scope preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM cutover_expected e CROSS JOIN LATERAL jsonb_populate_record(NULL::"Decision",e.row) r WHERE mapping='decision' AND NOT EXISTS (SELECT 1 FROM "Decision" t WHERE t."id"=r."id" AND ROW(t."id",t."channel",t."subject",t."slot",t."field",t."kind",t."value",t."other",t."actorKind",t."actorId",t."at") IS NOT DISTINCT FROM ROW(r."id",r."channel",r."subject",r."slot",r."field",r."kind",r."value",r."other",r."actorKind",r."actorId",r."at"))) THEN RAISE EXCEPTION 'Accepted-input cutover: decision preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM cutover_expected e CROSS JOIN LATERAL jsonb_populate_record(NULL::"Ask",e.row) r WHERE mapping='ask' AND NOT EXISTS (SELECT 1 FROM "Ask" t WHERE t."id"=r."id" AND ROW(t."id",t."inputHash",t."feature",t."producer",t."promptVersion",t."input",t."state",t."cancelledAt",t."availableAt",t."attempts",t."maxAttempts",t."lastError",t."createdAt",t."executor") IS NOT DISTINCT FROM ROW(r."id",r."inputHash",r."feature",r."producer",r."promptVersion",r."input",r."state",r."cancelledAt",r."availableAt",r."attempts",r."maxAttempts",r."lastError",r."createdAt",r."executor"))) THEN RAISE EXCEPTION 'Accepted-input cutover: ask preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM cutover_expected e CROSS JOIN LATERAL jsonb_populate_record(NULL::"Answer",e.row) r WHERE mapping='answer' AND NOT EXISTS (SELECT 1 FROM "Answer" t WHERE t."inputHash"=r."inputHash" AND ROW(t."inputHash",t."feature",t."producer",t."promptVersion",t."output",t."model",t."askId",t."runId",t."createdAt") IS NOT DISTINCT FROM ROW(r."inputHash",r."feature",r."producer",r."promptVersion",e.row->'output',r."model",r."askId",r."runId",r."createdAt"))) THEN RAISE EXCEPTION 'Accepted-input cutover: answer preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM cutover_expected e CROSS JOIN LATERAL jsonb_populate_record(NULL::"AskScope",e.row) r WHERE mapping='askScope' AND NOT EXISTS (SELECT 1 FROM "AskScope" t WHERE t."askId"=r."askId" AND t."scopeKind"=r."scopeKind" AND t."scopeKey"=r."scopeKey" AND (e.source_id NOT LIKE 'AiEvaluationRequest:%' OR ROW(t.receipt,t.sequence,t."cancelledAt") IS NOT DISTINCT FROM ROW(r.receipt,r.sequence,r."cancelledAt")))) THEN RAISE EXCEPTION 'Accepted-input cutover: askScope preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM "SourceOccurrence" o
 LEFT JOIN cutover_expected e ON e.mapping='recordKey' AND e.row->>'scopeKind'='bankEvent' AND e.row->>'scopeKey'=o.id::text AND e.row->>'entity'='financialTransaction' AND e.row->>'naturalKey'='legacy:'||o."acceptedTransactionId"
 LEFT JOIN "RecordKey" k ON k."scopeKind"='bankEvent' AND k."scopeKey"=o.id::text AND k.entity='financialTransaction' AND k."naturalKey"='legacy:'||o."acceptedTransactionId" AND k."entityId"::text=e.row->>'entityId'
 WHERE o."deletedAt" IS NULL AND o."withdrawnAt" IS NULL AND o."supersededByOccurrenceId" IS NULL AND o.disposition IS DISTINCT FROM 'ignored' AND o."acceptedTransactionId" IS NOT NULL AND (e.source_id IS NULL OR k."entityId" IS NULL)) THEN RAISE EXCEPTION 'Accepted-input cutover: accepted occurrence preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM "Entity" e JOIN "RecordKey" k ON k."naturalKey"='legacy:'||e.id WHERE e."mergedIntoId" IS NOT NULL AND k."mergedAt" IS NULL) THEN RAISE EXCEPTION 'Accepted-input cutover: absorbed scope preservation mismatch'; END IF;
END $verify$;

--> statement-breakpoint
-- Preserve authority preimages as evidence before contraction. AuditLog itself stays.
CREATE SCHEMA IF NOT EXISTS archive;
CREATE TABLE archive."AuditLog_authority_preimage" AS SELECT id,authority,"automationPending" FROM "AuditLog";
--> statement-breakpoint
DO $verify$ BEGIN
 IF EXISTS(SELECT 1 WHERE (SELECT count(*) FROM "AuditLog")<>(SELECT count(*) FROM archive."AuditLog_authority_preimage")) THEN RAISE EXCEPTION 'Accepted-input cutover: audit count preservation mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM "AuditLog" a FULL JOIN archive."AuditLog_authority_preimage" b USING(id) WHERE a.id IS NULL OR b.id IS NULL OR a.authority IS DISTINCT FROM b.authority OR a."automationPending" IS DISTINCT FROM b."automationPending") THEN RAISE EXCEPTION 'Accepted-input cutover: audit preimage preservation mismatch'; END IF;
END $verify$;
--> statement-breakpoint
DROP INDEX "AuditLog_automationPending_idx";
DROP INDEX "AuditLog_automatic_createdAt_idx";
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_authority_check", DROP COLUMN authority, DROP COLUMN "automationPending";

--> statement-breakpoint
CREATE TABLE archive."AiEvaluation_preimage" AS TABLE "AiEvaluation";
CREATE TABLE archive."AiEvaluationRequest_preimage" AS TABLE "AiEvaluationRequest";
--> statement-breakpoint
DO $verify$ BEGIN
 -- Terminal work with no paid result or attempt is history, preserved exactly in the archive.
 IF EXISTS (SELECT 1 WHERE (SELECT count(*) FROM "AiEvaluation")<>(SELECT count(*) FROM archive."AiEvaluation_preimage") OR (SELECT count(*) FROM "AiEvaluation")<>(
 SELECT count(*) FROM "AiEvaluation" source LEFT JOIN cutover_expected e ON e.source_id='AiEvaluation:'||source.id AND e.mapping=CASE WHEN source.result IS NULL OR EXISTS(SELECT 1 FROM "AiEvaluationRequest" r WHERE r."evaluationId"=source.id) THEN 'ask' ELSE 'answer' END
 LEFT JOIN "Ask" carried ON e.mapping='ask' AND carried.id=(e.row->>'id')::uuid
 LEFT JOIN "Answer" paid ON e.mapping='answer' AND paid."inputHash"=e.row->>'inputHash'
 JOIN archive."AiEvaluation_preimage" archived ON archived.id=source.id
 WHERE carried.id IS NOT NULL OR paid."inputHash" IS NOT NULL OR source.result IS NULL AND source.state IN ('completed','failed','cancelled','obsolete') AND source.attempts=0 AND source."leaseToken" IS NULL)) THEN RAISE EXCEPTION 'Accepted-input cutover: evaluation count preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 WHERE (SELECT count(*) FROM "AiEvaluationRequest")<>(SELECT count(*) FROM archive."AiEvaluationRequest_preimage") OR (SELECT count(*) FROM "AiEvaluationRequest")<>(
 SELECT count(*) FROM "AiEvaluationRequest" source JOIN "AiEvaluation" evaluation ON evaluation.id=source."evaluationId"
 JOIN archive."AiEvaluationRequest_preimage" archived ON archived.id=source.id
 LEFT JOIN cutover_expected e ON e.mapping='ask' AND e.source_id='AiEvaluation:'||source."evaluationId"
 LEFT JOIN "AskScope" carried ON carried."askId"=(e.row->>'id')::uuid AND carried."scopeKind"='run' AND carried."scopeKey"=source."runId"::text
 WHERE carried."askId" IS NOT NULL OR evaluation.result IS NULL AND evaluation.state IN ('completed','failed','cancelled','obsolete') AND evaluation.attempts=0 AND evaluation."leaseToken" IS NULL)) THEN RAISE EXCEPTION 'Accepted-input cutover: requester count preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM "AiEvaluation" a FULL JOIN archive."AiEvaluation_preimage" b USING(id) WHERE to_jsonb(a) IS DISTINCT FROM to_jsonb(b)) THEN RAISE EXCEPTION 'Accepted-input cutover: evaluation preimage preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM "AiEvaluationRequest" a FULL JOIN archive."AiEvaluationRequest_preimage" b USING(id) WHERE to_jsonb(a) IS DISTINCT FROM to_jsonb(b)) THEN RAISE EXCEPTION 'Accepted-input cutover: requester preimage preservation mismatch'; END IF;
END $verify$;
--> statement-breakpoint
ALTER TABLE "AiEvaluationRequest" DROP CONSTRAINT "AiEvaluationRequest_evaluationId_AiEvaluation_id_fk";--> statement-breakpoint
ALTER TABLE "EmailClassificationObservation" DROP CONSTRAINT "EmailClassificationObservation_evaluationId_AiEvaluation_id_fk";--> statement-breakpoint
ALTER TABLE "Suggestion" DROP CONSTRAINT "Suggestion_evaluationId_AiEvaluation_id_fk";--> statement-breakpoint
DROP TABLE "AiEvaluation";--> statement-breakpoint
DROP TABLE "AiEvaluationRequest";--> statement-breakpoint
