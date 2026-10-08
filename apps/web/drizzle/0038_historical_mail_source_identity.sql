-- Custom SQL migration file, put your code below! --
-- Map source identity only. Association, payment, original-byte and Run owners
-- retain their IDs; a current Google connection cannot identify old mail.
CREATE TEMP TABLE "_HistoricalMailClaim" ON COMMIT DROP AS
SELECT c."id" AS "claimId", m."id" AS "orderMailId", c."ledgerPartyId",
  m."mailboxId", m."messageId", m."rawChecksum",
  'gmail:' || m."mailboxId" || ':' || m."messageId" AS "canonicalKey",
  EXISTS (
    SELECT 1 FROM "Run" r
    JOIN "LedgerParty" owner ON owner."id" = r."ledgerPartyId"
      AND owner."userId" = r."actorUserId" AND owner."kind" = 'member'
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN r."input"->>'kind' = 'order_mail_import' THEN
        CASE WHEN jsonb_typeof(r."input"->'orders') = 'array'
          THEN r."input"->'orders' ELSE jsonb_build_array(r."input") END
        ELSE '[]'::jsonb END
    ) selection
    JOIN "OrderMailEvent" e ON e."id"::text = selection->>'eventId'
    WHERE r."id" IN (c."firstRunId", c."lastRunId")
      AND r."ledgerPartyId" = c."ledgerPartyId"
      AND e."orderMailId" = m."id"
      AND selection->>'evidenceChecksum' = m."rawChecksum"
      AND c."checksum" = m."rawChecksum"
      AND selection->>'orderId' = e."orderId"
      AND c."externalKey" = 'gmail:' || m."messageId" || ':order:' || e."orderId"
  ) AND NOT EXISTS (
    SELECT 1 FROM "ImportSourceOrder" o JOIN "Purchase" p ON p."id" = o."purchaseId"
    WHERE o."sourceClaimId" = c."id"
      AND (o."checksum" <> m."rawChecksum" OR p."orderId" IS NULL
        OR o."orderKey" <> p."vendorId"::text || '/order/' || p."orderId"
        OR c."externalKey" <> 'gmail:' || m."messageId" || ':order:' || p."orderId")
  ) AS "proved"
FROM "ImportSourceClaim" c JOIN "OrderMail" m
  ON m."ledgerPartyId" = c."ledgerPartyId"
  AND m."mailboxId" = 'legacy:' || c."ledgerPartyId"::text
  AND left(c."externalKey", length('gmail:' || m."messageId" || ':order:'))
    = 'gmail:' || m."messageId" || ':order:'
WHERE c."kind" = 'mail_message' AND c."canonicalClaimId" IS NULL;
--> statement-breakpoint
CREATE TEMP TABLE "_HistoricalMailFamily" ON COMMIT DROP AS
WITH candidates AS (
  SELECT h."orderMailId", h."ledgerPartyId", h."mailboxId", h."messageId",
    h."rawChecksum", h."canonicalKey", bool_and(h."proved") AS "proved",
    array_agg(h."claimId") AS "claimIds", min(h."claimId"::text)::uuid AS "historyOwner"
  FROM "_HistoricalMailClaim" h
  GROUP BY h."orderMailId", h."ledgerPartyId", h."mailboxId", h."messageId", h."rawChecksum", h."canonicalKey"
)
SELECT c.*, COALESCE(existing."id", gen_random_uuid()) AS "rootId",
  c."proved" AND (existing."id" IS NULL OR
    (existing."canonicalClaimId" IS NULL AND existing."checksum" = c."rawChecksum"))
  AND NOT EXISTS (
    SELECT 1 FROM "ImportSourceOrder" o
    WHERE o."sourceClaimId" = ANY(c."claimIds") OR o."sourceClaimId" IN (
      SELECT member."id" FROM "ImportSourceClaim" member
      WHERE member."id" = existing."id" OR member."canonicalClaimId" = existing."id"
    )
    GROUP BY o."orderKey" HAVING count(*) > 1
  ) AND NOT EXISTS (
    SELECT 1 FROM "ImportSourceClaim" member
    WHERE (member."id" = existing."id" OR member."canonicalClaimId" = existing."id")
      AND (member."ledgerPartyId" <> c."ledgerPartyId" OR member."kind" <> 'mail_message')
  ) AND NOT EXISTS (
    -- Reparenting a candidate with children would create a forbidden alias chain.
    SELECT 1 FROM "ImportSourceClaim" descendant
    WHERE descendant."canonicalClaimId" = ANY(c."claimIds")
  ) AND NOT EXISTS (
    SELECT 1 FROM "ImportSourceClaim" descendant
    JOIN "ImportSourceClaim" member ON member."id" = descendant."canonicalClaimId"
    WHERE member."canonicalClaimId" = existing."id"
  ) AS "safe"
FROM candidates c LEFT JOIN "ImportSourceClaim" existing
  ON existing."ledgerPartyId" = c."ledgerPartyId" AND existing."kind" = 'mail_message'
  AND existing."externalKey" = c."canonicalKey";
--> statement-breakpoint
-- Keep every historical textual key: prepared extracts and past operations
-- retain those identities even when their association UUIDs stay unchanged.
INSERT INTO "ImportSourceClaim" ("id", "ledgerPartyId", "kind", "externalKey",
  "checksum", "firstRunId", "lastRunId")
SELECT f."rootId", f."ledgerPartyId", 'mail_message', f."canonicalKey",
  f."rawChecksum", history."firstRunId", history."lastRunId"
FROM "_HistoricalMailFamily" f
JOIN "ImportSourceClaim" history ON history."id" = f."historyOwner"
WHERE f."safe" AND NOT EXISTS (
  SELECT 1 FROM "ImportSourceClaim" existing WHERE existing."id" = f."rootId"
);
--> statement-breakpoint
UPDATE "ImportSourceClaim" c SET "canonicalClaimId" = f."rootId"
FROM "_HistoricalMailFamily" f
WHERE f."safe" AND c."id" = ANY(f."claimIds") AND c."id" <> f."rootId";
--> statement-breakpoint
-- A disposition blocks both admission and disposal independently of findings.
INSERT INTO "MailboxMessage" ("ledgerPartyId", "mailboxId", "messageId", "checksum",
  "classification", "classificationVersion", "status", "orderMailId")
SELECT f."ledgerPartyId", f."mailboxId", f."messageId", f."rawChecksum",
  'related', 'legacy-source-identity-unresolved/v1', 'blocked', f."orderMailId"
FROM "_HistoricalMailFamily" f WHERE NOT f."safe"
ON CONFLICT ("ledgerPartyId", "provider", "mailboxId", "messageId") DO UPDATE
SET "classification" = 'related', "classificationVersion" = 'legacy-source-identity-unresolved/v1',
  "status" = CASE WHEN "MailboxMessage"."status" IN ('deleted', 'excluded')
    THEN "MailboxMessage"."status" ELSE 'blocked' END,
  "orderMailId" = EXCLUDED."orderMailId", "checksum" = EXCLUDED."checksum";
--> statement-breakpoint
-- Missing originals also leave an inspectable finding. Dismissal is not proof.
INSERT INTO "RunFinding" ("runId", "ledgerPartyId", "entityId", "entityKind", "kind",
  "summary", "proposedFix", "evidenceFingerprint")
SELECT c."firstRunId", c."ledgerPartyId", c."firstRunId", 'run', 'other',
  'Historical mail source ownership needs review: retained original, frozen selection, or order ownership could not be verified.',
  NULL, 'legacy-source-identity:' || md5(c."id"::text || ':' || c."externalKey" || ':' || c."checksum")
FROM "ImportSourceClaim" c
WHERE c."kind" = 'mail_message' AND c."canonicalClaimId" IS NULL
  AND c."externalKey" ~ '^gmail:[^:]+:order:.+'
ON CONFLICT ("ledgerPartyId", "entityKind", "entityId", "kind", "evidenceFingerprint")
  WHERE "status" = 'open' DO NOTHING;
