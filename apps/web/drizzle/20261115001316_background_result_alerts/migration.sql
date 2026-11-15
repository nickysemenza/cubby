CREATE TABLE "DeviceAlertDelivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"deviceId" uuid NOT NULL,
	"auditId" uuid NOT NULL,
	"creationKey" text NOT NULL,
	"registration" uuid NOT NULL,
	"batchId" uuid,
	"claimToken" uuid,
	"availableAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"acceptedAt" timestamp,
	"lastError" text
);
--> statement-breakpoint
ALTER TABLE "Device" ADD COLUMN "backgroundAlerts" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "Device" ADD COLUMN "pushRegistration" jsonb;--> statement-breakpoint
ALTER TABLE "Device" ADD COLUMN "pushLastError" text;--> statement-breakpoint
CREATE UNIQUE INDEX "DeviceAlertDelivery_device_creation_key" ON "DeviceAlertDelivery" ("deviceId","creationKey");--> statement-breakpoint
CREATE INDEX "DeviceAlertDelivery_pending_idx" ON "DeviceAlertDelivery" ("availableAt") WHERE "acceptedAt" IS NULL;--> statement-breakpoint
ALTER TABLE "DeviceAlertDelivery" ADD CONSTRAINT "DeviceAlertDelivery_deviceId_Device_id_fk" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE;