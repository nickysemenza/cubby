import {
  aiFundingStatus,
  setCreditBudgetInput,
} from "@cubby/schemas/mail-import-settings";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

/** Household-wide frontier AI funding (ADR 0017), shared by every feature. */
export const aiFundingContract = defineContract("aiFunding", {
  status: query({
    input: z.strictObject({}),
    output: aiFundingStatus,
    // Spend and refusals move with model calls; Run writes refresh it.
    cache: { tags: [["run"]], profile: "live-status" },
  }),
  setCreditBudget: mutation({
    input: setCreditBudgetInput,
    output: aiFundingStatus,
    invalidates: ["runOnly"],
  }),
  resetCreditRefusal: mutation({
    input: z.strictObject({}),
    output: aiFundingStatus,
    invalidates: ["runOnly"],
  }),
});
