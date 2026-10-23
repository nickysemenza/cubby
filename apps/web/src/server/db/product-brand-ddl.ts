/**
 * Generic is a protected Brand identity and cannot acquire seller or issuer roles.
 */
export const productBrandDdl = () => `
CREATE OR REPLACE FUNCTION cubby_guard_generic_brand() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'Vendor' THEN
    IF OLD."systemKey" IS NOT NULL AND (TG_OP = 'DELETE' OR NEW IS DISTINCT FROM OLD) THEN
      RAISE EXCEPTION 'System Generic / Unbranded Brand cannot be changed, deleted or merged';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW."systemKey" IS DISTINCT FROM OLD."systemKey" THEN
      RAISE EXCEPTION 'Vendor system designation cannot be changed';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  -- includes-deleted: system designation forbids these roles even for a tombstoned identity.
  IF EXISTS (SELECT 1 FROM "Vendor" WHERE id = NEW."vendorId" AND "systemKey" = 'generic-unbranded') THEN
    RAISE EXCEPTION 'Generic / Unbranded may only be assigned as a Product Brand';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Vendor_protect_generic_brand" BEFORE UPDATE OR DELETE ON "Vendor"
FOR EACH ROW EXECUTE FUNCTION cubby_guard_generic_brand();
CREATE TRIGGER "Purchase_reject_generic_seller" BEFORE INSERT OR UPDATE OF "vendorId" ON "Purchase"
FOR EACH ROW EXECUTE FUNCTION cubby_guard_generic_brand();
CREATE TRIGGER "VendorAccount_reject_generic_seller" BEFORE INSERT OR UPDATE OF "vendorId" ON "VendorAccount"
FOR EACH ROW EXECUTE FUNCTION cubby_guard_generic_brand();
CREATE TRIGGER "ExternalSource_reject_generic_issuer" BEFORE INSERT OR UPDATE OF "vendorId" ON "ExternalSource"
FOR EACH ROW EXECUTE FUNCTION cubby_guard_generic_brand();
`;
