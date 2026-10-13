-- Expand step: run before deploying the code that removes these checks. The
-- read path parses every stored exception's check against the live check enum,
-- so a retained row for a retired check would fail the record's hydration.
-- Documents are optional evidence; no policy can require one any longer.
DELETE FROM "DataException"
WHERE "check" IN ('primary_document', 'financial_transaction_document');
