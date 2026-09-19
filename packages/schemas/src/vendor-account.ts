import { z } from "zod";

import { auditDateFilterFields } from "./base-entity";
import {
  generatedVendorAccountFieldSchemas,
  generatedVendorAccountFilterFields,
} from "./generated/entity-field-schemas.vendorAccount.gen";
import {
  ledgerPartyShortcode,
  vendorAccountShortcode,
  vendorShortcode,
} from "./identifiers";
import { createPaginatedResponseSchema, entityFilterList } from "./pagination";
export {
  vendorAccountBrowser,
  vendorAccountCursor,
  vendorAccountStatus,
} from "./vendor-account-fields";

export const vendorAccountCreateInput = z.object(
  generatedVendorAccountFieldSchemas.create,
);
export type VendorAccountCreateInput = z.infer<typeof vendorAccountCreateInput>;
export const vendorAccountUpdateData = z.object(
  generatedVendorAccountFieldSchemas.update,
);
export type VendorAccountUpdateData = z.infer<typeof vendorAccountUpdateData>;
export const vendorAccountUpdateInput = z.object({
  id: vendorAccountShortcode,
  data: vendorAccountUpdateData,
});
export const vendorAccountOut = z.object(
  generatedVendorAccountFieldSchemas.read,
);
export type VendorAccountOut = z.infer<typeof vendorAccountOut>;
export const vendorAccountListResponse =
  createPaginatedResponseSchema(vendorAccountOut);
export const vendorAccountFilterFields = {
  ...auditDateFilterFields,
  ...generatedVendorAccountFilterFields,
  vendorId: entityFilterList(vendorShortcode).optional(),
  ledgerPartyId: entityFilterList(ledgerPartyShortcode).optional(),
};
export const vendorAccountFilters = z.object(vendorAccountFilterFields);
export type VendorAccountFilters = z.infer<typeof vendorAccountFilters>;
