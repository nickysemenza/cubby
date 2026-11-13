import { financialAccountIdentityKind } from "@cubby/schemas/financial-account";
import { ledgerPartyKind } from "@cubby/schemas/ledger-party";

import type {
  financialAccount,
  ledgerParty,
} from "~/server/db/retained-tables";
export type PurchaserProof =
  | {
      soleAccess: boolean;
      primaryCardholder: Pick<
        typeof ledgerParty.$inferSelect,
        "id" | "shortcode" | "kind" | "deletedAt"
      > | null;
    }
  | undefined;
export const accountPurchaserKey = (accountId: string, date: string | null) =>
  `${accountId}:${date ?? ""}`;

/** Household spending authority does not identify an individual purchaser. */
export function liveHouseholdSpendingAccount(
  account:
    | (typeof financialAccount.$inferSelect & {
        ledgerParty: typeof ledgerParty.$inferSelect | null;
      })
    | null
    | undefined,
): boolean {
  return (
    !!account &&
    !account.deletedAt &&
    householdSpendingKinds.has(account.identity.kind) &&
    account.ledgerParty?.kind === ledgerPartyKind.enum.household &&
    !account.ledgerParty.deletedAt
  );
}

/** Loan escrow can spend household funds without identifying a purchaser. */
export function liveHouseholdLoan(
  account: Parameters<typeof liveHouseholdSpendingAccount>[0],
): boolean {
  return (
    !!account &&
    !account.deletedAt &&
    account.identity.kind === financialAccountIdentityKind.enum.loan &&
    account.ledgerParty?.kind === ledgerPartyKind.enum.household &&
    !account.ledgerParty.deletedAt
  );
}

// Loans and other liabilities hold payments, not spending.
const householdSpendingKinds = new Set<string>([
  financialAccountIdentityKind.enum.credit_card,
  financialAccountIdentityKind.enum.bank_account,
  financialAccountIdentityKind.enum.stored_value,
]);

/** Household-card authority does not identify an individual purchaser. */
function liveHouseholdCard(
  account: typeof financialAccount.$inferSelect & {
    ledgerParty: typeof ledgerParty.$inferSelect | null;
  },
): boolean {
  return (
    !account.deletedAt &&
    account.identity.kind === financialAccountIdentityKind.enum.credit_card &&
    account.ledgerParty?.kind === ledgerPartyKind.enum.household &&
    !account.ledgerParty.deletedAt
  );
}

/** Purchaser authority is independent of dated funding attribution. */
export function financialAccountPurchaser(
  account: typeof financialAccount.$inferSelect & {
    ledgerParty: typeof ledgerParty.$inferSelect | null;
  },
  proof: PurchaserProof,
) {
  if (account.deletedAt) return null;
  if (
    account.ledgerParty?.kind === ledgerPartyKind.enum.member &&
    !account.ledgerParty.deletedAt
  )
    return account.ledgerParty;
  if (
    liveHouseholdCard(account) &&
    proof?.soleAccess &&
    proof.primaryCardholder?.kind === ledgerPartyKind.enum.member &&
    !proof.primaryCardholder.deletedAt
  )
    return proof.primaryCardholder;
  return null;
}
