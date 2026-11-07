ALTER TABLE "ImportSourceProduct" ALTER COLUMN "productId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ImportSourceProduct" ADD COLUMN "expenseId" uuid;--> statement-breakpoint
ALTER TABLE "ImportSourceProduct" ADD CONSTRAINT "ImportSourceProduct_expenseId_Expense_id_fk" FOREIGN KEY ("expenseId") REFERENCES "public"."Expense"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Backfill only one-to-one receipt/Expense matches. Ambiguous history stays
-- unlinked; neither ledger values nor original Product decisions are rewritten.
WITH lines AS (
  SELECT o."id" AS "sourceOrderId", o."purchaseId", (l.ordinality - 1)::integer AS "lineIndex", l.line
  FROM "ImportSourceOrder" o
  JOIN "Purchase" p ON p."id" = o."purchaseId" AND p."deletedAt" IS NULL
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(o."originalOrder"->'extraction'->'candidate'->'lines') = 'array'
      THEN o."originalOrder"->'extraction'->'candidate'->'lines' ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS l(line, ordinality)
), matches AS (
  SELECT l."sourceOrderId", l."lineIndex", e."id" AS "expenseId",
    count(*) OVER (PARTITION BY l."sourceOrderId", l."lineIndex") AS "lineMatches",
    count(*) OVER (PARTITION BY l."sourceOrderId", e."id") AS "expenseMatches"
  FROM lines l JOIN "Expense" e ON e."purchaseId" = l."purchaseId" AND e."deletedAt" IS NULL
    AND e."lineBasis" = 'item_line' AND e."economicRole" = 'vendor'
    AND regexp_replace(btrim(e."name"), '\s+', ' ', 'g') = regexp_replace(btrim(l.line->>'title'), '\s+', ' ', 'g')
    AND e."cost" = (l.line->>'amount')::numeric
    AND e."lineKind" = l.line->>'lineKind'
    AND (e."productQuantity" IS NULL OR l.line->>'quantity' IS NULL OR e."productQuantity" = (l.line->>'quantity')::numeric)
)
INSERT INTO "ImportSourceProduct" ("sourceOrderId", "lineIndex", "expenseId")
SELECT "sourceOrderId", "lineIndex", "expenseId" FROM matches
WHERE "lineMatches" = 1 AND "expenseMatches" = 1
ON CONFLICT ("sourceOrderId", "lineIndex") DO UPDATE SET "expenseId" = excluded."expenseId";
