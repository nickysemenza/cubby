-- cubby:transaction-per-statement
ALTER TABLE "PhotoRunImage" DROP CONSTRAINT IF EXISTS "PhotoRunImage_deviceWorkDeviceId_Device_id_fk";
DROP INDEX IF EXISTS "PhotoRunImage_device_idx";
ALTER TABLE "PhotoRunImage" DROP COLUMN IF EXISTS "preparedAt";
ALTER TABLE "PhotoRunImage" DROP COLUMN IF EXISTS "deviceWorkDeviceId";
--> statement-breakpoint
ALTER TABLE "Run" DROP COLUMN IF EXISTS "historyCursorUrl";
ALTER TABLE "Run" DROP COLUMN IF EXISTS "historyExhaustedAt";
