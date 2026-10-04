import {
  entityReportInput,
  entityReportManyInput,
  entityReportManyOut,
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
  /**
   * Several slots of one record in one read; a Run's page polls this once so the run loads
   * once per poll instead of once per slot.
   */
  getMany: query({
    native: "Detail slot reports, batched per record",
    input: entityReportManyInput,
    output: entityReportManyOut,
    cache: { tags: [["run"], ["purchase"], ["problems"]] },
  }),
});
