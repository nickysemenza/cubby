-- Unknown-sender findings used to sit on a vendor-less account_sync Run made
-- only to hold one finding (about itself). Mail discovery passes now file the
-- finding on themselves, so move each held finding to the pass that was
-- running when it was filed, then retire the empty holder. A holder is
-- recognized by shape alone: vendor-less, needs_review, and never worked
-- (no target, operation, progress, AI usage, or audit row). Apply after the
-- code that stops creating holders has deployed.
CREATE TEMP TABLE "UnknownSenderHolder" AS
SELECT h.id AS holder, (
  SELECT d.id FROM "Run" d
  WHERE d.purpose = 'mail_discovery' AND d."deletedAt" IS NULL
    AND d."ledgerPartyId" = h."ledgerPartyId"
    AND d."startedAt" <= h."startedAt"
    AND (d."endedAt" IS NULL OR d."endedAt" >= h."startedAt")
  ORDER BY d."startedAt" DESC LIMIT 1
) AS pass
FROM "Run" h
WHERE h.purpose = 'account_sync' AND h."deletedAt" IS NULL
  AND h.status = 'needs_review'
  AND h."vendorId" IS NULL AND h."vendorAccountId" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "RunTarget" t WHERE t."runId" = h.id)
  AND NOT EXISTS (SELECT 1 FROM "RunOperation" o WHERE o."runId" = h.id)
  AND NOT EXISTS (SELECT 1 FROM "RunProgress" p WHERE p."runId" = h.id)
  AND NOT EXISTS (SELECT 1 FROM "AiUsage" u WHERE u."runId" = h.id)
  AND NOT EXISTS (SELECT 1 FROM "AuditLog" a WHERE a."runId" = h.id)
  AND EXISTS (
    SELECT 1 FROM "RunFinding" f
    WHERE f."runId" = h.id AND f.kind = 'unclassified_vendor'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "RunFinding" f
    WHERE f."runId" = h.id AND f.kind <> 'unclassified_vendor'
  );--> statement-breakpoint
-- A finding about the holder becomes a finding about its pass. An open
-- finding moves only when no open finding already holds its key on that pass
-- (RunFinding_open_evidence_key), and of several holders for one sender in
-- one pass only the earliest moves; the rest stay, and so do their holders.
UPDATE "RunFinding" f
SET "runId" = chosen.pass, "entityId" = chosen.pass, "updatedAt" = now()
FROM (
  SELECT held.id, m.pass, row_number() OVER (
    PARTITION BY m.pass, held."ledgerPartyId", held.kind,
      held."evidenceFingerprint", held.status = 'open'
    ORDER BY held."createdAt", held.id
  ) AS rank
  FROM "RunFinding" held
  JOIN "UnknownSenderHolder" m ON held."runId" = m.holder
  WHERE m.pass IS NOT NULL
    AND held."entityKind" = 'run' AND held."entityId" = m.holder
) chosen
WHERE f.id = chosen.id
  AND (f.status <> 'open' OR (chosen.rank = 1 AND NOT EXISTS (
    SELECT 1 FROM "RunFinding" o
    WHERE o.status = 'open' AND o."ledgerPartyId" = f."ledgerPartyId"
      AND o."entityKind" = 'run' AND o."entityId" = chosen.pass
      AND o.kind = f.kind AND o."evidenceFingerprint" = f."evidenceFingerprint"
  )));--> statement-breakpoint
UPDATE "Run" r
SET "deletedAt" = now(), "updatedAt" = now()
FROM "UnknownSenderHolder" m
WHERE r.id = m.holder
  AND NOT EXISTS (SELECT 1 FROM "RunFinding" f WHERE f."runId" = r.id);--> statement-breakpoint
DROP TABLE "UnknownSenderHolder";
