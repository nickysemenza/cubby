import {
  financialTransactionContract,
  ledgerPartyContract,
} from "~/contracts/finance.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  previewFinancialBooking,
  commitFinancialBooking,
} from "~/server/repo/financial-booking";
import {
  previewFinancialBookingCorrection,
  commitFinancialBookingCorrection,
} from "~/server/repo/financial-booking-correction";
import { previewFinancialStatementImport } from "~/server/repo/financial-statement-preview";
import { financialTransactionSourceOptions } from "~/server/repo/financial-transaction";
import {
  listMemberLogins,
  setMemberLoginParty,
} from "~/server/repo/member-login";
import { merchantVendorInferenceFor } from "~/server/repo/merchant-vendor-inference";

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
    previewBookingCorrection: (context, input) =>
      previewFinancialBookingCorrection(context.db, input),
    commitBookingCorrection: (context, input) =>
      commitFinancialBookingCorrection(context.db, input, context.actorContext),
    previewBooking: (context, input) =>
      previewFinancialBooking(context.db, input),
    commitBooking: (context, input) =>
      commitFinancialBooking(context.db, input, context.actorContext),
    previewStatementImport: (context, input) =>
      previewFinancialStatementImport(context.db, input),
    sourceOptions: (context) => financialTransactionSourceOptions(context.db),
    vendorInference: (context, input) =>
      merchantVendorInferenceFor(context.db, input.merchant),
  },
);
