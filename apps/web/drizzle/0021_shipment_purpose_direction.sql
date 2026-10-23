LOCK TABLE "Shipment" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
ALTER TABLE "Shipment" DROP CONSTRAINT "Shipment_purpose_check";--> statement-breakpoint
-- Retired fulfillment labels do not establish household direction. Preserve the old claim.
UPDATE "Shipment"
SET "notes" = concat_ws(E'\n', nullif("notes", ''), 'Previous shipment purpose: ' || "purpose" || '.'),
    "purpose" = 'unknown'
WHERE "purpose" IN ('outbound', 'replacement', 'return');--> statement-breakpoint
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_purpose_check" CHECK ("Shipment"."purpose" IN ('incoming', 'outgoing', 'unknown'));
