-- Adopt retained evidence and member intent without rewriting any money row.
LOCK TABLE "ImportSourceClaim", "ImportSourceOrder", "ImportSourceProduct",
 "SourceOrderObservation", "Purchase", "Expense", "FinancialTransaction",
 "FinancialTransactionAllocation", "ExpenseAttribution", "LedgerTransfer",
 "RecordKey", "EvidenceBinding", "Decision", "FactKey", "ScopeDirty",
 "Email", "OrderMailAttachment", "PurchasePaymentEvidence", "EmailPurchaseDecision",
 "EmailReview", "EmailFinancialAssociation", "EmailClassificationObservation",
 "LedgerParty", "ManualEntry", "SourceObservationAnnotation" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TEMP TABLE order_email_money_before ON COMMIT DROP AS
SELECT 'Expense'::text source, to_jsonb(r) row FROM "Expense" r
UNION ALL SELECT 'FinancialTransaction',to_jsonb(r) FROM "FinancialTransaction" r
UNION ALL SELECT 'Purchase',to_jsonb(r) FROM "Purchase" r
UNION ALL SELECT 'FinancialTransactionAllocation',to_jsonb(r) FROM "FinancialTransactionAllocation" r
UNION ALL SELECT 'ExpenseAttribution',to_jsonb(r) FROM "ExpenseAttribution" r
UNION ALL SELECT 'LedgerTransfer',to_jsonb(r) FROM "LedgerTransfer" r;
--> statement-breakpoint
CREATE TEMP TABLE order_email_sources_before ON COMMIT DROP AS
SELECT id, to_jsonb(o)-ARRAY['ledgerPartyId','emailId','sourceKind','sourceExternalKey'] row
FROM "SourceOrderObservation" o;
--> statement-breakpoint
-- An accepted identity can predate captured extraction. Preserve that absence
-- explicitly instead of deriving a source snapshot from mutable money rows.
CREATE TEMP TABLE order_email_accepted ON COMMIT DROP AS
SELECT accepted.id, coalesce(accepted."acceptedObservationId",
 overlay(overlay(md5('order-email-accepted:'||accepted.id) placing '8' from 13 for 1) placing '8' from 17 for 1)::uuid) AS "observationId"
FROM "ImportSourceOrder" accepted;
--> statement-breakpoint
INSERT INTO "SourceOrderObservation" (id,"sourceClaimId","orderKey","purchaseId","vendorId",
 checksum,extraction,"productBindings","contentFingerprint","createdAt","ledgerPartyId","sourceKind","sourceExternalKey")
SELECT mapped."observationId",accepted."sourceClaimId",accepted."orderKey",accepted."purchaseId",
 split_part(accepted."orderKey",'/',1)::uuid,accepted.checksum,
 coalesce(accepted."originalOrder"->'extraction',jsonb_build_object('status','unreadable',
 'detail','Retained accepted order identity has no captured extraction')),
 coalesce((SELECT jsonb_agg(jsonb_build_object('lineIndex',p."lineIndex",'productId',p."productId",'legacyExpenseId',p."expenseId") ORDER BY p."lineIndex")
 FROM "ImportSourceProduct" p WHERE p."sourceOrderId"=accepted.id),'[]'::jsonb),
 'retained-accepted:'||accepted.id,accepted."createdAt",claim."ledgerPartyId",claim.kind,claim."externalKey"
FROM "ImportSourceOrder" accepted JOIN order_email_accepted mapped ON mapped.id=accepted.id
JOIN "ImportSourceClaim" claim ON claim.id=accepted."sourceClaimId"
WHERE accepted."acceptedObservationId" IS NULL;
--> statement-breakpoint
UPDATE "SourceOrderObservation" o SET
 "ledgerPartyId"=coalesce(o."ledgerPartyId",c."ledgerPartyId"),
 "sourceKind"=CASE WHEN o."sourceExternalKey"='' THEN c.kind ELSE o."sourceKind" END,
 "sourceExternalKey"=CASE WHEN o."sourceExternalKey"='' THEN c."externalKey" ELSE o."sourceExternalKey" END
FROM "ImportSourceClaim" c WHERE c.id=o."sourceClaimId";
--> statement-breakpoint
UPDATE "SourceOrderObservation" o SET "emailId"=e.id
FROM "Email" e WHERE o."emailId" IS NULL AND o."ledgerPartyId"=e."ledgerPartyId"
 AND ((o."sourceKind"='mail_message' AND o."sourceExternalKey"=e.provider||':'||e."mailboxId"||':'||e."messageId")
 OR (o."sourceKind"='mail_attachment' AND EXISTS (
   SELECT 1 FROM "OrderMailAttachment" a WHERE a."orderMailId"=e."orderMailId"
    AND o."sourceExternalKey"=e.provider||':'||e."mailboxId"||':'||e."messageId"||':attachment:'||a."providerAttachmentId")));
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM "SourceOrderObservation" WHERE "ledgerPartyId" IS NULL) THEN
  RAISE EXCEPTION 'Order evidence has no retained member owner';
 END IF;
END $$;
--> statement-breakpoint
-- Freeze the existing order-key normalization, including printed field labels.
CREATE TEMP VIEW order_email_orders AS
SELECT o.*, CASE WHEN o.extraction#>>'{candidate,orderId}' IS NOT NULL THEN
 'order:'||o."ledgerPartyId"||':'||o."vendorId"||'/order/'||
 upper(btrim(regexp_replace(btrim(regexp_replace(regexp_replace(o.extraction#>>'{candidate,orderId}',
 '^\s*(?:[A-Za-z][A-Za-z.]*\s+){0,3}(?:id|no\.?|number|num)\s*[:#]\s*','','i'),
 '^\s*(?:[A-Za-z][A-Za-z.]*\s+){1,3}#\s*','','i')),'^#+','')))
 ELSE 'order:'||o."ledgerPartyId"||':'||o."orderKey"||'/source/'||o."sourceKind"||':'||coalesce(nullif(o."sourceExternalKey",''),o."sourceClaimId"::text) END AS event
FROM "SourceOrderObservation" o;
--> statement-breakpoint
INSERT INTO "RecordKey" ("scopeKind","scopeKey",entity,"naturalKey","entityId",minted,"rejectedAt")
SELECT DISTINCT 'purchaseEvent',p.id::text,'purchase','legacy:'||p.id,p.id,false,p."deletedAt"
FROM "SourceOrderObservation" o JOIN "Purchase" p ON p.id=o."purchaseId"
WHERE NOT EXISTS (SELECT 1 FROM "RecordKey" k WHERE k.entity='purchase' AND k."entityId"=p.id)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "EvidenceBinding" ("factKind","factId",basis,"eventKey","scopeKind","scopeKey")
SELECT 'orderObservation',o.id::text,'baseline',owner."scopeKey",'purchaseEvent',owner."scopeKey"
FROM order_email_orders o JOIN order_email_accepted accepted ON accepted."observationId"=o.id JOIN LATERAL (
 SELECT k."scopeKey" FROM "RecordKey" k WHERE k.entity='purchase' AND k."entityId"=o."purchaseId"
  AND k."scopeKind"='purchaseEvent' AND k."mergedAt" IS NULL
 ORDER BY k."rejectedAt" NULLS FIRST,k."scopeKey" LIMIT 1
) owner ON true ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- The accepted line-to-record relationship is baseline identity metadata.
-- Source snapshots and existing RecordKey natural keys stay byte-for-byte intact.
INSERT INTO "Decision" (id,channel,subject,slot,field,kind,value,"actorKind","actorId",at)
SELECT overlay(overlay(md5('order-email-line:'||p.id) placing '8' from 13 for 1) placing '8' from 17 for 1)::uuid,'assignment','purchaseEvent:'||o.event,
 'line-record:'||p."lineIndex",'line-record:'||p."lineIndex",'set',to_jsonb(p."expenseId"::text),
 'system','cubby-system',accepted."createdAt"
FROM "ImportSourceProduct" p JOIN "ImportSourceOrder" accepted ON accepted.id=p."sourceOrderId"
JOIN order_email_accepted mapped ON mapped.id=accepted.id
JOIN order_email_orders o ON o.id=mapped."observationId"
JOIN "EvidenceBinding" b ON b."factKind"='orderObservation' AND b."factId"=o.id::text
 AND b.basis='baseline'
WHERE p."expenseId" IS NOT NULL ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- A retained allocation is a baseline payment identity only when it names one
-- complete bank movement; ambiguous equal payments remain unresolved.
INSERT INTO "EvidenceBinding" ("factKind","factId",basis,"eventKey","scopeKind","scopeKey")
SELECT 'retainedPayment',p.id::text,'baseline','bank:'||matched.id,'purchaseEvent',owner."scopeKey"
FROM "PurchasePaymentEvidence" p JOIN LATERAL (
 SELECT min(a."transactionId"::text) id FROM "FinancialTransactionAllocation" a
 JOIN "FinancialTransaction" t ON t.id=a."transactionId" AND t."deletedAt" IS NULL
 WHERE a."purchaseId"=p."purchaseId" AND a."deletedAt" IS NULL
  AND a."amountMinor"=p."amountMinor" AND t."amountMinor"=p."amountMinor"
 HAVING count(DISTINCT a."transactionId")=1
) matched ON matched.id IS NOT NULL
JOIN LATERAL (SELECT k."scopeKey" FROM "RecordKey" k WHERE k.entity='purchase'
 AND k."entityId"=p."purchaseId" AND k."scopeKind"='purchaseEvent' AND k."mergedAt" IS NULL
 ORDER BY k."rejectedAt" NULLS FIRST,k."scopeKey" LIMIT 1) owner ON true
WHERE NOT EXISTS (SELECT 1 FROM "PurchasePaymentEvidence" other
 WHERE other."purchaseId"=p."purchaseId" AND other."amountMinor"=p."amountMinor"
 AND other."evidenceIndex"<>p."evidenceIndex"
 AND (other."orderObservationId"=p."orderObservationId" OR other."sourceClaimId"=p."sourceClaimId"))
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TEMP VIEW order_email_payment_keys AS
SELECT DISTINCT o.id,'payment:order:'||o."vendorId"||':'||substring(o.event from position('/order/' in o.event)+7) key
FROM order_email_orders o WHERE o.extraction#>>'{candidate,orderId}' IS NOT NULL
UNION SELECT o.id,'payment:amount:USD:'||round((p.value->>'amount')::numeric*100)::bigint
FROM order_email_orders o CROSS JOIN LATERAL jsonb_array_elements(coalesce(o.extraction#>'{candidate,payments}','[]'::jsonb)) p(value)
WHERE o.extraction#>>'{candidate,currency}'='USD'
UNION SELECT o.id,'payment:source:'||o.event FROM order_email_orders o
WHERE o.extraction#>>'{candidate,orderId}' IS NULL
 AND (o.extraction#>>'{candidate,currency}' IS DISTINCT FROM 'USD'
  OR jsonb_array_length(coalesce(o.extraction#>'{candidate,payments}','[]'::jsonb))=0);
--> statement-breakpoint
INSERT INTO "FactKey" (key,"factKind","factId")
SELECT 'row:SourceOrderObservation:'||id,'orderObservation',id::text FROM order_email_orders
UNION SELECT 'order:'||"orderKey",'orderObservation',id::text FROM order_email_orders
UNION SELECT event,'orderObservation',id::text FROM order_email_orders
UNION SELECT 'row:Email:'||"emailId",'orderObservation',id::text FROM order_email_orders WHERE "emailId" IS NOT NULL
UNION SELECT key,'orderObservation',id::text FROM order_email_payment_keys
UNION SELECT 'row:PurchasePaymentEvidence:'||id,'retainedPayment',id::text FROM "PurchasePaymentEvidence"
UNION SELECT 'payment:amount:USD:'||"amountMinor",'retainedPayment',id::text FROM "PurchasePaymentEvidence"
UNION SELECT 'row:Email:'||id,'email',id::text FROM "Email"
UNION SELECT 'mail:'||"ledgerPartyId"||':'||provider||':'||"mailboxId"||':'||"messageId",'email',id::text FROM "Email"
UNION SELECT 'row:Email:'||"emailId",'email.prediction',id::text FROM "EmailClassificationObservation"
UNION SELECT 'row:EmailClassificationObservation:'||id,'email.prediction',id::text FROM "EmailClassificationObservation"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Observation-local notes and lineage remain distinct from occurrence judgments.
INSERT INTO "Decision" (id,channel,subject,slot,field,kind,value,"actorKind","actorId",at)
SELECT overlay(overlay(md5('source-annotation:'||a."observationId"||':'||field.key) placing '8' from 13 for 1) placing '8' from 17 for 1)::uuid,
 'assignment','sourceObservation:'||a."observationId",field.key,field.key,'set',field.value,
 'system','cubby-system',a."updatedAt"
FROM "SourceObservationAnnotation" a CROSS JOIN LATERAL jsonb_each(jsonb_build_object(
 'notes',a.notes,'supersededByObservationId',a."supersededByObservationId")) field
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Keep original decision ids, timestamps and full reviewed payloads. The new
-- projection reads these slots; legacy rows remain immutable source history.
INSERT INTO "Decision" (id,channel,subject,slot,field,kind,value,"actorKind","actorId",at)
SELECT d.id,'assignment',CASE WHEN d."emailId" IS NOT NULL THEN 'email:'||d."emailId" ELSE 'mailOriginal:'||coalesce(d."originalId",d.id) END,'link:'||d."purchaseId",'link:'||d."purchaseId",'set',
 to_jsonb(d)-ARRAY['id','createdAt','updatedAt'],CASE WHEN d.authority='member' THEN 'member' ELSE 'system' END,
 d."decidedByUserId",d."createdAt" FROM "EmailPurchaseDecision" d
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "Decision" (id,channel,subject,slot,field,kind,value,"actorKind","actorId",at)
SELECT overlay(overlay(md5('order-email-pointer:'||d.id) placing '8' from 13 for 1) placing '8' from 17 for 1)::uuid,'assignment',CASE WHEN d."emailId" IS NOT NULL THEN 'email:'||d."emailId" ELSE 'mailOriginal:'||coalesce(d."originalId",d.id) END,'purchaseId','purchaseId','set',
 to_jsonb(d."purchaseId"::text),CASE WHEN d.authority='member' THEN 'member' ELSE 'system' END,
 d."decidedByUserId",d."createdAt" FROM "EmailPurchaseDecision" d
WHERE d.active AND d.decision='linked' ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "Decision" (id,channel,subject,slot,field,kind,value,"actorKind","actorId",at)
SELECT overlay(overlay(md5('order-email-status:'||d.id) placing '8' from 13 for 1) placing '8' from 17 for 1)::uuid,'assignment',CASE WHEN d."emailId" IS NOT NULL THEN 'email:'||d."emailId" ELSE 'mailOriginal:'||coalesce(d."originalId",d.id) END,'review-status:'||d.id,'review-status:'||d.id,'set',
 to_jsonb(d.status),CASE WHEN d.authority='member' THEN 'member' ELSE 'system' END,
 d."decidedByUserId",d."createdAt" FROM "EmailPurchaseDecision" d ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "Decision" (id,channel,subject,slot,field,kind,value,"actorKind","actorId",at)
SELECT r.id,'assignment',CASE WHEN r."emailId" IS NOT NULL THEN 'email:'||r."emailId" ELSE 'mailOriginal:'||coalesce(r."originalId",r."subjectId") END,
 'review:'||r."subjectId"||':'||r."operationId",'review:'||r."subjectId"||':'||r."operationId",'set',
 to_jsonb(r)-ARRAY['id','createdAt'],CASE WHEN r.authority='member' THEN 'member' ELSE 'system' END,
 coalesce(r."actorUserId",'cubby-system'),r."createdAt" FROM "EmailReview" r ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "Decision" (id,channel,subject,slot,field,kind,value,"actorKind","actorId",at)
SELECT a.id,'assignment','email:'||a."emailId",'financial:'||a."evidenceChecksum"||':'||a."transactionId",
 'financial:'||a."evidenceChecksum"||':'||a."transactionId",'set',to_jsonb(a)-ARRAY['id','createdAt'],
 'member',a."decidedByUserId",a."createdAt" FROM "EmailFinancialAssociation" a ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "Decision" (id,channel,subject,slot,field,kind,value,"actorKind","actorId",at)
SELECT overlay(overlay(md5('order-email-classification:'||e.id) placing '8' from 13 for 1) placing '8' from 17 for 1)::uuid,'assignment','email:'||e.id,'classification','classification','set',
 to_jsonb(e.classification),'member',coalesce(p."userId",'cubby-system'),e."updatedAt"
FROM "Email" e LEFT JOIN "LedgerParty" p ON p.id=e."ledgerPartyId"
WHERE e."classificationStage"='resolution' AND e.classification IS NOT NULL ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Existing transfers become authored baseline inputs, not inferred transfers.
INSERT INTO "ManualEntry" (id,entity,"userId",payload)
SELECT overlay(overlay(md5('order-email-transfer:'||t.id) placing '8' from 13 for 1) placing '8' from 17 for 1)::uuid,'ledgerTransfer','cubby-system',jsonb_build_object(
 'transferPair',t.id::text,'values',jsonb_build_object('fromPartyId',t."fromPartyId",'toPartyId',t."toPartyId",
 'amount',t."amountMinor"::text,'date',t.date,'notes',t.notes),
 'transactionIds',coalesce((SELECT jsonb_agg(f.id::text ORDER BY f.id) FROM "FinancialTransaction" f WHERE f."ledgerTransferId"=t.id),'[]'::jsonb))
FROM "LedgerTransfer" t ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "RecordKey" ("scopeKind","scopeKey",entity,"naturalKey","entityId",minted,"rejectedAt")
SELECT 'transferPair',t.id::text,'ledgerTransfer','legacy:'||t.id,t.id,false,t."deletedAt"
FROM "LedgerTransfer" t WHERE NOT EXISTS (SELECT 1 FROM "RecordKey" k WHERE k.entity='ledgerTransfer' AND k."entityId"=t.id)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "FactKey" (key,"factKind","factId")
SELECT 'manual:'||m.id,'manualEntry',m.id::text FROM "ManualEntry" m WHERE m.entity='ledgerTransfer'
UNION SELECT 'transferPair:'||(m.payload->>'transferPair'),'manualEntry',m.id::text FROM "ManualEntry" m
WHERE m.entity='ledgerTransfer' AND m.payload->>'transferPair' IS NOT NULL ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "ScopeDirty" ("scopeKind","scopeKey",lane,reason)
SELECT 'purchaseEvent',event,'money','order evidence adoption' FROM order_email_orders
UNION SELECT 'purchaseEvent',key,'money','order evidence adoption' FROM order_email_payment_keys
UNION SELECT 'purchaseEvent',"scopeKey",'money','order evidence adoption' FROM "EvidenceBinding" WHERE "factKind"='orderObservation'
UNION SELECT 'emailState',id::text,'money','order evidence adoption' FROM "Email" WHERE "deletedAt" IS NULL
UNION SELECT 'transferPair',id::text,'money','order evidence adoption' FROM "LedgerTransfer" WHERE "deletedAt" IS NULL
ON CONFLICT ("scopeKind","scopeKey") DO UPDATE SET seq="ScopeDirty".seq+1;
--> statement-breakpoint
DO $$ DECLARE changed bigint; BEGIN
 SELECT count(*) INTO changed FROM (
  (SELECT source,row FROM order_email_money_before EXCEPT
   (SELECT 'Expense',to_jsonb(r) FROM "Expense" r UNION ALL SELECT 'FinancialTransaction',to_jsonb(r) FROM "FinancialTransaction" r
    UNION ALL SELECT 'Purchase',to_jsonb(r) FROM "Purchase" r UNION ALL SELECT 'FinancialTransactionAllocation',to_jsonb(r) FROM "FinancialTransactionAllocation" r
    UNION ALL SELECT 'ExpenseAttribution',to_jsonb(r) FROM "ExpenseAttribution" r UNION ALL SELECT 'LedgerTransfer',to_jsonb(r) FROM "LedgerTransfer" r))
  UNION ALL ((SELECT 'Expense',to_jsonb(r) FROM "Expense" r UNION ALL SELECT 'FinancialTransaction',to_jsonb(r) FROM "FinancialTransaction" r
    UNION ALL SELECT 'Purchase',to_jsonb(r) FROM "Purchase" r UNION ALL SELECT 'FinancialTransactionAllocation',to_jsonb(r) FROM "FinancialTransactionAllocation" r
    UNION ALL SELECT 'ExpenseAttribution',to_jsonb(r) FROM "ExpenseAttribution" r UNION ALL SELECT 'LedgerTransfer',to_jsonb(r) FROM "LedgerTransfer" r)
    EXCEPT SELECT source,row FROM order_email_money_before)
 ) delta;
 IF EXISTS (SELECT 1 FROM order_email_accepted accepted LEFT JOIN "SourceOrderObservation" o
  ON o.id=accepted."observationId" WHERE o.id IS NULL) THEN
  RAISE EXCEPTION 'Order evidence adoption lost an accepted source identity';
 END IF;
 IF EXISTS (SELECT 1 FROM "SourceObservationAnnotation" a
  CROSS JOIN LATERAL jsonb_each(jsonb_build_object('notes',a.notes,'supersededByObservationId',a."supersededByObservationId")) field
  LEFT JOIN "Decision" d ON d.id=overlay(overlay(md5('source-annotation:'||a."observationId"||':'||field.key) placing '8' from 13 for 1) placing '8' from 17 for 1)::uuid
  WHERE d.id IS NULL OR d.value IS DISTINCT FROM field.value OR d.at IS DISTINCT FROM a."updatedAt") THEN
  RAISE EXCEPTION 'Order evidence adoption lost observation annotation content';
 END IF;
 IF changed<>0 THEN RAISE EXCEPTION 'Order evidence adoption changed % money rows',changed; END IF;
 IF EXISTS (SELECT 1 FROM order_email_sources_before before LEFT JOIN "SourceOrderObservation" after USING (id)
  WHERE before.row IS DISTINCT FROM to_jsonb(after)-ARRAY['ledgerPartyId','emailId','sourceKind','sourceExternalKey']) THEN
  RAISE EXCEPTION 'Order evidence adoption changed retained source content';
 END IF;
END $$;
