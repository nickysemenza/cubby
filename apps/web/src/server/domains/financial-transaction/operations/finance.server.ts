import {
  financialTransactionImportPreviewOut,
  importPreviewExistingTransaction,
} from "@cubby/schemas/financial-transaction";

import {
  financialTransactionContract,
  ledgerPartyContract,
} from "~/contracts/finance.contract";
import {
  bookFinancialTransaction,
  previewFinancialBooking,
  commitFinancialBooking,
} from "~/server/domains/financial-transaction/repo/financial-booking";
import {
  previewFinancialBookingCorrection,
  commitFinancialBookingCorrection,
} from "~/server/domains/financial-transaction/repo/financial-booking-correction";
import { applyFinancialSettlementAllocation } from "~/server/domains/financial-transaction/repo/financial-settlement-allocation";
import { previewFinancialTransactionImport } from "~/server/domains/financial-transaction/repo/financial-statement-preview";
import { financialTransactionSourceOptions } from "~/server/domains/financial-transaction/repo/financial-transaction";
import { acceptFinancialTransferPair } from "~/server/domains/financial-transaction/repo/financial-transfer-accept";
import { convergeFinancialEvidence } from "~/server/domains/financial-transaction/service/financial-convergence";
import { merchantVendorInferenceFor } from "~/server/domains/vendor/repo/merchant-vendor-inference";
import { publicFieldEnvelopeBatch } from "~/server/generic/derived/repo/public-read";
import {
  listMemberLogins,
  setMemberLoginParty,
} from "~/server/http/member-login";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const ledgerPartyHandlers = implementOperationDomain(
  ledgerPartyContract,
  {
    memberLogins: (context) => listMemberLogins(context.db),
    setMemberLogin: async (context, input) => {
      await setMemberLoginParty(
        context.db,
        input.userId,
        input.ledgerParty,
        context.actorContext,
      );
      return listMemberLogins(context.db);
    },
  },
);

export const financialTransactionHandlers = implementOperationDomain(
  financialTransactionContract,
  {
    allocateSettlement: (context, input) =>
      applyFinancialSettlementAllocation(
        context.db,
        input,
        context.actorContext,
      ),
    acceptTransferPair: (context, input) =>
      acceptFinancialTransferPair(context.db, input, context.actorContext),
    converge: (context, input) =>
      convergeFinancialEvidence(context.db, input, context.actorContext),
    bookTransaction: (context, input) =>
      bookFinancialTransaction(context.db, input, context.actorContext),
    previewBookingCorrection: (context, input) =>
      previewFinancialBookingCorrection(context.db, input),
    commitBookingCorrection: (context, input) =>
      commitFinancialBookingCorrection(context.db, input, context.actorContext),
    previewBooking: (context, input) =>
      previewFinancialBooking(context.db, input),
    commitBooking: (context, input) =>
      commitFinancialBooking(context.db, input, context.actorContext),
    previewTransactionImport: async (context, input) => {
      const preview = await previewFinancialTransactionImport(
        context.db,
        input,
      );
      const transactions = await publicFieldEnvelopeBatch({
        db: context.db,
        reads: preview.rows.flatMap((row) =>
          row.existingTransactions.map((transaction) => ({
            entity: "financialTransaction",
            schema: importPreviewExistingTransaction,
            row: transaction,
          })),
        ),
      });
      return financialTransactionImportPreviewOut.parse({
        ...preview,
        rows: preview.rows.map((row) => ({
          ...row,
          existingTransactions: row.existingTransactions.map(() =>
            transactions.shift(),
          ),
        })),
      });
    },
    sourceOptions: (context) => financialTransactionSourceOptions(context.db),
    vendorInference: (context, input) =>
      merchantVendorInferenceFor(context.db, input.merchant),
  },
);
