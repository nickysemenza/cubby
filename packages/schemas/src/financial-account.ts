import { z } from "zod";
import type { GeneratedEntitySortField } from "./generated/entity-sort.gen";
import { financialAccountRelatedFilterFields } from "./related-view";
import { auditDateFilterFields } from "./base-entity";
import { financialAccountShortcode, ledgerPartyShortcode } from "./identifiers";
import {
  createPaginatedResponseSchema,
  oneOrMany,
  presenceFilter,
} from "./pagination";
import {
  financialAccountIdentityKind,
  financialAccountLast4 as last4,
} from "./financial-account-fields";
import {
  generatedFinancialAccountFieldSchemas,
  generatedFinancialAccountFilterFields,
} from "./generated/entity-field-schemas.financialAccount.gen";

export {
  cardLastFoursOn,
  currentLast4,
  financialAccountCardNumber,
  financialAccountCardNumberKind,
  financialAccountCardNumbers,
  financialAccountIdentity,
  financialAccountIdentityKind,
  financialAccountSourceAlias,
  financialAccountSourceAliases,
  type FinancialAccountCardNumber,
  type FinancialAccountCardNumberKind,
  type FinancialAccountIdentity,
  type FinancialAccountIdentityKind,
  type FinancialAccountSourceAlias,
} from "./financial-account-fields";

const financialAccountCreateFields =
  generatedFinancialAccountFieldSchemas.create;

export const financialAccountCreateInput = z.object(
  financialAccountCreateFields,
);
export type FinancialAccountCreateInput = z.infer<
  typeof financialAccountCreateInput
>;

export const financialAccountUpdateData = z.object(
  generatedFinancialAccountFieldSchemas.update,
);
export type FinancialAccountUpdateData = z.infer<
  typeof financialAccountUpdateData
>;
export const financialAccountUpdateInput = z.object({
  id: financialAccountShortcode,
  data: financialAccountUpdateData,
});
export type FinancialAccountUpdateInput = z.infer<
  typeof financialAccountUpdateInput
>;

export const financialAccountFilterFields = {
  ...auditDateFilterFields,
  ...financialAccountRelatedFilterFields,
  ...generatedFinancialAccountFilterFields,
  ledgerPartyId: oneOrMany(ledgerPartyShortcode).optional(),
  identityKind: oneOrMany(financialAccountIdentityKind).optional(),
  last4: last4.optional(),
  source: oneOrMany(z.string().min(1)).optional(),
  externalAccountId: oneOrMany(z.string().min(1)).optional(),
  sourceAliasPresenceFilter: presenceFilter,
};
export const financialAccountFiltersSchema = z.object(
  financialAccountFilterFields,
);
export type FinancialAccountFilters = z.infer<
  typeof financialAccountFiltersSchema
>;

export type FinancialAccountSortField =
  GeneratedEntitySortField<"financialAccount">;

export const financialAccountOut = z.object(
  generatedFinancialAccountFieldSchemas.read,
);
export type FinancialAccountOut = z.infer<typeof financialAccountOut>;

/**
 * The account picklist — feeds the transactions table's Account filter. Same
 * shape as `vendorOptionsOut`, and deliberately not the full `financialAccountOut`:
 * a header filter needs an eagerly-loaded roster, so it stays cheap.
 */
export const financialAccountOptionsOut = z.array(
  z.object({
    id: financialAccountShortcode,
    name: z.string(),
    count: z.number().int(),
  }),
);
export type FinancialAccountOptionsOut = z.infer<
  typeof financialAccountOptionsOut
>;

export const financialAccountListResponse =
  createPaginatedResponseSchema(financialAccountOut);
export type FinancialAccountListResponse = z.infer<
  typeof financialAccountListResponse
>;
