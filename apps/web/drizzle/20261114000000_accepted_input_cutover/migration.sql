-- Accepted inputs and retained producer results. Ordinary runner transaction: copy,
-- verification and contraction are atomic. Acquire every lock before the first read.
SET LOCAL lock_timeout='2s';
--> statement-breakpoint
LOCK TABLE "SourceTransactionRecord", "ConnectionCandidateEvidence", "EmailClassificationObservation", "EmailPurchaseDecision", "EmailReview", "EmailFinancialAssociation", "SourceObservationAnnotation", "AiAnalysis", "AiEvaluation", "AiEvaluationRequest", "Answer", "Ask", "AskScope", "AuditLog", "Cookbook", "Decision", "Device", "Entity", "EvidenceBinding", "Expense", "ExpenseAttribution", "FactKey", "FinancialAccount", "FinancialTransaction", "FinancialTransactionAllocation", "GardenEntry", "LedgerTransfer", "Location", "ManualEntry", "Meal", "Planting", "Product", "ProductCategory", "Project", "Purchase", "RecordKey", "Run", "ScopeState", "Shipment", "SourceOccurrence", "SpendingCategory", "Suggestion", "Task", "Vendor" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TEMP TABLE cutover_money ON COMMIT DROP AS
SELECT 'Expense'::text source, id, "purchaseId" owner, date_trunc('month',date)::date month_key,"costMinor" amount FROM "Expense"
UNION ALL SELECT 'Purchase',id,id,date_trunc('month',date)::date,"statedTotalMinor" FROM "Purchase"
UNION ALL SELECT 'FinancialTransaction',id,NULL,date_trunc('month',"transactionDate")::date,"amountMinor" FROM "FinancialTransaction"
UNION ALL SELECT 'FinancialTransactionAllocation',id,"purchaseId",NULL,"amountMinor" FROM "FinancialTransactionAllocation"
UNION ALL SELECT 'LedgerTransfer',id,NULL,date_trunc('month',date)::date,"amountMinor" FROM "LedgerTransfer";
--> statement-breakpoint
CREATE TEMP TABLE cutover_expected ON COMMIT DROP AS
-- cutover:select:start
WITH RECURSIVE redirects AS (
 SELECT id,kind,"mergedIntoId" target, ARRAY[id] path FROM "Entity" WHERE "mergedIntoId" IS NOT NULL
 UNION ALL SELECT r.id,r.kind,e."mergedIntoId",r.path||e.id FROM redirects r JOIN "Entity" e ON e.id=r.target WHERE e."mergedIntoId" IS NOT NULL AND NOT e.id=ANY(r.path)
), survivors AS (SELECT r.id,r.kind,r.target FROM redirects r JOIN "Entity" e ON e.id=r.target WHERE e."mergedIntoId" IS NULL), records AS (
SELECT 'product'::text entity, 'Product'::text table_name, 'fields'::text scope_kind, 'product:' || r.id::text scope_key, r.id, to_jsonb(r) payload, ARRAY['tags','brandId','categoryId','ingredientId','growsPlantId']::text[] fields FROM "Product" r
UNION ALL
SELECT 'cookbook'::text entity, 'Cookbook'::text table_name, 'fields'::text scope_kind, 'cookbook:' || r.id::text scope_key, r.id, to_jsonb(r) payload, ARRAY['productId']::text[] fields FROM "Cookbook" r
UNION ALL
SELECT 'location'::text entity, 'Location'::text table_name, 'fields'::text scope_kind, 'location:' || r.id::text scope_key, r.id, to_jsonb(r) payload, ARRAY[]::text[] fields FROM "Location" r
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
SELECT 'run'::text entity, 'Run'::text table_name, 'fields'::text scope_kind, 'run:' || r.id::text scope_key, r.id, to_jsonb(r) payload, ARRAY[]::text[] fields FROM "Run" r
UNION ALL
SELECT 'device'::text entity, 'Device'::text table_name, 'fields'::text scope_kind, 'device:' || r.id::text scope_key, r.id, to_jsonb(r) payload, ARRAY['productId']::text[] fields FROM "Device" r
UNION ALL
SELECT 'spendingCategory'::text entity, 'SpendingCategory'::text table_name, 'fields'::text scope_kind, 'spendingCategory:' || r.id::text scope_key, r.id, to_jsonb(r) payload, ARRAY['emoji','itemizationExpectation','productExpectation']::text[] fields FROM "SpendingCategory" r
UNION ALL
SELECT 'financialTransaction', 'FinancialTransaction', 'bankEvent', coalesce((SELECT min(o.id::text) FROM "SourceOccurrence" o WHERE o."acceptedTransactionId"=r.id),'manual:'||r.id), r.id, (to_jsonb(r)-'amountMinor')||jsonb_build_object('amount',coalesce(to_jsonb(r)->>'amountMinor',((to_jsonb(r)->>'amount')::numeric*100)::text)), ARRAY['accountId','kind','status','amount','transactionDate','postedDate','merchant','rawDescription','sourceCategory','notes','spendingCategoryId','itemizationExpectation']::text[] FROM "FinancialTransaction" r
UNION ALL
SELECT 'purchase', 'Purchase', 'purchaseEvent', coalesce((SELECT min(a."transactionId"::text) FROM "FinancialTransactionAllocation" a WHERE a."purchaseId"=r.id AND a."deletedAt" IS NULL),r.id::text), r.id, (to_jsonb(r)-'statedTotalMinor')||jsonb_build_object('statedTotal',coalesce(to_jsonb(r)->>'statedTotalMinor',((to_jsonb(r)->>'statedTotal')::numeric*100)::text)), ARRAY['vendorId','vendorAccountId','purchaserOverrideId','defaultProjectId','defaultTrade','spendingCategoryId','spendingCategoryOrigin','itemizationExpectation','orderId','displayLabel','date','statedTotal','notes']::text[] FROM "Purchase" r
UNION ALL
SELECT 'expense', 'Expense', 'purchaseEvent', coalesce((SELECT coalesce((SELECT min(a."transactionId"::text) FROM "FinancialTransactionAllocation" a WHERE a."purchaseId"=p.id AND a."deletedAt" IS NULL),p.id::text) FROM "Purchase" p WHERE p.id=r."purchaseId"),r.id::text), r.id, (to_jsonb(r)-'costMinor')||jsonb_build_object('cost',coalesce(to_jsonb(r)->>'costMinor',((to_jsonb(r)->>'cost')::numeric*100)::text)), ARRAY['name','cost','date','lineKind','lineBasis','costType','trade','url','notes','future','projectId','productId','productQuantity','purchaseId','spendingCategoryId','economicRole','bookingTransactionCode']::text[] FROM "Expense" r
UNION ALL
SELECT 'FinancialTransactionAllocation', 'FinancialTransactionAllocation', 'purchaseEvent', r."transactionId"::text, r.id, (to_jsonb(r)-'amountMinor')||jsonb_build_object('amountMinor',r."amountMinor"::text), ARRAY['transactionId','purchaseId','amountMinor','confirmsMerchant']::text[] FROM "FinancialTransactionAllocation" r
UNION ALL
SELECT 'ExpenseAttribution', 'ExpenseAttribution', 'purchaseEvent', coalesce((SELECT coalesce((SELECT min(a."transactionId"::text) FROM "FinancialTransactionAllocation" a WHERE a."purchaseId"=e."purchaseId" AND a."deletedAt" IS NULL),e."purchaseId"::text,e.id::text) FROM "Expense" e WHERE e.id=r."expenseId"),r.id::text), r.id, to_jsonb(r), ARRAY['expenseId','role','ledgerPartyId','weight']::text[] FROM "ExpenseAttribution" r
UNION ALL
SELECT 'ledgerTransfer', 'LedgerTransfer', 'transfer', r.id::text, r.id, to_jsonb(r), ARRAY[]::text[] FROM "LedgerTransfer" r
UNION ALL
SELECT 'shipment', 'Shipment', 'shipment', r.id::text, r.id, to_jsonb(r), ARRAY[]::text[] FROM "Shipment" r
), field_values AS (
 SELECT r.*, f.field, r.payload->f.field value, a.id audit_id, a.authority,
 a."userId", a."oauthClientId", a."createdAt" audit_at, a.changes,
 -- Only an exact, affirmative automatic trail establishes Cubby ownership.
 a.authority IN ('automatic','released') AND a.changes->f.field->'to'=r.payload->f.field cubby_holds
 FROM records r CROSS JOIN LATERAL unnest(r.fields) f(field)
 LEFT JOIN LATERAL (SELECT a.* FROM "AuditLog" a WHERE a."entityKind"=r.entity AND a."entityId"=r.id
   AND (a.changes ? f.field OR a.action='create') ORDER BY a."createdAt" DESC,a.id DESC LIMIT 1) a ON true
), source_answers AS (
 SELECT 'AiEvaluation'::text source_table, e.id, to_jsonb(e) legacy, e.feature, e.provenance->>'model' model,
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
 jsonb_build_object('entity',s.entity,'recordId',s."recordId") FROM "Suggestion" s
 -- Preserve complete proposals, including negative/undecided paid results and review receipts.
), imports AS (
 SELECT *, 'legacy:'||source_table||':'||id::text hash, CASE WHEN source_table='Suggestion' AND (legacy->'producer'->>'kind'='rule' OR legacy->>'model'='rule') THEN 'source' ELSE 'model' END producer FROM source_answers
), review_events AS (
 SELECT s.id, d.event, d.ord FROM "Suggestion" s CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.decisions)='array' THEN s.decisions ELSE '[]'::jsonb END) WITH ORDINALITY d(event,ord)
 UNION ALL
 SELECT s.id,jsonb_build_object('verdict',CASE WHEN s.suppression IS NOT NULL THEN 'wrong' ELSE 'correct' END,
 'intent','apply','correction',CASE WHEN s."confirmedValue"->>'present'='true' THEN s."confirmedValue" ELSE jsonb_build_object('present',s."correctValue" IS NOT NULL,'value',s."correctValue") END,
 'authority',CASE WHEN s."acceptanceReceipt"->>'mode'='automatic' THEN 'automatic' ELSE 'unknown' END,
 'createdAt',coalesce(s."acceptanceReceipt"->>'acceptedAt',(now() AT TIME ZONE 'UTC')::text)),
 0::bigint FROM "Suggestion" s WHERE jsonb_array_length(CASE WHEN jsonb_typeof(s.decisions)='array' THEN s.decisions ELSE '[]'::jsonb END)=0
 AND (s.suppression IS NOT NULL OR s."confirmedValue"->>'present'='true' OR s."acceptanceReceipt"->>'mode'='member')
), reviews AS (
 SELECT s.*, d.event, d.ord,
 CASE WHEN d.event->'correction'->>'present'='true' THEN d.event->'correction'->'value' ELSE s."suggestedValue" END accepted
 FROM "Suggestion" s JOIN review_events d ON d.id=s.id
 WHERE d.event->>'authority' IS DISTINCT FROM 'automatic'
), statement_applications AS (
 SELECT v.*,o.id occurrence_id,o."acceptedTransactionId" transaction_id
 FROM reviews v JOIN "SourceTransactionRecord" observation ON observation.id=v."recordId"
 JOIN "SourceOccurrence" o ON o.id=observation."occurrenceId"
 WHERE v.family='statement_transaction' AND v.event->>'authority'='member'
), expected AS (
 SELECT 'recordKey'::text mapping, entity||':'||id source_id,
 jsonb_build_object('scopeKind',scope_kind,'scopeKey',scope_key,'entity',entity,'naturalKey','legacy:'||id,'entityId',coalesce((SELECT target FROM survivors WHERE survivors.id=records.id),id),'rejectedAt',CASE WHEN EXISTS(SELECT 1 FROM survivors WHERE survivors.id=records.id) THEN NULL ELSE payload->'deletedAt' END) row
 FROM records
 UNION ALL
 SELECT 'manualEntry',entity||':'||id,
 jsonb_build_object('id',md5('cutover:'||entity||':'||id)::uuid,'entity',entity,'userId','legacy:unknown',
 'payload',jsonb_build_object('table',table_name,'naturalKey','legacy:'||id,'values',CASE WHEN cardinality(fields)>0 THEN (SELECT jsonb_object_agg(f,payload->f) FROM unnest(fields) f) ELSE payload END,'legacy',payload,'acceptedScope',jsonb_build_object('kind',scope_kind,'key',scope_key)))
 FROM records
 UNION ALL
 SELECT 'binding',entity||':'||id,jsonb_build_object('factKind','manualEntry','factId',md5('cutover:'||entity||':'||id)::uuid,'basis','baseline','eventKey',CASE WHEN scope_kind='fields' THEN 'baseline:snapshot:'||entity||':'||id ELSE id::text END,'scopeKind',scope_kind,'scopeKey',scope_key) FROM records
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
 'actorKind',CASE WHEN audit_id IS NULL OR authority IS NOT NULL OR changes->field->'to' IS DISTINCT FROM value THEN 'system' WHEN "oauthClientId" IS NOT NULL THEN 'agent' ELSE 'member' END,
 'actorId',CASE WHEN authority IS NULL AND changes->field->'to'=value THEN "userId" END,'at',now() AT TIME ZONE 'UTC')
 FROM field_values WHERE cubby_holds IS NOT TRUE
 UNION ALL
 SELECT 'answer',entity||':'||id||':'||field,jsonb_build_object('inputHash','legacy:field:'||entity||':'||id||':'||field,'feature','legacy:field','producer','model','promptVersion','legacy:unknown',
 'output',jsonb_build_object('value',value,'auditId',audit_id,'subject',entity||':'||id,'field',field),'createdAt',audit_at) FROM field_values WHERE cubby_holds
 UNION ALL
 SELECT 'ask',source_table||':'||id,jsonb_build_object('id',id,'inputHash',hash,'feature','legacy:'||feature,'producer',producer,'promptVersion',prompt_version,
 'input',jsonb_build_object('legacy',legacy,'sourceTable',source_table),'state',state,'cancelledAt',CASE WHEN cancelled THEN legacy->'updatedAt' END,
 'availableAt',available_at,'attempts',attempts,'maxAttempts',greatest(3,attempts+1),'lastError',error,'waitCause',CASE WHEN legacy->>'waitCause' IN ('funding','provider_capacity','in_flight','rate_limit','device') THEN legacy->>'waitCause' END,'createdAt',created_at,'executor','legacy') FROM imports
 UNION ALL
 SELECT 'answer',source_table||':'||id,jsonb_build_object('inputHash',hash,'feature','legacy:'||feature,'producer',producer,'promptVersion',prompt_version,
 'output',jsonb_build_object('result',result,'legacy',legacy,'sourceTable',source_table),'model',model,'askId',id,'runId',run_id,'createdAt',created_at) FROM imports WHERE result IS NOT NULL
 UNION ALL
 SELECT 'askScope',source_table||':'||id||':owner',jsonb_build_object('askId',id,'scopeKind','run','scopeKey',run_id,'runId',run_id,'receipt',legacy->'receipt','createdAt',created_at) FROM imports WHERE run_id IS NOT NULL
 UNION ALL
 SELECT 'askScope',source_table||':'||id||':record',jsonb_build_object('askId',id,'scopeKind',CASE WHEN target->>'entity' IN ('product','cookbook','location','meal','project','task','vendor','financialAccount','planting','gardenEntry','productCategory','run','device','spendingCategory') THEN 'fields' ELSE 'record' END,
 'scopeKey',(target->>'entity')||':'||(target->>'recordId'),'createdAt',created_at) FROM imports WHERE target->>'recordId' IS NOT NULL
 UNION ALL
 SELECT 'askScope','AiEvaluationRequest:'||r.id,jsonb_build_object('askId',r."evaluationId",'scopeKind','run','scopeKey',r."runId",'runId',r."runId",'receipt',r.receipt,'sequence',r.sequence,'cancelledAt',r."cancelledAt",'createdAt',r."createdAt") FROM "AiEvaluationRequest" r
 UNION ALL
 SELECT 'decision','Suggestion:'||id||':'||ord,jsonb_build_object('id',md5('cutover-review:'||id||':'||ord)::uuid,'channel',CASE WHEN event->>'verdict' IN ('wrong','dismissed') THEN 'veto' ELSE 'assignment' END,
 'subject',entity||':'||"recordId",'slot',CASE WHEN event->>'verdict' IN ('wrong','dismissed') THEN field||chr(31)||encode(sha256(convert_to("suggestedValue"::text,'UTF8')),'hex') ELSE field END,'field',field,'kind',CASE WHEN event->>'verdict' IN ('wrong','dismissed') THEN 'veto' WHEN accepted='null'::jsonb THEN 'none' ELSE 'set' END,
 'value',CASE WHEN event->>'verdict' IN ('wrong','dismissed') THEN "suggestedValue" ELSE accepted END,'actorKind',CASE WHEN event->>'authority'='member' THEN 'member' ELSE 'system' END,'actorId',event->>'actorUserId','at',(event->>'createdAt')::timestamp)
 FROM reviews WHERE field<>'' AND "recordId" IS NOT NULL AND event->>'verdict' IN ('correct','wrong','dismissed') AND (event->>'verdict'<>'correct' OR event->>'intent'='apply')
UNION ALL
SELECT 'decision','EmailPurchaseDecision:'||r.id,jsonb_build_object('id',md5('cutover:EmailPurchaseDecision:'||r.id)::uuid,'channel','assignment','subject',CASE WHEN r."emailId" IS NOT NULL THEN 'email:'||r."emailId" ELSE 'emailEvent:'||r."eventId" END,'slot','purchaseId','field','purchaseId','kind','set','value',CASE WHEN r.decision='linked' THEN to_jsonb(r."purchaseId") ELSE to_jsonb(false) END,'actorKind',CASE WHEN r.authority='member' THEN 'member' ELSE 'system' END,'actorId',r."decidedByUserId",'at',r."updatedAt") FROM "EmailPurchaseDecision" r WHERE r.authority<>'automatic'
UNION ALL
SELECT 'decision','EmailReview:'||r.id,jsonb_build_object('id',md5('cutover:EmailReview:'||r.id)::uuid,'channel','assignment','subject','email:'||coalesce(r."emailId",r."originalId",r."subjectId"),'slot','review:'||r."subjectId",'field','review:'||r."subjectId",'kind','set','value',to_jsonb(r),'actorKind',CASE WHEN r.authority='member' THEN 'member' ELSE 'system' END,'actorId',r."actorUserId",'at',r."createdAt") FROM "EmailReview" r WHERE r.authority<>'automatic'
UNION ALL
SELECT 'decision','EmailFinancialAssociation:'||r.id,jsonb_build_object('id',md5('cutover:EmailFinancialAssociation:'||r.id)::uuid,'channel','assignment','subject','email:'||r."emailId",'slot','financialAssociation:'||r."transactionId",'field','financialAssociation:'||r."transactionId",'kind','set','value',to_jsonb(r),'actorKind','member','actorId',r."decidedByUserId",'at',r."createdAt") FROM "EmailFinancialAssociation" r WHERE true
UNION ALL
SELECT 'decision','SourceObservationAnnotation:'||r."observationId",jsonb_build_object('id',md5('cutover:SourceObservationAnnotation:'||r."observationId")::uuid,'channel','assignment','subject','sourceTransactionRecord:'||r."observationId",'slot','annotation','field','annotation','kind','set','value',to_jsonb(r),'actorKind','system','actorId',NULL,'at',r."updatedAt") FROM "SourceObservationAnnotation" r WHERE true
UNION ALL
SELECT 'decision','Suggestion:'||r.id,jsonb_build_object('id',md5('cutover:Suggestion:'||r.id)::uuid,'channel','assignment','subject','legacy:suggestion:'||r.id,'slot','review','field','review','kind','set','value',to_jsonb(r),'actorKind','system','actorId',NULL,'at',r."updatedAt") FROM "Suggestion" r WHERE r.field='' AND (jsonb_array_length(r.decisions)>0 OR r.suppression IS NOT NULL OR r."confirmedValue" IS NOT NULL)
UNION ALL
SELECT 'decision','AuditLog:release:'||a.id||':'||f.key,jsonb_build_object('id',md5('cutover:release:'||a.id||':'||f.key)::uuid,'channel','assignment','subject',a."entityKind"||':'||a."entityId",'slot',f.key,'field',f.key,'kind','release','value',NULL,'actorKind',CASE WHEN a."oauthClientId" IS NULL THEN 'member' ELSE 'agent' END,'actorId',a."userId",'at',a."createdAt") FROM "AuditLog" a CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(a.changes)='object' THEN a.changes ELSE '{}'::jsonb END) f WHERE a.authority='released' AND EXISTS(SELECT 1 FROM records r WHERE r.entity=a."entityKind" AND r.id=a."entityId" AND f.key=ANY(r.fields))

UNION ALL
SELECT 'decision','AuditLog:held:'||a.id||':'||f.key,jsonb_build_object('id',md5('cutover:audit-held:'||a.id||':'||f.key)::uuid,'channel','assignment','subject',a."entityKind"||':'||a."entityId",'slot',f.key,'field',f.key,'kind',CASE WHEN f.value->'to'='null'::jsonb THEN 'none' ELSE 'set' END,'value',f.value->'to','actorKind',CASE WHEN a."oauthClientId" IS NULL THEN 'member' ELSE 'agent' END,'actorId',a."userId",'at',a."createdAt") FROM "AuditLog" a CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(a.changes)='object' THEN a.changes ELSE '{}'::jsonb END) f WHERE a.authority IS NULL AND f.value ? 'to' AND EXISTS(SELECT 1 FROM records r WHERE r.entity=a."entityKind" AND r.id=a."entityId" AND f.key=ANY(r.fields))

UNION ALL
SELECT 'decision','Suggestion:correction-veto:'||id||':'||ord,jsonb_build_object('id',md5('cutover:correction-veto:'||id||':'||ord)::uuid,
 'channel','veto','subject',entity||':'||"recordId",'slot',field||chr(31)||encode(sha256(convert_to("suggestedValue"::text,'UTF8')),'hex'),'field',field,'kind','veto','value',"suggestedValue",
 'actorKind',CASE WHEN event->>'authority'='member' THEN 'member' ELSE 'system' END,'actorId',event->>'actorUserId','at',(event->>'createdAt')::timestamp)
FROM reviews WHERE field<>'' AND "recordId" IS NOT NULL AND event->>'verdict'='correct' AND event->>'intent'='apply' AND event->'correction'->>'present'='true' AND accepted IS DISTINCT FROM "suggestedValue"
UNION ALL
SELECT 'decision','Suggestion:review:'||id||':'||ord,jsonb_build_object('id',md5('cutover:review-event:'||id||':'||ord)::uuid,
 'channel','assignment','subject','legacy:suggestion:'||id,'slot','review:'||ord,'field','review','kind','set','value',event,
 'actorKind',CASE WHEN event->>'authority'='member' THEN 'member' ELSE 'system' END,'actorId',event->>'actorUserId','at',(event->>'createdAt')::timestamp)
FROM reviews WHERE field=''

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
SELECT 'decision','SourceAccount:'||n."observationId",jsonb_build_object('id',md5('cutover:source-account:'||n."observationId")::uuid,
 'channel','assignment','subject','bank:'||o."occurrenceId",'slot','accountId','field','accountId','kind','set','value',n."accountId",'actorKind','system','actorId',NULL,'at',n."updatedAt")
FROM "SourceObservationAnnotation" n JOIN "SourceTransactionRecord" o ON o.id=n."observationId" WHERE n."accountId" IS NOT NULL
UNION ALL
SELECT 'decision','Rejected:'||entity||':'||id,jsonb_build_object('id',md5('cutover:rejected:'||entity||':'||id)::uuid,
 'channel','rejection','subject',entity||':'||id,'slot','','kind','reject','value',NULL,'actorKind','system','actorId',NULL,'at',payload->'deletedAt')
FROM records WHERE payload->>'deletedAt' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM survivors WHERE survivors.id=records.id)
), empty_scopes AS (
 SELECT DISTINCT e.row->>'scopeKind' kind,e.row->>'scopeKey' key FROM expected e WHERE e.mapping='scope'
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
INSERT INTO "RecordKey" ("scopeKind","scopeKey","entity","naturalKey","entityId","rejectedAt")
SELECT r."scopeKind",r."scopeKey",r."entity",r."naturalKey",r."entityId",r."rejectedAt" FROM cutover_expected e
CROSS JOIN LATERAL jsonb_populate_record(NULL::"RecordKey",e.row) r
WHERE e.mapping='recordKey'
ON CONFLICT ("scopeKind","scopeKey",entity,"naturalKey") DO UPDATE SET "entityId"=excluded."entityId","rejectedAt"=excluded."rejectedAt";
--> statement-breakpoint
INSERT INTO "ManualEntry" ("id","entity","userId","payload")
SELECT r."id",r."entity",r."userId",r."payload" FROM cutover_expected e
CROSS JOIN LATERAL jsonb_populate_record(NULL::"ManualEntry",e.row) r
WHERE e.mapping='manualEntry'
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
SELECT r."inputHash",r."feature",r."producer",r."promptVersion",r."output",r."model",r."askId",r."runId",r."createdAt" FROM cutover_expected e
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
INSERT INTO "FactKey" (key,"factKind","factId")
SELECT row->'payload'->'acceptedScope'->>'kind'||':'||(row->'payload'->'acceptedScope'->>'key'),'manualEntry',row->>'id'
FROM cutover_expected WHERE mapping='manualEntry' ON CONFLICT DO NOTHING;
--> statement-breakpoint
DO $verify$ BEGIN

 IF EXISTS (
 SELECT 1 FROM cutover_money m LEFT JOIN cutover_expected e ON e.mapping='manualEntry' AND e.row->'payload'->>'table'=m.source AND e.row->'payload'->>'naturalKey'='legacy:'||m.id
 WHERE (CASE m.source WHEN 'Expense' THEN e.row->'payload'->'values'->>'cost' WHEN 'Purchase' THEN e.row->'payload'->'values'->>'statedTotal' ELSE coalesce(e.row->'payload'->'values'->>'amountMinor',e.row->'payload'->'values'->>'amount') END)::numeric IS DISTINCT FROM m.amount::numeric
 ) THEN RAISE EXCEPTION 'Accepted-input cutover: money row preservation mismatch'; END IF;
 IF EXISTS (
 SELECT 1 FROM cutover_money m JOIN cutover_expected e ON e.mapping='manualEntry' AND e.row->'payload'->>'table'=m.source AND e.row->'payload'->>'naturalKey'='legacy:'||m.id
 GROUP BY GROUPING SETS ((m.source),(m.source,m.owner),(m.source,m.month_key))
 HAVING sum(m.amount) IS DISTINCT FROM sum((CASE m.source WHEN 'Expense' THEN e.row->'payload'->'values'->>'cost' WHEN 'Purchase' THEN e.row->'payload'->'values'->>'statedTotal' ELSE coalesce(e.row->'payload'->'values'->>'amountMinor',e.row->'payload'->'values'->>'amount') END)::numeric)
 ) THEN RAISE EXCEPTION 'Accepted-input cutover: money totals preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM cutover_expected e WHERE mapping='recordKey' AND NOT EXISTS (SELECT 1 FROM "RecordKey" t WHERE t."scopeKind"::text=e.row->>'scopeKind' AND t."scopeKey"::text=e.row->>'scopeKey' AND t."entity"::text=e.row->>'entity' AND t."naturalKey"::text=e.row->>'naturalKey' AND coalesce(to_jsonb(t)->'scopeKind','null'::jsonb)=coalesce(e.row->'scopeKind','null'::jsonb) AND coalesce(to_jsonb(t)->'scopeKey','null'::jsonb)=coalesce(e.row->'scopeKey','null'::jsonb) AND coalesce(to_jsonb(t)->'entity','null'::jsonb)=coalesce(e.row->'entity','null'::jsonb) AND coalesce(to_jsonb(t)->'naturalKey','null'::jsonb)=coalesce(e.row->'naturalKey','null'::jsonb) AND coalesce(to_jsonb(t)->'entityId','null'::jsonb)=coalesce(e.row->'entityId','null'::jsonb) AND coalesce(to_jsonb(t)->'rejectedAt','null'::jsonb)=coalesce(e.row->'rejectedAt','null'::jsonb))) THEN RAISE EXCEPTION 'Accepted-input cutover: recordKey preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM cutover_expected e WHERE mapping='manualEntry' AND NOT EXISTS (SELECT 1 FROM "ManualEntry" t WHERE t."id"::text=e.row->>'id' AND coalesce(to_jsonb(t)->'id','null'::jsonb)=coalesce(e.row->'id','null'::jsonb) AND coalesce(to_jsonb(t)->'entity','null'::jsonb)=coalesce(e.row->'entity','null'::jsonb) AND coalesce(to_jsonb(t)->'userId','null'::jsonb)=coalesce(e.row->'userId','null'::jsonb) AND coalesce(to_jsonb(t)->'payload','null'::jsonb)=coalesce(e.row->'payload','null'::jsonb))) THEN RAISE EXCEPTION 'Accepted-input cutover: manualEntry preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM cutover_expected e WHERE mapping='binding' AND NOT EXISTS (SELECT 1 FROM "EvidenceBinding" t WHERE t."factKind"::text=e.row->>'factKind' AND t."factId"::text=e.row->>'factId' AND t."basis"::text=e.row->>'basis' AND coalesce(to_jsonb(t)->'factKind','null'::jsonb)=coalesce(e.row->'factKind','null'::jsonb) AND coalesce(to_jsonb(t)->'factId','null'::jsonb)=coalesce(e.row->'factId','null'::jsonb) AND coalesce(to_jsonb(t)->'basis','null'::jsonb)=coalesce(e.row->'basis','null'::jsonb) AND coalesce(to_jsonb(t)->'eventKey','null'::jsonb)=coalesce(e.row->'eventKey','null'::jsonb) AND coalesce(to_jsonb(t)->'scopeKind','null'::jsonb)=coalesce(e.row->'scopeKind','null'::jsonb) AND coalesce(to_jsonb(t)->'scopeKey','null'::jsonb)=coalesce(e.row->'scopeKey','null'::jsonb))) THEN RAISE EXCEPTION 'Accepted-input cutover: binding preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM cutover_expected e WHERE mapping='scope' AND NOT EXISTS (SELECT 1 FROM "ScopeState" t WHERE t."scopeKind"::text=e.row->>'scopeKind' AND t."scopeKey"::text=e.row->>'scopeKey' AND t.version=0 AND EXISTS(SELECT 1 FROM "EvidenceBinding" b WHERE b."scopeKind"=t."scopeKind" AND b."scopeKey"=t."scopeKey" AND b.basis='baseline'))) THEN RAISE EXCEPTION 'Accepted-input cutover: scope preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM cutover_expected e WHERE mapping='decision' AND NOT EXISTS (SELECT 1 FROM "Decision" t WHERE t."id"::text=e.row->>'id' AND coalesce(to_jsonb(t)->'id','null'::jsonb)=coalesce(e.row->'id','null'::jsonb) AND coalesce(to_jsonb(t)->'channel','null'::jsonb)=coalesce(e.row->'channel','null'::jsonb) AND coalesce(to_jsonb(t)->'subject','null'::jsonb)=coalesce(e.row->'subject','null'::jsonb) AND coalesce(to_jsonb(t)->'slot','null'::jsonb)=coalesce(e.row->'slot','null'::jsonb) AND coalesce(to_jsonb(t)->'field','null'::jsonb)=coalesce(e.row->'field','null'::jsonb) AND coalesce(to_jsonb(t)->'kind','null'::jsonb)=coalesce(e.row->'kind','null'::jsonb) AND coalesce(to_jsonb(t)->'value','null'::jsonb)=coalesce(e.row->'value','null'::jsonb) AND coalesce(to_jsonb(t)->'other','null'::jsonb)=coalesce(e.row->'other','null'::jsonb) AND coalesce(to_jsonb(t)->'actorKind','null'::jsonb)=coalesce(e.row->'actorKind','null'::jsonb) AND coalesce(to_jsonb(t)->'actorId','null'::jsonb)=coalesce(e.row->'actorId','null'::jsonb) AND coalesce(to_jsonb(t)->'at','null'::jsonb)=coalesce(e.row->'at','null'::jsonb))) THEN RAISE EXCEPTION 'Accepted-input cutover: decision preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM cutover_expected e WHERE mapping='ask' AND NOT EXISTS (SELECT 1 FROM "Ask" t WHERE t."id"::text=e.row->>'id' AND coalesce(to_jsonb(t)->'id','null'::jsonb)=coalesce(e.row->'id','null'::jsonb) AND coalesce(to_jsonb(t)->'inputHash','null'::jsonb)=coalesce(e.row->'inputHash','null'::jsonb) AND coalesce(to_jsonb(t)->'feature','null'::jsonb)=coalesce(e.row->'feature','null'::jsonb) AND coalesce(to_jsonb(t)->'producer','null'::jsonb)=coalesce(e.row->'producer','null'::jsonb) AND coalesce(to_jsonb(t)->'promptVersion','null'::jsonb)=coalesce(e.row->'promptVersion','null'::jsonb) AND coalesce(to_jsonb(t)->'input','null'::jsonb)=coalesce(e.row->'input','null'::jsonb) AND coalesce(to_jsonb(t)->'state','null'::jsonb)=coalesce(e.row->'state','null'::jsonb) AND coalesce(to_jsonb(t)->'cancelledAt','null'::jsonb)=coalesce(e.row->'cancelledAt','null'::jsonb) AND coalesce(to_jsonb(t)->'availableAt','null'::jsonb)=coalesce(e.row->'availableAt','null'::jsonb) AND coalesce(to_jsonb(t)->'attempts','null'::jsonb)=coalesce(e.row->'attempts','null'::jsonb) AND coalesce(to_jsonb(t)->'maxAttempts','null'::jsonb)=coalesce(e.row->'maxAttempts','null'::jsonb) AND coalesce(to_jsonb(t)->'lastError','null'::jsonb)=coalesce(e.row->'lastError','null'::jsonb) AND coalesce(to_jsonb(t)->'createdAt','null'::jsonb)=coalesce(e.row->'createdAt','null'::jsonb) AND coalesce(to_jsonb(t)->'executor','null'::jsonb)=coalesce(e.row->'executor','null'::jsonb))) THEN RAISE EXCEPTION 'Accepted-input cutover: ask preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM cutover_expected e WHERE mapping='answer' AND NOT EXISTS (SELECT 1 FROM "Answer" t WHERE t."inputHash"::text=e.row->>'inputHash' AND coalesce(to_jsonb(t)->'inputHash','null'::jsonb)=coalesce(e.row->'inputHash','null'::jsonb) AND coalesce(to_jsonb(t)->'feature','null'::jsonb)=coalesce(e.row->'feature','null'::jsonb) AND coalesce(to_jsonb(t)->'producer','null'::jsonb)=coalesce(e.row->'producer','null'::jsonb) AND coalesce(to_jsonb(t)->'promptVersion','null'::jsonb)=coalesce(e.row->'promptVersion','null'::jsonb) AND coalesce(to_jsonb(t)->'output','null'::jsonb)=coalesce(e.row->'output','null'::jsonb) AND coalesce(to_jsonb(t)->'model','null'::jsonb)=coalesce(e.row->'model','null'::jsonb) AND coalesce(to_jsonb(t)->'askId','null'::jsonb)=coalesce(e.row->'askId','null'::jsonb) AND coalesce(to_jsonb(t)->'runId','null'::jsonb)=coalesce(e.row->'runId','null'::jsonb) AND coalesce(to_jsonb(t)->'createdAt','null'::jsonb)=coalesce(e.row->'createdAt','null'::jsonb))) THEN RAISE EXCEPTION 'Accepted-input cutover: answer preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM cutover_expected e WHERE mapping='askScope' AND NOT EXISTS (SELECT 1 FROM "AskScope" t WHERE t."askId"::text=e.row->>'askId' AND t."scopeKind"::text=e.row->>'scopeKind' AND t."scopeKey"::text=e.row->>'scopeKey' AND (e.source_id NOT LIKE 'AiEvaluationRequest:%' OR (t.receipt IS NOT DISTINCT FROM e.row->'receipt' AND t.sequence=(e.row->>'sequence')::int AND to_jsonb(t."cancelledAt") IS NOT DISTINCT FROM nullif(e.row->'cancelledAt','null'::jsonb))))) THEN RAISE EXCEPTION 'Accepted-input cutover: askScope preservation mismatch'; END IF;
END $verify$;

--> statement-breakpoint
UPDATE "RecordKey" k SET "mergedAt"=e."deletedAt"
FROM "Entity" e WHERE k."naturalKey"='legacy:'||e.id AND e."mergedIntoId" IS NOT NULL;
--> statement-breakpoint
-- Preserve authority preimages as evidence before contraction. AuditLog itself stays.
CREATE SCHEMA IF NOT EXISTS archive;
CREATE TABLE archive."AuditLog_authority_preimage" AS SELECT id,authority,"automationPending" FROM "AuditLog";
--> statement-breakpoint
DO $verify$ BEGIN
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
 IF EXISTS (SELECT 1 FROM "AiEvaluation" a FULL JOIN archive."AiEvaluation_preimage" b USING(id) WHERE to_jsonb(a) IS DISTINCT FROM to_jsonb(b)) THEN RAISE EXCEPTION 'Accepted-input cutover: evaluation preimage preservation mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM "AiEvaluationRequest" a FULL JOIN archive."AiEvaluationRequest_preimage" b USING(id) WHERE to_jsonb(a) IS DISTINCT FROM to_jsonb(b)) THEN RAISE EXCEPTION 'Accepted-input cutover: requester preimage preservation mismatch'; END IF;
END $verify$;
--> statement-breakpoint
ALTER TABLE "AiEvaluationRequest" DROP CONSTRAINT "AiEvaluationRequest_evaluationId_AiEvaluation_id_fk";--> statement-breakpoint
ALTER TABLE "EmailClassificationObservation" DROP CONSTRAINT "EmailClassificationObservation_evaluationId_AiEvaluation_id_fk";--> statement-breakpoint
ALTER TABLE "Suggestion" DROP CONSTRAINT "Suggestion_evaluationId_AiEvaluation_id_fk";--> statement-breakpoint
DROP TABLE "AiEvaluation";--> statement-breakpoint
DROP TABLE "AiEvaluationRequest";--> statement-breakpoint
