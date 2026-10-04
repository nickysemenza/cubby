import {
  entityReportInput,
  entityReportOut,
} from "@cubby/schemas/entity-report";

import { defineContract, query } from "~/contracts/define";

export const entityReportContract = defineContract("entityReport", {
  /**
   * The server-composed figures, series and schedule rows behind a detail slot
   * (`reportSlots`), so web and native render one read.
   */
  get: query({
    native: "Detail slot reports",
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
        ["product"],
        ["image"],
        ["purchase"],
        ["run"],
        ["financialTransaction"],
        ["vendor"],
      ],
    },
  }),
});
