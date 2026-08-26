import type { ProblemKey } from "@cubby/schemas/problems";
import type { ProblemAction, ProblemQuery } from "./problem-query";

/**
 * The Problems page's real remediation capabilities, kept apart from query
 * declarations so membership remains one filter/diagnostic declaration.
 *
 * `canonical-query` is intentionally narrow: a bulk action with that target
 * must resolve its IDs by running the registered server query again, never by
 * trusting the card's sampled rows. `global-backfill` describes jobs whose
 * scope is broader than the displayed Problem population.
 */
const action = <const T extends ProblemAction>(capability: T): T => capability;

const problemActionCapabilities = {
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
      scope: "bulk",
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
      scope: "bulk",
      target: "canonical-query",
      destructive: true,
    }),
  ],
  emptyLocations: [
    action({
      id: "add-inventory",
      label: "Add inventory",
      scope: "item",
      target: "item",
    }),
  ],
  staleLocations: [
    action({
      id: "start-recount",
      label: "Start recount",
      scope: "item",
      target: "guided-flow",
    }),
  ],
  neverVerifiedInventory: [
    action({
      id: "start-recount",
      label: "Start recount",
      scope: "item",
      target: "guided-flow",
    }),
  ],
  duplicateVendors: [
    action({ id: "merge", label: "Merge", scope: "item", target: "item" }),
  ],
  vendorsWithoutLogos: [
    action({
      id: "fetch-logo",
      label: "Fetch logo",
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
  productsWithNoImages: [
    action({
      id: "fetch-images",
      label: "Fetch images",
      scope: "bulk",
      target: "global-backfill",
    }),
  ],
  locationsWithoutAiDescription: [
    action({
      id: "analyze-all",
      label: "Analyze all",
      scope: "bulk",
      target: "global-backfill",
    }),
  ],
  orphanedEntityEmbeddings: [
    action({
      id: "clean-up",
      label: "Clean up",
      scope: "item",
      target: "item",
      destructive: true,
    }),
  ],
  entitiesMissingEmbeddings: [
    action({
      id: "backfill-all",
      label: "Backfill all",
      scope: "bulk",
      target: "global-backfill",
    }),
  ],
  productsWithBetterUpcData: [
    action({ id: "apply", label: "Apply", scope: "item", target: "item" }),
  ],
} as const satisfies Partial<Record<ProblemKey, readonly ProblemAction[]>>;

export const problemActionsFor = (key: ProblemKey): readonly ProblemAction[] =>
  Object.entries(problemActionCapabilities).find(
    ([candidate]) => candidate === key,
  )?.[1] ?? [];

/** Attach UI capabilities at registry composition, never in a query source. */
export function withProblemActionCapabilities(
  definitions: readonly ProblemQuery[],
): readonly ProblemQuery[] {
  return definitions.map((definition) => {
    const registered = problemActionsFor(definition.key);
    if (definition.actions.length && registered.length) {
      throw new Error(
        `Problem "${definition.key}" declares actions twice; use problem-actions.ts`,
      );
    }
    return {
      ...definition,
      actions: registered.length ? registered : definition.actions,
    };
  });
}
