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
