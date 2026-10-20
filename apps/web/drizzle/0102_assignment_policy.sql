-- Keep one switch shared with deployed predecessors. Its stable key is retained
-- while the revision expands eligible assignments; historical receipts are unchanged.
UPDATE "AutomaticRule"
SET "revision" = '2026-10-20.1'
WHERE "family" = 'field' AND "ruleKey" = 'field.addition';
