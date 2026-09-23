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
    key: "importFindings",
    problemClass: PROBLEM_CLASS.importFindings,
    executionLane: "fast",
    continuation: {
      kind: "none",
      reason: "Each result is a durable import review finding.",
    },
    freshness: { kind: "live" },
    title: "Purchase imports needing review",
    description:
      "Import decisions that require a person before Cubby changes more data.",
    emptyMessage: "No purchase import needs review.",
    source: {
      kind: "derived",
      diagnostic: "import-findings",
      grain: "proposal",
      inputs: [{ entity: "purchase", filters: [] }],
      operations: [
        { label: "Load open import findings" },
        { label: "Preserve proposed fixes for explicit review" },
      ],
    },
  }),
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
    emptyMessage: "Each manufacturer part number belongs to one product.",
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
      "Products that aren't stocked anywhere, aren't on a purchase, and aren't used by a recipe or project — nothing in the house refers to them any more.",
    emptyMessage: "Every product is stocked, bought, or used by something.",
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
    key: "unconnectedEntities",
    problemClass: PROBLEM_CLASS.unconnectedEntities,
    executionLane: "fast",
    continuation: {
      kind: "none",
      reason:
        "Each result is a record of a checked kind, not a single entity type's grid.",
    },
    freshness: { kind: "live" },
    title: "Unconnected records",
    description:
      "Locations, vendors, ingredients, cookbooks, plants, and images with no physical connection to anything else in the house.",
    emptyMessage: "Every checked record connects to something.",
    source: {
      kind: "derived",
      diagnostic: "unconnected-entities",
      grain: "polymorphic",
      operations: [
        { label: "Load the live one-hop physical edge source" },
        {
          label: "Keep checked-kind records with no incoming or outgoing edge",
        },
      ],
    },
  }),
  defineProblem({
    key: "partiallyImportedCookbooks",
    problemClass: PROBLEM_CLASS.partiallyImportedCookbooks,
    executionLane: "fast",
    continuation: {
      kind: "none",
      reason:
        "Each result compares a cookbook's retained source extraction with its live imported recipes.",
    },
    freshness: { kind: "live" },
    title: "Partially imported cookbooks",
    description:
      "Cookbooks whose retained source has more recipes than are currently imported.",
    emptyMessage: "Every cookbook's retained source is fully imported.",
    source: {
      kind: "derived",
      diagnostic: "partially-imported-cookbooks",
      grain: "aggregate",
      inputs: [{ entity: "cookbook", filters: [] }],
      operations: [
        { label: "Count retained source recipes" },
        { label: "Count live imported recipes" },
        { label: "Keep cookbooks with missing imports" },
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
    key: "entitiesMissingEmbeddings",
    problemClass: PROBLEM_CLASS.entitiesMissingEmbeddings,
    executionLane: "fast",
    continuation: {
      kind: "none",
      reason: "The exact result is a union across embeddable entity types.",
    },
    freshness: { kind: "live" },
    title: "Entities missing embeddings",
    description:
      "Records that search can't find yet, because they haven't been indexed under the current model.",
    emptyMessage: "Every embeddable entity is embedded.",
    source: {
      kind: "derived",
      diagnostic: "entities-missing-embeddings",
      grain: "polymorphic",
      operations: [
        { label: "Union all embeddable live entity types" },
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
    title: "Recipes built on a deleted sub-recipe",
    description:
      "A recipe still lists a sub-recipe that has been deleted, so its cost and ingredient list are quietly missing that part.",
    emptyMessage: "Every sub-recipe a recipe references still exists.",
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
    key: "weightSoldProducts",
    problemClass: PROBLEM_CLASS.weightSoldProducts,
    executionLane: "fast",
    continuation: {
      kind: "none",
      reason: "A result aggregates a product's whole priced expense history.",
    },
    freshness: { kind: "live" },
    title: "Products priced by weight with no weight mapping",
    description:
      "Bought by the pound but recorded as a count, so the per-each price is an average of items that each weighed something different. Recipes measured in grams read no price at all through these.",
    emptyMessage: "Every weight-sold product has a weight-to-money mapping.",
    source: {
      kind: "derived",
      diagnostic: "weight-sold-products",
      grain: "edge",
      inputs: [{ entity: "product", filters: [] }],
      operations: [
        { label: "Group priced principal expense lines by product" },
        { label: "Keep a 2x or wider spread in unit cost" },
        { label: "Keep those whose prices rarely repeat" },
        { label: "Exclude products that already have a unit mapping" },
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
    description:
      "The same manufacturer spelled more than one way — different capitalisation, punctuation or spacing on what is one brand.",
    emptyMessage: "Each manufacturer is spelled one way.",
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
    description:
      "Two or more vendor records for what looks like one business, so its purchases and spend are split between them.",
    emptyMessage: "Each vendor has one record.",
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
      "A record still points at something that has been deleted. Whatever reads that link now sees nothing, silently.",
    emptyMessage: "Nothing points at a deleted record.",
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
    key: "dependencyCycles",
    problemClass: PROBLEM_CLASS.dependencyCycles,
    executionLane: "fast",
    continuation: {
      kind: "none",
      reason: "Each result is a cycle in a dependency graph.",
    },
    freshness: { kind: "live" },
    title: "Dependency cycles",
    description:
      "Project or task blocked-by links form a cycle, so no member can be first.",
    emptyMessage: "Project and task dependencies are acyclic.",
    source: {
      kind: "derived",
      diagnostic: "dependency-cycles",
      grain: "group",
      operations: [
        { label: "Load Project and Task dependency graphs" },
        { label: "Find cyclic strongly-connected components" },
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
    emptyMessage: "No unlinked expense looks like a purchase already recorded.",
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
      "One bank or card reference claimed by several transactions — the same charge imported twice, which double-counts it against a purchase.",
    emptyMessage: "Each provider reference belongs to one transaction.",
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
      "One provider account id claimed by several accounts, so imported rows can land on either of them.",
    emptyMessage: "Each provider account id belongs to one account.",
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
      "Stored bank identity or reference data that can no longer be read, so imports and settlement matching skip these records.",
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
    emptyMessage: "Every statement import stored every row it declared.",
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
