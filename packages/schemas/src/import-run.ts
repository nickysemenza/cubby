import { z } from "zod";

import {
  generatedRunFieldSchemas,
  generatedRunFilterFields,
} from "./generated/entity-field-schemas.importRun.gen";
import {
  ledgerPartyShortcode,
  vendorAccountShortcode,
  vendorShortcode,
} from "./identifiers";
import { createPaginatedResponseSchema, entityFilterList } from "./pagination";

export const importRunOut = z.object(generatedRunFieldSchemas.read);
export type ImportRunOut = z.infer<typeof importRunOut>;
export const importRunListResponse =
  createPaginatedResponseSchema(importRunOut);
export const importRunFilterFields = {
  ...generatedRunFilterFields,
  vendorAccountId: entityFilterList(vendorAccountShortcode).optional(),
  vendorId: entityFilterList(vendorShortcode).optional(),
  ledgerPartyId: entityFilterList(ledgerPartyShortcode).optional(),
  /**
   * Ephemeral runs (one per Jev pass or AI action) are hidden unless this is
   * set or a `purpose` filter asks for them explicitly.
   */
  includeEphemeral: z.boolean().optional(),
};
export const importRunFilters = z.object(importRunFilterFields);
export type ImportRunFilters = z.infer<typeof importRunFilters>;
