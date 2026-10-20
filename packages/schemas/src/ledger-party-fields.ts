import { z } from "zod";
import { uniqueBy } from "./base-entity";
import { ledgerPartyShortcode } from "./identifier-fields";

export const contributionRoleValues = ["beneficiary", "funder"] as const;
export const contributionRole = z.enum(contributionRoleValues);
export type ContributionRole = z.infer<typeof contributionRole>;

export const ledgerPartyKindValues = ["member", "guest", "household"] as const;
export const ledgerPartyKind = z.enum(ledgerPartyKindValues);
export type LedgerPartyKind = z.infer<typeof ledgerPartyKind>;

/** Party identity in ownership, work-routing, and transfer responses. */
export const ledgerPartyRefOut = z.object({
  id: ledgerPartyShortcode,
  name: z.string(),
});

/** A person, excluding the household collective, in ownership and meal reads. */
export const ledgerPartyPersonSummary = ledgerPartyRefOut.extend({
  kind: ledgerPartyKind.exclude(["household"]),
});

export const LEDGER_PARTY_KIND_LABELS = {
  member: "Member",
  guest: "Guest",
  household: "Household",
} as const satisfies Record<LedgerPartyKind, string>;

export const ledgerAttributionInput = z.strictObject({
  partyId: ledgerPartyShortcode.nullable(),
  weight: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type LedgerAttributionInput = z.infer<typeof ledgerAttributionInput>;
export const ledgerAttributions = z
  .array(ledgerAttributionInput)
  .refine(
    ...uniqueBy<LedgerAttributionInput>(
      (attribution) => attribution.partyId ?? "__unattributed__",
      "attributions must not contain duplicate ledger parties",
    ),
  );
