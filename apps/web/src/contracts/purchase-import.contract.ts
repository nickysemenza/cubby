import {
  initiateRunEvidenceUploadInput,
  initiateRunEvidenceUploadOut,
  listReceiptHuntsInput,
  listReceiptHuntsOut,
  submitReceiptEvidenceInput,
  submitReceiptEvidenceOut,
} from "@cubby/schemas/purchase-import";

import { defineContract, mutation, query } from "~/contracts/define";

export const purchaseImportContract = defineContract("purchaseImport", {
  initiateRunEvidenceUpload: mutation({
    input: initiateRunEvidenceUploadInput,
    output: initiateRunEvidenceUploadOut,
    native:
      "Stage an immutable run-scoped purchase validation or enrichment evidence upload",
  }),
  listReceiptHunts: query({
    input: listReceiptHuntsInput,
    output: listReceiptHuntsOut,
    native: "List receipt hunts awaiting user-confirmed photo evidence",
  }),
  submitReceiptEvidence: mutation({
    input: submitReceiptEvidenceInput,
    output: submitReceiptEvidenceOut,
    native: "Submit a user-confirmed receipt photo for purchase import",
  }),
});
