import { z } from "zod";
import { plainDate } from "./base-entity";
import { ledgerPartyShortcode } from "./identifier-fields";

/** Inclusive dates; null endpoints are unbounded. */
const accountPartyPeriod = z
  .strictObject({
    ledgerPartyId: ledgerPartyShortcode,
    validFrom: plainDate.nullable(),
    validTo: plainDate.nullable(),
  })
  .refine(
    (row) =>
      row.validFrom === null ||
      row.validTo === null ||
      row.validFrom <= row.validTo,
    "validFrom must not be after validTo",
  );

const periodsOverlap = (
  a: z.infer<typeof accountPartyPeriod>,
  b: z.infer<typeof accountPartyPeriod>,
) =>
  (a.validTo === null || b.validFrom === null || b.validFrom <= a.validTo) &&
  (b.validTo === null || a.validFrom === null || a.validFrom <= b.validTo);

export const financialAccountAuthorizedUsers = z
  .array(accountPartyPeriod)
  .refine(
    (rows) =>
      rows.every((row, i) =>
        rows
          .slice(i + 1)
          .every(
            (other) =>
              row.ledgerPartyId !== other.ledgerPartyId ||
              !periodsOverlap(row, other),
          ),
      ),
    "Authorized-user periods for the same member must not overlap",
  );
export const financialAccountFundingPeriods = z
  .array(accountPartyPeriod)
  .refine(
    (rows) =>
      rows.every((row, i) =>
        rows.slice(i + 1).every((other) => !periodsOverlap(row, other)),
      ),
    "Funding periods must not overlap",
  );

export type FinancialAccountPartyPeriod = z.infer<typeof accountPartyPeriod>;
