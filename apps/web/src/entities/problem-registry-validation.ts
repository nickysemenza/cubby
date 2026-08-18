import type { Entity } from "@cubby/schemas/entity";
import { withProblemActionCapabilities } from "./problem-actions";
import { compileProblemFilters } from "./problem-filter-semantics";
import type { DiagnosticKey, ProblemQuery } from "./problem-query";
import { validateProblemQueries } from "./problem-query";
import {
  expectedProblemKeys,
  problemQueryDeclarations,
} from "./problem-registry";
import { getSortableFields } from "./sortable-fields";

type RuntimeCapabilities = {
  listEntities?: ReadonlySet<Entity>;
  diagnostics?: ReadonlySet<DiagnosticKey>;
};

/**
 * Action capabilities describe server-enforced remediation scope, not the
 * browser-visible query assembly. Keep them on the server validation path so
 * a list page does not download labels and destructive-action contracts it
 * cannot render or invoke.
 */
export const completeProblemQueryDeclarations = (
  definitions: readonly ProblemQuery[] = problemQueryDeclarations(),
): readonly ProblemQuery[] => withProblemActionCapabilities(definitions);

const validateRegistryContracts = (
  definitions: readonly ProblemQuery[],
  capabilities: RuntimeCapabilities,
): void => {
  for (const definition of definitions) {
    if (definition.source.kind === "entity") {
      if (definition.continuation.kind !== "entity-list") {
        throw new Error(
          `Entity Problem "${definition.key}" must continue to its entity list`,
        );
      }
      if (
        capabilities.listEntities &&
        !capabilities.listEntities.has(definition.source.entity)
      ) {
        throw new Error(
          `Entity Problem "${definition.key}" has no ${definition.source.entity} list adapter`,
        );
      }
      compileProblemFilters(
        definition.source.entity,
        definition.source.filters,
      );
      const legalSorts = new Set(getSortableFields(definition.source.entity));
      const illegalSort = definition.source.sort?.find(
        ({ id }) => !legalSorts.has(id),
      );
      if (illegalSort) {
        throw new Error(
          `Problem "${definition.key}" uses illegal ${definition.source.entity} sort "${illegalSort.id}"`,
        );
      }
    } else {
      if (definition.continuation.kind !== "none") {
        throw new Error(
          `Derived Problem "${definition.key}" cannot claim an entity-list continuation`,
        );
      }
      if (
        capabilities.diagnostics &&
        !capabilities.diagnostics.has(definition.source.diagnostic)
      ) {
        throw new Error(
          `Derived Problem "${definition.key}" has no ${definition.source.diagnostic} diagnostic adapter`,
        );
      }
      for (const input of definition.source.inputs ?? []) {
        compileProblemFilters(input.entity, input.filters);
      }
    }
    if (
      definition.actions.some(
        (action) =>
          action.target === "canonical-query" &&
          definition.source.kind !== "entity",
      )
    ) {
      throw new Error(
        `Derived Problem "${definition.key}" cannot target a canonical entity query`,
      );
    }
  }
};

/**
 * Server/startup validator for contracts that require repository adapters.
 * Keeping this boundary out of the UI metadata registry prevents list routes
 * from downloading server-only filter compilers and sortable-field catalogs.
 */
export const validateCompleteProblemRegistry = (
  definitions: readonly ProblemQuery[] = problemQueryDeclarations(),
  capabilities: RuntimeCapabilities = {},
): void => {
  const completeDefinitions = completeProblemQueryDeclarations(definitions);
  validateProblemQueries(completeDefinitions, expectedProblemKeys);
  validateRegistryContracts(completeDefinitions, capabilities);
};
