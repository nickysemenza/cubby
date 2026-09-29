import { z } from "zod";
import type { GeneratedEntitySortField } from "./generated/entity-sort.gen";
import { ledgerPartyShortcode } from "./identifiers";
import { createPaginatedResponseSchema } from "./pagination";
import { ledgerPartyOut } from "./generated/ledgerParty.gen";

export {
  ledgerPartyCreateInput,
  ledgerPartyUpdateData,
  ledgerPartyUpdateInput,
  ledgerPartyOut,
  ledgerPartyFilterFields,
  ledgerPartyFiltersSchema,
  type LedgerPartyCreateInput,
  type LedgerPartyUpdateData,
  type LedgerPartyUpdateInput,
  type LedgerPartyOut,
  type LedgerPartyFilters,
} from "./generated/ledgerParty.gen";
export {
  ledgerAttributionInput,
  ledgerAttributions,
  ledgerPartyKind,
  ledgerPartyKindValues,
  type LedgerAttributionInput,
  type LedgerPartyKind,
} from "./ledger-party-fields";
import { ledgerPartyKind } from "./ledger-party-fields";

export const contributionRoleValues = ["beneficiary", "funder"] as const;
export const contributionRole = z.enum(contributionRoleValues);
export type ContributionRole = z.infer<typeof contributionRole>;

export type LedgerPartySortField = GeneratedEntitySortField<"ledgerParty">;

export const ledgerPartyListResponse =
  createPaginatedResponseSchema(ledgerPartyOut);
export type LedgerPartyListResponse = z.infer<typeof ledgerPartyListResponse>;

export const ledgerPartyOptionsOut = z.array(
  z.object({
    id: ledgerPartyShortcode,
    name: z.string(),
    kind: ledgerPartyKind,
  }),
);
export type LedgerPartyOptionsOut = z.infer<typeof ledgerPartyOptionsOut>;
