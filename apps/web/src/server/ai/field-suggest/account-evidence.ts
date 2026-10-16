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

/** Saved issuers and literal labelled values supply vocabulary, never a semantic match. */
export function issuerCandidates(
  savedIssuers: readonly string[],
  basis: ResolvedBasis,
): string[] {
  const labelled = [basis.notes, basis.statementEvidence]
    .flatMap((text) => text?.split(/\r?\n/) ?? [])
    .flatMap((line) => {
      const value = /^issuer\s*:\s*(.+)$/i.exec(line.trim())?.[1]?.trim();
      return value && value.length <= 160 ? [value] : [];
    });
  const unique = new Map<string, string>();
  for (const value of [...savedIssuers, ...labelled]) {
    const key = value.trim().toLocaleLowerCase("en-US");
    if (key && !unique.has(key)) unique.set(key, value.trim());
  }
  return [...unique.values()];
}
