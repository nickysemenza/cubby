import { z } from "zod";

import {
  generatedImportRunFieldSchemas,
  generatedImportRunFilterFields,
} from "./generated/entity-field-schemas.importRun.gen";
import {
  ledgerPartyShortcode,
  vendorAccountShortcode,
  vendorShortcode,
} from "./identifiers";
import { createPaginatedResponseSchema, entityFilterList } from "./pagination";

export const importRunOut = z.object(generatedImportRunFieldSchemas.read);
export type ImportRunOut = z.infer<typeof importRunOut>;
export const importRunListResponse =
  createPaginatedResponseSchema(importRunOut);
export const importRunFilterFields = {
  ...generatedImportRunFilterFields,
  vendorAccountId: entityFilterList(vendorAccountShortcode).optional(),
  vendorId: entityFilterList(vendorShortcode).optional(),
  ledgerPartyId: entityFilterList(ledgerPartyShortcode).optional(),
};
export const importRunFilters = z.object(importRunFilterFields);
export type ImportRunFilters = z.infer<typeof importRunFilters>;
