ALTER TABLE "OrderMail" ADD COLUMN "hasRetainedText" boolean GENERATED ALWAYS AS (COALESCE(
          NULLIF(BTRIM("content"->>'snippet'), ''),
          NULLIF(BTRIM("content"->>'bodyText'), ''),
          NULLIF(BTRIM("content"->>'bodyHtml'), '')
        ) IS NOT NULL) STORED NOT NULL;