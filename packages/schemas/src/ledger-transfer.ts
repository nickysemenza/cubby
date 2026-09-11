import { z } from "zod";
import { auditDateFilterFields, plainDate } from "./base-entity";
import type { GeneratedEntitySortField } from "./generated/entity-sort.gen";
import { ledgerPartyShortcode, ledgerTransferShortcode } from "./identifiers";
import { createPaginatedResponseSchema, oneOrMany } from "./pagination";
import { generatedLedgerTransferFieldSchemas } from "./generated/entity-field-schemas.ledgerTransfer.gen";
export {
  ledgerSourceClaimInput,
  ledgerSourceClaimNormalizedEvidence,
  ledgerSourceClaimOut,
  ledgerSourceClaimReconciliation,
  ledgerSourceClaims,
  ledgerTransferEvidenceTransactionIds,
  type LedgerSourceClaimInput,
  type LedgerSourceClaimNormalizedEvidence,
  type LedgerSourceClaimOut,
  type LedgerSourceClaimReconciliation,
} from "./ledger-transfer-fields";

const ledgerTransferCreateFields = generatedLedgerTransferFieldSchemas.create;

export const ledgerTransferCreateInput = z.object(ledgerTransferCreateFields);
export type LedgerTransferCreateInput = z.infer<
  typeof ledgerTransferCreateInput
>;

export const ledgerTransferUpdateData = z.object(
  generatedLedgerTransferFieldSchemas.update,
);
export type LedgerTransferUpdateData = z.infer<typeof ledgerTransferUpdateData>;

export const ledgerTransferUpdateInput = z.object({
  id: ledgerTransferShortcode,
  data: ledgerTransferUpdateData,
});
export type LedgerTransferUpdateInput = z.infer<
  typeof ledgerTransferUpdateInput
>;

export const ledgerTransferFilterFields = {
  ...auditDateFilterFields,
  fromPartyId: oneOrMany(ledgerPartyShortcode).optional(),
  toPartyId: oneOrMany(ledgerPartyShortcode).optional(),
  dateFrom: plainDate.optional(),
  dateTo: plainDate.optional(),
};
export const ledgerTransferFiltersSchema = z.object(ledgerTransferFilterFields);
export type LedgerTransferFilters = z.infer<typeof ledgerTransferFiltersSchema>;

export type LedgerTransferSortField =
  GeneratedEntitySortField<"ledgerTransfer">;

export const ledgerTransferOut = z.object({
  ...generatedLedgerTransferFieldSchemas.read,
});
export type LedgerTransferOut = z.infer<typeof ledgerTransferOut>;

export const ledgerTransferListResponse =
  createPaginatedResponseSchema(ledgerTransferOut);
export type LedgerTransferListResponse = z.infer<
  typeof ledgerTransferListResponse
>;
