LOCK TABLE "ScopeDep", "ScopeDirty" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint

-- Both merchant keys trim and lowercase. The statement key also collapses
-- whitespace runs to one ASCII space. Lowercase ASCII with only isolated
-- ASCII spaces is stable. Include non-ASCII and uppercase conservatively.
WITH merchant_deps AS (
  SELECT "scopeKey", substr(key, length('index:manualTransaction.merchant:') + 1) AS merchant
  FROM "ScopeDep"
  WHERE "scopeKind" = 'bankEvent' AND key LIKE 'index:manualTransaction.merchant:%'
)
INSERT INTO "ScopeDirty" ("scopeKind", "scopeKey", lane, reason)
SELECT DISTINCT 'bankEvent', "scopeKey", 'money', 'manual transaction merchant key'
FROM merchant_deps
WHERE octet_length(merchant) <> char_length(merchant)
  OR merchant COLLATE "C" ~ '[A-Z]| {2}'
  OR replace(merchant, ' ', '') COLLATE "C" ~ '[[:space:]]'
ORDER BY "scopeKey"
ON CONFLICT ("scopeKind", "scopeKey") DO UPDATE SET
  seq = "ScopeDirty".seq + 1,
  reason = excluded.reason,
  attempts = 0,
  "availableAt" = LEAST("ScopeDirty"."availableAt", now()),
  "waitCause" = NULL,
  "claimToken" = NULL,
  "claimDeadline" = NULL,
  "claimedSeq" = NULL,
  "updatedAt" = now();
