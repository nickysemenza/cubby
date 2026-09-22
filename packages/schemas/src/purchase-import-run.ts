import { z } from "zod";

import {
  generatedImportRunFieldSchemas,
  generatedImportRunFilterFields,
} from "./generated/entity-field-schemas.purchaseImportRun.gen";
import {
  ledgerPartyShortcode,
  vendorAccountShortcode,
  vendorShortcode,
} from "./identifiers";
import { createPaginatedResponseSchema, entityFilterList } from "./pagination";

export const purchaseImportRunOut = z.object(
  generatedImportRunFieldSchemas.read,
);
export type PurchaseImportRunOut = z.infer<typeof purchaseImportRunOut>;
export const purchaseImportRunListResponse =
  createPaginatedResponseSchema(purchaseImportRunOut);
export const purchaseImportRunFilterFields = {
  ...generatedImportRunFilterFields,
  vendorAccountId: entityFilterList(vendorAccountShortcode).optional(),
  vendorId: entityFilterList(vendorShortcode).optional(),
  ledgerPartyId: entityFilterList(ledgerPartyShortcode).optional(),
};
export const purchaseImportRunFilters = z.object(purchaseImportRunFilterFields);
export type PurchaseImportRunFilters = z.infer<typeof purchaseImportRunFilters>;
