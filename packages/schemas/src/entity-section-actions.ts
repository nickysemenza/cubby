/**
 * Verbs a `summary` or `recordList` detail section may offer. A declaration names the verbs; the
 * server's section read says, per record, whether each is available and why not. Each verb runs
 * an existing operation on every client that implements it (`native-coverage.ts` classifies the
 * rest), so no client can settle, search or split anything another would refuse.
 *
 * A leaf module: the entity-definition schema imports it before the generated files exist.
 */
export const SECTION_ACTION_IDS = [
  /** Review statement activity near the order and allocate one charge or refund to it. */
  "matchStatement",
  /** Start one browser run for the selected statement charges. */
  "searchCharges",
  /** Start or resume the account browser sync. */
  "syncAccount",
  /** Put what the expense bought on a shelf. */
  "receiveExpense",
  /** File the expense's parts under its purchase. */
  "splitExpense",
  /** Attach existing expenses to the purchase. */
  "linkExpenses",
  /** Attach products to the purchase. */
  "linkProducts",
] as const;
export type SectionActionId = (typeof SECTION_ACTION_IDS)[number];
