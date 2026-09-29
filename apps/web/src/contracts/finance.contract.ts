import {
  financialStatementImportPreviewInput,
  financialStatementImportPreviewOut,
  financialTransactionSourceOptionsOut,
  merchantVendorInference,
  merchantVendorInferenceInput,
} from "@cubby/schemas/financial-transaction";
import { ledgerPartyShortcode, userId } from "@cubby/schemas/identifiers";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

const memberLogins = z.object({
  users: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      email: z.email(),
      ledgerParty: z
        .object({ shortcode: ledgerPartyShortcode, name: z.string() })
        .nullable(),
    }),
  ),
  parties: z.array(
    z.object({
      shortcode: ledgerPartyShortcode,
      name: z.string(),
      userId: z.string().nullable(),
    }),
  ),
});

export const ledgerPartyContract = defineContract("ledgerParty", {
  /** Every signed-in login and the member ledger party it represents. */
  memberLogins: query({ input: z.null(), output: memberLogins }),
  /** Links (or unlinks) one login to a member ledger party. */
  setMemberLogin: mutation({
    input: z.object({
      userId,
      ledgerParty: ledgerPartyShortcode.nullable(),
    }),
    output: memberLogins,
    invalidates: ["memberLogins"],
  }),
});

export const financialTransactionContract = defineContract(
  "financialTransaction",
  {
    previewStatementImport: query({
      input: financialStatementImportPreviewInput,
      output: financialStatementImportPreviewOut,
      cache: { tags: [["financialTransaction"], ["financialAccount"]] },
    }),
    sourceOptions: query({
      input: z.null(),
      output: financialTransactionSourceOptionsOut,
    }),
    vendorInference: query({
      input: merchantVendorInferenceInput,
      output: merchantVendorInference,
      cache: { tags: [["financialTransaction"], ["purchase"], ["vendor"]] },
    }),
  },
);
