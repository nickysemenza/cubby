import type { Entity } from "@cubby/schemas/entity";
import type { ProblemKey } from "@cubby/schemas/problems";

/**
 * A dependency-light description of how a Problem gets its population.
 *
 * This is deliberately data, not a query builder.  Entity sources reuse the
 * list module's filter vocabulary; derived sources name an adapter which owns
 * its SQL/graph/enrichment implementation.  That keeps the Problems surface
 * honest about a result's grain without turning this registry into a second
 * database DSL.
 */
export type FilterAssembly = readonly {
  id: string;
  value: string | string[];
}[];

type ProblemOperation = {
  label: string;
  detail?: string;
};

type ProblemGrain =
  | "group"
  | "pair"
  | "edge"
  | "polymorphic"
  | "aggregate"
  | "proposal";

export type DiagnosticKey =
  | "import-findings"
  | "duplicate-product-identities"
  | "orphaned-products"
  | "partially-imported-cookbooks"
  | "tools-used-outside-ownership"
  | "entities-missing-embeddings"
  | "stale-parent-recipes"
  | "manufacturer-spelling-variants"
  | "weight-sold-products"
  | "duplicate-vendors"
  | "referential-liveness-violations"
  | "dependency-cycles"
  | "products-with-better-upc-data"
  | "duplicate-spend-candidates"
  | "duplicate-financial-transaction-source-refs"
  | "duplicate-financial-account-source-aliases"
  | "invalid-financial-json"
  | "incomplete-statement-imports"
  | "title-derivable-unit-size"
  | "project-date-window-drift";

export type EntityProblemSource = {
  kind: "entity";
  entity: Entity;
  filters: FilterAssembly;
  sort?: readonly { id: string; desc: boolean }[];
  columnVisibility?: Readonly<Record<string, boolean>>;
};

type DerivedProblemSource = {
  kind: "derived";
  diagnostic: DiagnosticKey;
  grain: ProblemGrain;
  inputs?: readonly {
    entity: Entity;
    filters: FilterAssembly;
  }[];
  operations: readonly ProblemOperation[];
};

export type ProblemSource = EntityProblemSource | DerivedProblemSource;

export type ProblemExecutionLane =
  | "fast"
  | "views"
  | "coverage"
  | "upc"
  | "tracker";

type ProblemContinuation =
  | { kind: "entity-list" }
  | { kind: "none"; reason: string };

export type ProblemFreshness =
  | { kind: "live" }
  | { kind: "projection"; label: string }
  | { kind: "external"; provider: string };

/**
 * A remediation the Problems UI actually exposes. These describe capability,
 * not membership: changing a button must never change the canonical query.
 */
export type ProblemAction = {
  id: string;
  label: string;
  scope: "item" | "bulk";
  /**
   * Bulk actions either re-run this Problem's registered entity query, or are
   * deliberately global maintenance/backfill jobs. The latter must never be
   * labelled as acting on the card's count.
   */
  target: "item" | "canonical-query" | "global-backfill" | "guided-flow";
  destructive?: boolean;
};

type ProblemPresenter = {
  /** Registered presenter adapter; defaults to the Problem key. */
  key: ProblemKey;
  detailRouting: "entity" | "diagnostic";
};

export interface ProblemQuery {
  key: ProblemKey;
  problemClass: "defect" | "coverage";
  executionLane: ProblemExecutionLane;
  continuation: ProblemContinuation;
  title: string;
  description: string;
  emptyMessage: string;
  source: ProblemSource;
  /** Empty means the diagnostic is intentionally read-only. */
  actions: readonly ProblemAction[];
  freshness: ProblemFreshness;
  presenter: ProblemPresenter;
}

type ProblemDefinitionInput = Omit<ProblemQuery, "actions" | "presenter"> & {
  actions?: readonly ProblemAction[];
  presenter?: ProblemPresenter;
};

/**
 * The seam for Problem declarations.  It intentionally does validation that
 * is possible without importing React, a router, or a database.  Adapter and
 * filter-schema validation live beside their respective implementations.
 */
export const defineProblem = <T extends ProblemDefinitionInput>(
  definition: T,
): T & Pick<ProblemQuery, "actions" | "presenter"> => {
  if (
    definition.source.kind === "entity" &&
    definition.source.filters == null
  ) {
    throw new Error(`Entity problem "${definition.key}" must declare filters`);
  }
  if (
    definition.source.kind === "derived" &&
    definition.source.operations.length === 0
  ) {
    throw new Error(
      `Derived problem "${definition.key}" must describe its operation`,
    );
  }
  return {
    ...definition,
    actions: definition.actions ?? [],
    presenter: definition.presenter ?? {
      key: definition.key,
      detailRouting:
        definition.source.kind === "entity" ? "entity" : "diagnostic",
    },
  };
};

/** Fail early when a registry accidentally declares a Problem twice. */
export const validateProblemQueries = (
  definitions: readonly ProblemQuery[],
  expectedKeys?: readonly ProblemKey[],
): void => {
  const seen = new Set<ProblemKey>();
  for (const definition of definitions) {
    if (seen.has(definition.key)) {
      throw new Error(`Duplicate Problem declaration "${definition.key}"`);
    }
    seen.add(definition.key);
  }
  if (expectedKeys) {
    const missing = expectedKeys.filter((key) => !seen.has(key));
    const unexpected = [...seen].filter((key) => !expectedKeys.includes(key));
    if (missing.length || unexpected.length) {
      throw new Error(
        `Problem registry mismatch: missing [${missing.join(", ")}], unexpected [${unexpected.join(", ")}]`,
      );
    }
  }
};
