-- An enriched target kept the capture's interim note ("awaiting the
-- purpose-specific comparison or bounded enrichment commit") after its
-- commit, and the Runs list shows a target's warning as one. The commit now
-- clears it; clear the rows written before that.
UPDATE "RunTarget"
SET warning = NULL, "updatedAt" = now()
WHERE state = 'completed' AND outcome = 'enriched'
  AND warning = 'Browser evidence captured; awaiting the purpose-specific comparison or bounded enrichment commit.';
