import { z } from "zod";
import { uniqueBy } from "./base-entity";
import { ledgerPartyShortcode } from "./identifier-fields";

export const ledgerPartyKindValues = ["member", "guest", "household"] as const;
export const ledgerPartyKind = z.enum(ledgerPartyKindValues);
export type LedgerPartyKind = z.infer<typeof ledgerPartyKind>;

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
