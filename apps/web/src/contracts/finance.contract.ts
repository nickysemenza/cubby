import {
  financialStatementImportPreviewInput,
  financialStatementImportPreviewOut,
  financialTransactionSourceOptionsOut,
  merchantVendorInference,
  merchantVendorInferenceInput,
} from "@cubby/schemas/financial-transaction";
import { ledgerPartyShortcode, userId } from "@cubby/schemas/identifiers";
import { ledgerPartyOptionsOut } from "@cubby/schemas/ledger-party";
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
  options: query({
    input: z.null(),
    output: ledgerPartyOptionsOut,
  }),
  /** Every signed-in login and the member ledger party it represents. */
  memberLogins: query({ input: z.null(), output: memberLogins }),
  /** Links (or unlinks) one login to a member ledger party. */
  setMemberLogin: mutation({
    input: z.object({
      userId,
      ledgerParty: ledgerPartyShortcode.nullable(),
    }),
    output: memberLogins,
  }),
});

export const financialTransactionContract = defineContract(
  "financialTransaction",
  {
    previewStatementImport: query({
      mcp: {
        name: "preview_financial_statement_import",
        description:
          "Preview client-parsed Monarch statement rows before recording settlement evidence. Cubby accepts normalized rows only — never a CSV path, upload, or file contents. Pass at most 200 rows. Monarch charges are negative in the export and are normalized to positive Cubby outflows; credits become negative. The preview derives a stable source reference from account/date/amount/original statement, resolves an existing Financial Account only when unambiguous, and returns already_recorded, ready_to_create, possible_existing, unresolved_account, or indistinguishable_duplicate for each row. Eligible rows may include advisory vendorInference derived from prior settled transactions with the same Merchant label; it neither matches nor links anything. Unresolved rows include a non-persisted provisional Account suggestion. This tool is read-only: it never creates Accounts, Financial Transactions, Purchases, or links. Create only user-approved ready_to_create rows afterwards with entity create(financialTransaction), then review every result.",
        readPolicy: "strong",
      },
      input: financialStatementImportPreviewInput,
      output: financialStatementImportPreviewOut,
    }),
    sourceOptions: query({
      input: z.null(),
      output: financialTransactionSourceOptionsOut,
    }),
    vendorInference: query({
      input: merchantVendorInferenceInput,
      output: merchantVendorInference,
    }),
  },
);
