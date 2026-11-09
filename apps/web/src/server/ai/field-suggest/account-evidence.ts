import { financialAccountIdentity } from "@cubby/schemas/financial-account-fields";
import { parseJsonAs } from "@cubby/shared/parse-json-as";

import type { ResolvedBasis } from "~/server/ai/policy/field-suggest";

export function hasCreditCardIdentity(basis: ResolvedBasis): boolean {
  if (!basis.identity) return false;
  return (
    parseJsonAs(financialAccountIdentity, basis.identity)?.kind ===
    "credit_card"
  );
}
