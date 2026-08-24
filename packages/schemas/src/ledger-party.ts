import { z } from "zod";
import {
  auditDateFilterFields,
  deriveUpdateData,
  timestampedFields,
  uniqueBy,
} from "./base-entity";
import { requiredName } from "./common";
import { ledgerPartyShortcode } from "./identifiers";
import { createPaginatedResponseSchema, oneOrMany } from "./pagination";

export const ledgerPartyKindValues = ["member", "guest", "household"] as const;
export const ledgerPartyKind = z.enum(ledgerPartyKindValues);
export type LedgerPartyKind = z.infer<typeof ledgerPartyKind>;

export const contributionRoleValues = ["beneficiary", "funder"] as const;
export const contributionRole = z.enum(contributionRoleValues);
export type ContributionRole = z.infer<typeof contributionRole>;

const ledgerPartyFields = {
  name: z.string(),
  kind: ledgerPartyKind,
  notes: z.string().nullable(),
};

const ledgerPartyCreateShape = {
  name: requiredName("Ledger party name"),
  kind: ledgerPartyKind,
  notes: z.string().nullable().default(null),
};

export const ledgerPartyCreateInput = z.object(ledgerPartyCreateShape);
export type LedgerPartyCreateInput = z.infer<typeof ledgerPartyCreateInput>;

export const ledgerPartyUpdateData = deriveUpdateData(ledgerPartyCreateShape);
export type LedgerPartyUpdateData = z.infer<typeof ledgerPartyUpdateData>;

export const ledgerPartyUpdateInput = z.object({
  id: ledgerPartyShortcode,
  data: ledgerPartyUpdateData,
});
export type LedgerPartyUpdateInput = z.infer<typeof ledgerPartyUpdateInput>;

export const ledgerPartyFilterFields = {
  ...auditDateFilterFields,
  search: z.string().optional(),
  kind: oneOrMany(ledgerPartyKind).optional(),
};
export const ledgerPartyFiltersSchema = z.object(ledgerPartyFilterFields);
export type LedgerPartyFilters = z.infer<typeof ledgerPartyFiltersSchema>;

export const ledgerPartySortableFields = [
  "name",
  "kind",
  "createdAt",
  "updatedAt",
] as const;
export type LedgerPartySortField = (typeof ledgerPartySortableFields)[number];

export const ledgerPartyOut = z.object({
  id: ledgerPartyShortcode,
  ...ledgerPartyFields,
  ...timestampedFields,
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

export const ledgerAttributionInput = z.strictObject({
  partyId: ledgerPartyShortcode.nullable(),
  weight: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type LedgerAttributionInput = z.infer<typeof ledgerAttributionInput>;

export const ledgerAttributions = z
  .array(ledgerAttributionInput)
  .refine(
    ...uniqueBy(
      (attribution: LedgerAttributionInput) =>
        attribution.partyId ?? "__unattributed__",
      "attributions must not contain duplicate ledger parties",
    ),
  );
