import type { MerchantVendorInferenceInput } from "@cubby/schemas/financial-transaction";

import type { Database } from "~/server/db";
import { financialAccountOptions } from "~/server/repo/financial-account";
import { financialTransactionSourceOptions } from "~/server/repo/financial-transaction";
import { ledgerPartyOptions } from "~/server/repo/ledger-party";
import { merchantVendorInferenceFor } from "~/server/repo/merchant-vendor-inference";
export const financialAccountOptionsWorkflow = (db: Database) =>
  financialAccountOptions(db);
export const ledgerPartyOptionsWorkflow = (db: Database) =>
  ledgerPartyOptions(db);
export const financialTransactionSourceOptionsWorkflow = (db: Database) =>
  financialTransactionSourceOptions(db);
export const merchantVendorInferenceWorkflow = (
  db: Database,
  input: MerchantVendorInferenceInput,
) => merchantVendorInferenceFor(db, input.merchant);
