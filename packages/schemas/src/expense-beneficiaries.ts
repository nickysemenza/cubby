import { z } from "zod";

import { fieldSource } from "./field-envelope";
import { ledgerPartyShortcode } from "./identifier-fields";

/** Relative portions are reusable identities and weights, never allocated money. */
export const expenseBeneficiaryPortion = z.object({
  partyId: ledgerPartyShortcode.nullable(),
  partyName: z.string().nullable(),
  allocationKey: z.string(),
  weight: z.string().regex(/^[1-9][0-9]*$/u),
  basis: z.enum([
    "recorded",
    "derived_from_payment",
    "derived_from_purchaser",
    "assumed_household",
    "unknown",
  ]),
});
export const expenseBeneficiaryEvidence = expenseBeneficiaryPortion.extend({
  contributors: z.array(fieldSource),
});
export const expenseBeneficiaryResult = z.object({
  portions: z.array(expenseBeneficiaryPortion),
  evidence: z.array(expenseBeneficiaryEvidence),
});
