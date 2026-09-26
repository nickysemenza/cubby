import type { MerchantVendorInferenceInput } from "@cubby/schemas/financial-transaction";

import type { Database } from "~/server/db";
import { financialTransactionSourceOptions } from "~/server/repo/financial-transaction";
import { ledgerPartyOptions } from "~/server/repo/ledger-party";
import { merchantVendorInferenceFor } from "~/server/repo/merchant-vendor-inference";
import { defineWorkflowOperation } from "~/server/workflow-runtime";

export const ledgerPartyOptionsWorkflow = defineWorkflowOperation(
  "ledgerParty.options",
  ledgerPartyOptions,
);
export const financialTransactionSourceOptionsWorkflow =
  defineWorkflowOperation(
    "financialTransaction.sourceOptions",
    financialTransactionSourceOptions,
  );
export const merchantVendorInferenceWorkflow = defineWorkflowOperation(
  "financialTransaction.vendorInference",
  (db: Database, input: MerchantVendorInferenceInput) =>
    merchantVendorInferenceFor(db, input.merchant),
);
