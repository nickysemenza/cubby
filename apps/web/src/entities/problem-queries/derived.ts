import { PROBLEM_CLASS } from "@cubby/schemas/problems";
import { defineProblem, type ProblemQuery } from "~/entities/problem-query";

/**
 * Diagnostics whose result grain is not an entity-list row.
 *
 * The diagnostic key is the adapter seam: SQL, graph traversal, and provider
 * work stay with their existing detector. This file declares only the public
 * assembly and continuation contract.
 */
export const derivedProblemQueries = [
  defineProblem({
    key: "duplicateProductIdentities",
    problemClass: PROBLEM_CLASS.duplicateProductIdentities,
    executionLane: "fast",
    continuation: {
      kind: "none",
      reason: "Each result is an identity cluster, not one product.",
    },
    freshness: { kind: "live" },
    title: "Duplicate product identities",
    description:
      "Products whose normalized identity values resolve to the same cluster.",
    emptyMessage: "No duplicate product identity clusters remain.",
    source: {
      kind: "derived",
      diagnostic: "duplicate-product-identities",
      grain: "group",
      inputs: [{ entity: "product", filters: [] }],
      operations: [
        { label: "Normalize product identity values" },
        { label: "Group equal values" },
        { label: "Keep groups of 2+ products" },
      ],
    },
  }),
  defineProblem({
    key: "orphanedProducts",
    problemClass: PROBLEM_CLASS.orphanedProducts,
    executionLane: "fast",
    continuation: {
      kind: "none",
      reason: "The diagnostic evaluates the product relationship graph.",
    },
    freshness: { kind: "live" },
    title: "Orphaned products",
    description:
      "Products whose live relationship graph no longer gives them a valid household role.",
    emptyMessage: "No orphaned products remain.",
    source: {
      kind: "derived",
      diagnostic: "orphaned-products",
      grain: "edge",
      inputs: [{ entity: "product", filters: [] }],
      operations: [
        { label: "Load live product ownership edges" },
        { label: "Keep products with no retaining role" },
      ],
    },
  }),
  defineProblem({
    key: "toolsUsedOutsideOwnership",
    problemClass: PROBLEM_CLASS.toolsUsedOutsideOwnership,
    executionLane: "fast",
    continuation: {
      kind: "none",
      reason: "Each result compares a polymorphic use edge to ownership.",
    },
    freshness: { kind: "live" },
    title: "Tools used outside ownership",
    description:
      "Tool-use edges that fall outside their product's ownership history.",
    emptyMessage: "Every tool use is within ownership.",
    source: {
      kind: "derived",
      diagnostic: "tools-used-outside-ownership",
      grain: "edge",
      inputs: [
        { entity: "product", filters: [] },
        { entity: "project", filters: [] },
      ],
      operations: [
        { label: "Join tool-use edges to ownership windows" },
        { label: "Keep uses outside the owning interval" },
      ],
    },
  }),
  defineProblem({
    key: "orphanedEntityEmbeddings",
    problemClass: PROBLEM_CLASS.orphanedEntityEmbeddings,
    executionLane: "fast",
    continuation: {
      kind: "none",
      reason: "Embedding rows are polymorphic and do not have one list route.",
    },
    freshness: { kind: "live" },
    title: "Orphaned entity embeddings",
    description: "Embeddings whose indexed entity has been removed.",
    emptyMessage: "Every embedding has a live entity.",
    source: {
      kind: "derived",
      diagnostic: "orphaned-entity-embeddings",
      grain: "polymorphic",
      operations: [
        { label: "Resolve each embedding's typed entity reference" },
        { label: "Keep missing targets" },
      ],
    },
  }),
  defineProblem({
    key: "entitiesMissingEmbeddings",
    problemClass: PROBLEM_CLASS.entitiesMissingEmbeddings,
    executionLane: "fast",
    continuation: {
      kind: "none",
      reason: "The exact result is a union across searchable entity types.",
    },
    freshness: { kind: "live" },
    title: "Entities missing embeddings",
    description: "Searchable live entities not present in the embedding index.",
    emptyMessage: "Every searchable entity is embedded.",
    source: {
      kind: "derived",
      diagnostic: "entities-missing-embeddings",
      grain: "polymorphic",
      operations: [
        { label: "Union all searchable live entity types" },
        { label: "Exclude entities with a current embedding" },
      ],
    },
  }),
  defineProblem({
    key: "staleParentRecipes",
    problemClass: PROBLEM_CLASS.staleParentRecipes,
    executionLane: "fast",
    continuation: {
      kind: "none",
      reason: "A result is a parent-child recipe dependency edge.",
    },
    freshness: { kind: "live" },
    title: "Stale parent recipes",
    description:
      "Parent recipe costs that have not incorporated changed child recipes.",
    emptyMessage: "All parent recipe costs are current.",
    source: {
      kind: "derived",
      diagnostic: "stale-parent-recipes",
      grain: "edge",
      inputs: [{ entity: "recipe", filters: [] }],
      operations: [
        { label: "Traverse parent recipe dependencies" },
        { label: "Keep parents older than a live child" },
      ],
    },
  }),
  defineProblem({
    key: "manufacturerSpellingVariants",
    problemClass: PROBLEM_CLASS.manufacturerSpellingVariants,
    executionLane: "fast",
    continuation: {
      kind: "none",
      reason: "Each result is a normalized manufacturer-name group.",
    },
    freshness: { kind: "live" },
    title: "Manufacturer spelling variants",
    description: "Manufacturer labels that differ only after normalization.",
    emptyMessage: "No manufacturer spelling variants remain.",
    source: {
      kind: "derived",
      diagnostic: "manufacturer-spelling-variants",
      grain: "group",
      inputs: [{ entity: "product", filters: [] }],
      operations: [
        { label: "Normalize manufacturer labels" },
        { label: "Group equal normalized values" },
        { label: "Keep groups of 2+ spellings" },
      ],
    },
  }),
  defineProblem({
    key: "duplicateVendors",
    problemClass: PROBLEM_CLASS.duplicateVendors,
    executionLane: "fast",
    continuation: {
      kind: "none",
      reason: "Each result is a vendor-name cluster.",
    },
    freshness: { kind: "live" },
    title: "Duplicate vendors",
    description: "Vendor roster entries with the same normalized name.",
    emptyMessage: "No duplicate vendor clusters remain.",
    source: {
      kind: "derived",
      diagnostic: "duplicate-vendors",
      grain: "group",
      inputs: [{ entity: "vendor", filters: [] }],
      operations: [
        { label: "Normalize vendor names" },
        { label: "Group equal values" },
        { label: "Keep groups of 2+ vendors" },
      ],
    },
  }),
  defineProblem({
    key: "referentialLivenessViolations",
    problemClass: PROBLEM_CLASS.referentialLivenessViolations,
    executionLane: "fast",
    continuation: {
      kind: "none",
      reason: "Each result is an incoming relationship edge.",
    },
    freshness: { kind: "live" },
    title: "Referential liveness violations",
    description:
      "Live rows whose incoming relation points to a soft-deleted target.",
    emptyMessage: "All live references point to live targets.",
    source: {
      kind: "derived",
      diagnostic: "referential-liveness-violations",
      grain: "edge",
      operations: [
        { label: "Enumerate every audited incoming edge" },
        { label: "Keep live sources with removed targets" },
      ],
    },
  }),
  defineProblem({
    key: "productsWithBetterUpcData",
    problemClass: PROBLEM_CLASS.productsWithBetterUpcData,
    executionLane: "upc",
    continuation: {
      kind: "none",
      reason: "External UPC matches are advisory proposals, not product rows.",
    },
    freshness: { kind: "external", provider: "UPC provider cache" },
    title: "Products with better UPC data",
    description:
      "Cached external UPC proposals that improve a product's current identifiers.",
    emptyMessage: "No better UPC proposals are available.",
    source: {
      kind: "derived",
      diagnostic: "products-with-better-upc-data",
      grain: "proposal",
      inputs: [{ entity: "product", filters: [] }],
      operations: [
        { label: "Read cached UPC enrichment proposals" },
        { label: "Rank improvements over current identifiers" },
      ],
    },
  }),
  defineProblem({
    key: "duplicateSpendCandidates",
    problemClass: PROBLEM_CLASS.duplicateSpendCandidates,
    executionLane: "fast",
    continuation: {
      kind: "none",
      reason: "Each result is a candidate pair, not one expense.",
    },
    freshness: { kind: "live" },
    title: "Possible duplicate spend",
    description:
      "Expense pairs whose date, amount, and context suggest a manual review.",
    emptyMessage: "No duplicate-spend candidates remain.",
    source: {
      kind: "derived",
      diagnostic: "duplicate-spend-candidates",
      grain: "pair",
      inputs: [{ entity: "expense", filters: [] }],
      operations: [
        { label: "Compare compatible expense pairs" },
        { label: "Rank likely duplicates" },
      ],
    },
  }),
  defineProblem({
    key: "duplicateFinancialTransactionSourceRefs",
    problemClass: PROBLEM_CLASS.duplicateFinancialTransactionSourceRefs,
    executionLane: "fast",
    continuation: {
      kind: "none",
      reason: "Each result is a duplicate source-reference group.",
    },
    freshness: { kind: "live" },
    title: "Duplicate financial transaction source references",
    description:
      "Financial transactions sharing a normalized provider source reference.",
    emptyMessage: "No duplicate transaction source references remain.",
    source: {
      kind: "derived",
      diagnostic: "duplicate-financial-transaction-source-refs",
      grain: "group",
      inputs: [{ entity: "financialTransaction", filters: [] }],
      operations: [
        { label: "Normalize transaction source references" },
        { label: "Group repeated references" },
      ],
    },
  }),
  defineProblem({
    key: "duplicateFinancialAccountSourceAliases",
    problemClass: PROBLEM_CLASS.duplicateFinancialAccountSourceAliases,
    executionLane: "fast",
    continuation: {
      kind: "none",
      reason: "Each result is a duplicate account-alias group.",
    },
    freshness: { kind: "live" },
    title: "Duplicate financial account source aliases",
    description:
      "Financial accounts sharing a normalized external source alias.",
    emptyMessage: "No duplicate account source aliases remain.",
    source: {
      kind: "derived",
      diagnostic: "duplicate-financial-account-source-aliases",
      grain: "group",
      inputs: [{ entity: "financialAccount", filters: [] }],
      operations: [
        { label: "Normalize account source aliases" },
        { label: "Group repeated aliases" },
      ],
    },
  }),
  defineProblem({
    key: "invalidFinancialJson",
    problemClass: PROBLEM_CLASS.invalidFinancialJson,
    executionLane: "fast",
    continuation: {
      kind: "none",
      reason: "Results may be financial accounts or transactions.",
    },
    freshness: { kind: "live" },
    title: "Invalid financial JSON",
    description:
      "Structured provider identity data that no longer matches its schema.",
    emptyMessage: "All financial provider data is valid.",
    source: {
      kind: "derived",
      diagnostic: "invalid-financial-json",
      grain: "polymorphic",
      operations: [
        { label: "Validate financial account and transaction JSON fields" },
        { label: "Keep invalid values with their structured reason" },
      ],
    },
  }),
  defineProblem({
    key: "incompleteStatementImports",
    problemClass: PROBLEM_CLASS.incompleteStatementImports,
    executionLane: "fast",
    continuation: {
      kind: "none",
      reason: "Each result is an import aggregate, not a transaction row.",
    },
    freshness: { kind: "live" },
    title: "Incomplete statement imports",
    description:
      "Statement imports whose stored transaction count is below the declared row count.",
    emptyMessage: "Every statement import is complete.",
    source: {
      kind: "derived",
      diagnostic: "incomplete-statement-imports",
      grain: "aggregate",
      operations: [
        { label: "Count stored rows per statement import" },
        { label: "Keep imports below their declared row count" },
      ],
    },
  }),
] as const satisfies readonly ProblemQuery[];
