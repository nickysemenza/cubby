import type { OperationContract } from "~/contracts/define";

const isOperationContract = (value: unknown): value is OperationContract =>
  typeof value === "object" &&
  value !== null &&
  "domain" in value &&
  typeof value.domain === "string" &&
  "ops" in value &&
  typeof value.ops === "object" &&
  value.ops !== null;

/**
 * Every `defineContract()` export of every `contracts/*.contract.ts` module,
 * for tests that sweep the whole operation surface. There is deliberately no
 * contracts barrel: production code imports the one contract module it needs.
 */
export const allContracts: readonly OperationContract[] = Object.values(
  import.meta.glob<object>("../../contracts/*.contract.ts", {
    eager: true,
  }),
).flatMap((module) => Object.values(module).filter(isOperationContract));
