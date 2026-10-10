import { z } from "zod";
import { ledgerPartyShortcode, vendorAccountShortcode } from "./identifiers";
import { browserChoice } from "./purchase-import";
import { vendorAccountOut } from "./generated/vendorAccount.gen";
import { createPaginatedResponseSchema } from "./pagination";
export {
  vendorAccountBrowser,
  vendorAccountCursor,
  vendorAccountStatus,
} from "./vendor-account-fields";
export {
  vendorAccountCreateInput,
  vendorAccountFilterFields,
  vendorAccountFilters,
  vendorAccountOut,
  vendorAccountUpdateData,
  vendorAccountUpdateInput,
  type VendorAccountCreateInput,
  type VendorAccountFilters,
  type VendorAccountOut,
  type VendorAccountUpdateData,
} from "./generated/vendorAccount.gen";

export const vendorAccountListResponse =
  createPaginatedResponseSchema(vendorAccountOut);

export const browserBridgeVendorAccount = z
  .object({
    id: vendorAccountShortcode,
    label: vendorAccountOut.shape.label,
    ledgerPartyId: ledgerPartyShortcode,
    browser: browserChoice,
  })
  .meta({ id: "BrowserBridgeVendorAccount" });
export const browserBridgeAccountsOut = z.object({
  accounts: z.array(browserBridgeVendorAccount),
});
