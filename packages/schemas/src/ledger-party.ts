import { z } from "zod";
import { auditDateFilterFields } from "./base-entity";
import type { GeneratedEntitySortField } from "./generated/entity-sort.gen";
import {
  generatedLedgerPartyFieldSchemas,
  generatedLedgerPartyFilterFields,
} from "./generated/entity-field-schemas.ledgerParty.gen";
import { ledgerPartyShortcode } from "./identifiers";
import { createPaginatedResponseSchema } from "./pagination";
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

const ledgerPartyCreateFields = generatedLedgerPartyFieldSchemas.create;

export const ledgerPartyCreateInput = z.object(ledgerPartyCreateFields);
export type LedgerPartyCreateInput = z.infer<typeof ledgerPartyCreateInput>;

export const ledgerPartyUpdateData = z.object(
  generatedLedgerPartyFieldSchemas.update,
);
export type LedgerPartyUpdateData = z.infer<typeof ledgerPartyUpdateData>;

export const ledgerPartyUpdateInput = z.object({
  id: ledgerPartyShortcode,
  data: ledgerPartyUpdateData,
});
export type LedgerPartyUpdateInput = z.infer<typeof ledgerPartyUpdateInput>;

export const ledgerPartyFilterFields = {
  ...auditDateFilterFields,
  ...generatedLedgerPartyFilterFields,
};
export const ledgerPartyFiltersSchema = z.object(ledgerPartyFilterFields);
export type LedgerPartyFilters = z.infer<typeof ledgerPartyFiltersSchema>;

export type LedgerPartySortField = GeneratedEntitySortField<"ledgerParty">;

export const ledgerPartyOut = z.object({
  ...generatedLedgerPartyFieldSchemas.read,
});
export type LedgerPartyOut = z.infer<typeof ledgerPartyOut>;

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
