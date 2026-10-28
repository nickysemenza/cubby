import type { ProblemKey } from "@cubby/schemas/problems";
import type { ComponentType } from "react";

import type { WorkActionProps } from "~/entity/work-queue/work-action-props";

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
      scope: "group",
      target: "global-backfill",
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

type ProblemActionCapabilities = typeof problemActionCapabilities;
type ActionProps<A extends ProblemAction> = WorkActionProps<
  A["scope"] extends "item" ? "item" : "group"
>;

/**
 * What performs each declared action, shaped by the declarations above: a
 * missing, extra or renamed Problem or verb is a compile error in the table
 * `features/registry.tsx` fills, and each handler receives the target its
 * declared scope implies.
 */
export type ProblemActionHandlers = {
  readonly [K in keyof ProblemActionCapabilities]: {
    readonly [
      A in ProblemActionCapabilities[K][number] as A["id"]
    ]: ComponentType<ActionProps<A>>;
  };
};

/** The wire id of a Problem's action; `problemActionHandler` reads it back. */
export const problemActionId = (key: ProblemKey, verb: string) =>
  `${key}:${verb}`;

/** The handler for a wire action id, or undefined for one this client does
 * not declare (a stale or newer server). */
export function problemActionHandler(
  handlers: ProblemActionHandlers,
  id: string,
): ComponentType<WorkActionProps> | undefined {
  const separator = id.indexOf(":");
  if (separator < 0) return undefined;
  const key = id.slice(0, separator);
  const verb = id.slice(separator + 1);
  const verbs = Object.entries(handlers).find(
    ([candidate]) => candidate === key,
  )?.[1];
  const handler = verbs
    ? Object.entries(verbs).find(([candidate]) => candidate === verb)?.[1]
    : undefined;
  // SAFETY: the server derives each action's scope from the same
  // declaration, so the wire target matches the handler's declared scope.
  return handler as ComponentType<WorkActionProps> | undefined;
}
