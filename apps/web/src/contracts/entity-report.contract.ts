import {
  entityReportInput,
  entityReportManyInput,
  entityReportManyOut,
  entityReportOut,
} from "@cubby/schemas/entity-report";

import { defineContract, query } from "~/contracts/define";

export const entityReportContract = defineContract(
  "entityReport",
  {
    /**
     * The server-composed figures, series and schedule rows behind a detail slot
     * (`reportSlots`), so web and native render one read.
     */
    get: query({
      note: "Detail slot reports",
      input: entityReportInput,
      output: entityReportOut,
      cache: {
        tags: [
          ["project"],
          ["task"],
          ["expense"],
          ["householdContribution"],
          ["location"],
          ["inventory"],
          ["meal"],
          ["recipe"],
          ["ingredient"],
          ["cookbook"],
          ["product"],
          ["image"],
          ["purchase"],
          ["run"],
          ["suggestions"],
          ["financialTransaction"],
          ["vendor"],
          ["vendorAccount"],
          ["email"],
          ["financialAccount"],
          ["transactionImport"],
          ["sourceTransactionRecord"],
          ["ledgerParty"],
        ],
      },
    }),
    /**
     * Several slots of one record in one read; a Run's page polls this once so the run loads
     * once per poll instead of once per slot.
     */
    getMany: query({
      input: entityReportManyInput,
      output: entityReportManyOut,
      cache: {
        tags: [
          ["project"],
          ["task"],
          ["expense"],
          ["householdContribution"],
          ["location"],
          ["inventory"],
          ["meal"],
          ["recipe"],
          ["ingredient"],
          ["cookbook"],
          ["product"],
          ["image"],
          ["purchase"],
          ["run"],
          ["suggestions"],
          ["financialTransaction"],
          ["vendor"],
          ["vendorAccount"],
          ["email"],
          ["financialAccount"],
          ["transactionImport"],
          ["sourceTransactionRecord"],
          ["ledgerParty"],
        ],
      },
    }),
  },
  { exposure: "view" },
);
