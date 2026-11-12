import type { ProblemKey } from "@cubby/schemas/problems";
import type { ProblemAction } from "./problem-query";

/**
 * The Problems page's real remediation capabilities, kept apart from query
 * declarations so membership remains one filter/diagnostic declaration.
 *
 * `canonical-query` is intentionally narrow: a group action with that target
 * must resolve its IDs by running the registered server query again, never by
 * trusting loaded rows. `global-backfill` describes jobs whose
 * scope is broader than the displayed Problem population.
 */
const action = <const T extends ProblemAction>(capability: T): T => capability;

export const problemActionCapabilities = {
  duplicateProductIdentities: [
    action({ id: "merge", label: "Merge", scope: "item", target: "item" }),
  ],
  orphanedProducts: [
    action({
      id: "delete",
      label: "Delete",
      scope: "item",
      target: "item",
      destructive: true,
    }),
  ],
  ingredientsWithPartialCoverage: [
    action({
      id: "repair-coverage",
      label: "Fix conversion coverage",
      scope: "item",
      target: "guided-flow",
    }),
  ],
  productsWithIslandedMappings: [
    action({
      id: "add-conversion",
      label: "Add conversion",
      scope: "item",
      target: "guided-flow",
    }),
  ],
  ingredientsWithoutProduct: [
    action({
      id: "open-workbench",
      label: "Fix in workbench",
      scope: "item",
      target: "guided-flow",
    }),
  ],
  unusedIngredientsWithProduct: [
    action({
      id: "delete",
      label: "Delete ingredient and products",
      scope: "item",
      target: "item",
      destructive: true,
    }),
    action({
      id: "delete-all",
      label: "Delete all",
      scope: "group",
      target: "canonical-query",
      destructive: true,
    }),
  ],
  unusedIngredientsWithoutProduct: [
    action({
      id: "delete",
      label: "Delete",
      scope: "item",
      target: "item",
      destructive: true,
    }),
    action({
      id: "delete-all",
      label: "Delete all",
      scope: "group",
      target: "canonical-query",
      destructive: true,
    }),
  ],
  duplicateVendors: [
    action({ id: "merge", label: "Merge", scope: "item", target: "item" }),
  ],
  duplicateFinancialTransactionSourceRefs: [
    action({
      id: "choose-keeper",
      label: "Choose keeper",
      scope: "item",
      target: "item",
    }),
  ],
  duplicateFinancialAccountSourceAliases: [
    action({
      id: "choose-keeper",
      label: "Choose keeper",
      scope: "item",
      target: "item",
    }),
  ],
  unknownParkedItems: [
    action({
      id: "start-recount",
      label: "Start recount",
      scope: "item",
      target: "guided-flow",
    }),
  ],
  locationsWithoutAiDescription: [
    action({
      id: "analyze-all",
      label: "Analyze all",
      scope: "group",
      target: "global-backfill",
    }),
  ],
} as const satisfies Partial<Record<ProblemKey, readonly ProblemAction[]>>;

export const problemActionsFor = (key: ProblemKey): readonly ProblemAction[] =>
  Object.entries(problemActionCapabilities).find(
    ([candidate]) => candidate === key,
  )?.[1] ?? [];

export const problemActionId = (key: ProblemKey, verb: string) =>
  `${key}:${verb}`;
