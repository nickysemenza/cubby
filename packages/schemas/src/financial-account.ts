export type { FinancialAccountPartyPeriod } from "./financial-account-party-fields";
import { z } from "zod";
import { oneOrMany, presenceFilter } from "./pagination";
import {
  financialAccountIdentityKind,
  financialAccountLast4 as last4,
} from "./financial-account-fields";
import { financialAccountFilterFields as financialAccountBaseFilterFields } from "@cubby/schemas/entities/financialAccount";

export {
  cardLastFoursOn,
  currentLast4,
  financialAccountCardNumbers,
  financialAccountIdentity,
  financialAccountIdentityKind,
  financialAccountSourceAliases,
  type FinancialAccountCardNumber,
  type FinancialAccountCardNumberKind,
  type FinancialAccountIdentity,
  type FinancialAccountSourceAlias,
} from "./financial-account-fields";

export const financialAccountFilterFields = {
  ...financialAccountBaseFilterFields,
  identityKind: oneOrMany(financialAccountIdentityKind).optional(),
  last4: oneOrMany(last4).optional(),
  source: oneOrMany(z.string().min(1)).optional(),
  externalAccountId: oneOrMany(z.string().min(1)).optional(),
  sourceAliasPresenceFilter: presenceFilter,
};
const financialAccountFiltersSchema = z.object(financialAccountFilterFields);
export type FinancialAccountFilters = z.infer<
  typeof financialAccountFiltersSchema
>;
