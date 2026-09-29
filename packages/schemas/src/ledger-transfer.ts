import { z } from "zod";
import type { GeneratedEntitySortField } from "./generated/entity-sort.gen";
import { ledgerPartyShortcode } from "./identifiers";
import { createPaginatedResponseSchema, oneOrMany } from "./pagination";
import {
  ledgerTransferBaseFilterFields,
  ledgerTransferOut,
} from "./generated/ledgerTransfer.gen";

export {
  ledgerTransferCreateInput,
  ledgerTransferUpdateData,
  ledgerTransferUpdateInput,
  ledgerTransferOut,
  type LedgerTransferCreateInput,
  type LedgerTransferUpdateData,
  type LedgerTransferUpdateInput,
  type LedgerTransferOut,
} from "./generated/ledgerTransfer.gen";
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

export const ledgerTransferFilterFields = {
  ...ledgerTransferBaseFilterFields,
  fromPartyId: oneOrMany(ledgerPartyShortcode).optional(),
  toPartyId: oneOrMany(ledgerPartyShortcode).optional(),
};
export const ledgerTransferFiltersSchema = z.object(ledgerTransferFilterFields);
export type LedgerTransferFilters = z.infer<typeof ledgerTransferFiltersSchema>;

export type LedgerTransferSortField =
  GeneratedEntitySortField<"ledgerTransfer">;

export const ledgerTransferListResponse =
  createPaginatedResponseSchema(ledgerTransferOut);
export type LedgerTransferListResponse = z.infer<
  typeof ledgerTransferListResponse
>;
