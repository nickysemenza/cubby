import { financialAccountIdentity } from "@cubby/schemas/financial-account-fields";

import type { ResolvedBasis } from "~/server/ai/policy/field-suggest";

export function hasCreditCardIdentity(basis: ResolvedBasis): boolean {
  if (!basis.identity) return false;
  try {
    const value: unknown = JSON.parse(basis.identity);
    const parsed = financialAccountIdentity.safeParse(value);
    return parsed.success && parsed.data.kind === "credit_card";
  } catch {
    return false;
  }
}
