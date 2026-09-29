import { z } from "zod";
import type { GeneratedEntitySortField } from "./generated/entity-sort.gen";
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
  financialAccountBaseFilterFields,
  financialAccountOut,
} from "./generated/financialAccount.gen";

export {
  financialAccountCreateInput,
  financialAccountUpdateData,
  financialAccountUpdateInput,
  financialAccountOut,
  type FinancialAccountCreateInput,
  type FinancialAccountUpdateData,
  type FinancialAccountUpdateInput,
  type FinancialAccountOut,
} from "./generated/financialAccount.gen";

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

export const financialAccountFilterFields = {
  ...financialAccountBaseFilterFields,
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

export const financialAccountListResponse =
  createPaginatedResponseSchema(financialAccountOut);
export type FinancialAccountListResponse = z.infer<
  typeof financialAccountListResponse
>;
