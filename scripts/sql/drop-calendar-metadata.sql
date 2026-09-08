-- Run only after the simplified calendar Worker is deployed and verified.
-- No CASCADE: an unexpected remaining dependency must stop this cleanup.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TABLE IF EXISTS public."CalendarWriteReceipt";
DROP TABLE IF EXISTS public."CalendarResourceIdentity";
COMMIT;
-- Both values must be NULL after cleanup.
SELECT to_regclass('public."CalendarWriteReceipt"') AS receipt,
       to_regclass('public."CalendarResourceIdentity"') AS identity;
