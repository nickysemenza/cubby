import { moneyToMinor, minorToMoney } from "@cubby/shared";

import {
  statementEffectiveMovement as movement,
  type StatementMovementInput as MinorMovementInput,
  type StatementEffectiveMovement as MinorMovement,
} from "~/server/domains/transaction-import/policy/statement-effective-movement";
import {
  statementTransactionKind as kind,
  decideStatementKind as decide,
} from "~/server/domains/transaction-import/policy/statement-transaction-kind";
export type StatementMovementInput = Omit<
  MinorMovementInput,
  "providerAmountMinor"
> & { providerAmount: number };
export type StatementEffectiveMovement = Omit<
  MinorMovement,
  "effectiveAmountMinor"
> & { effectiveAmount: number };
/** Dollar wire decoding and frozen preview shape stay outside the minor-unit rules. */
export function statementEffectiveMovement(
  input: StatementMovementInput,
): StatementEffectiveMovement {
  const { providerAmount, ...fields } = input;
  const { effectiveAmountMinor, ...result } = movement({
    ...fields,
    providerAmountMinor: moneyToMinor(providerAmount),
  });
  return {
    effectiveAmount:
      effectiveAmountMinor === 0n
        ? -providerAmount
        : minorToMoney(effectiveAmountMinor),
    ...result,
  };
}
export function statementTransactionKind(
  input: Omit<Parameters<typeof kind>[0], "amountMinor"> & { amount: number },
) {
  const { amount, ...fields } = input;
  return kind({ ...fields, amountMinor: moneyToMinor(amount) });
}
export function decideStatementKind(
  input: Omit<Parameters<typeof decide>[0], "amountMinor"> & { amount: number },
) {
  const { amount, ...fields } = input;
  return decide({ ...fields, amountMinor: moneyToMinor(amount) });
}
