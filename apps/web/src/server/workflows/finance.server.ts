import type { MerchantVendorInferenceInput } from "@cubby/schemas/financial-transaction";

import type { Database } from "~/server/db";
import { financialTransactionSourceOptions } from "~/server/repo/financial-transaction";
import { merchantVendorInferenceFor } from "~/server/repo/merchant-vendor-inference";
import { defineWorkflowOperation } from "~/server/workflow-runtime";

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
