import { describe, expect, it } from "vitest";
import {
  EMPTY_PROBLEM_ARRAYS,
  PROBLEM_CLASS,
  type ProblemClass,
} from "./problems";

/**
 * `PROBLEM_CLASS` decides which detectors reach `totalProblems` and the navbar
 * badge, so it is pinned BY VALUE rather than spot-checked. `satisfies` already
 * makes a newly-added detector a compile error until it is classed — what it
 * cannot check is that the class chosen is the RIGHT one, and the failure mode
 * is quiet: a new detector classed `defect` by copy-paste turns the badge
 * permanently red, and one classed `coverage` by mistake silently stops
 * counting real defects.
 *
 * This replaces a scattering of `expect(PROBLEM_CLASS.x).toBe("defect")` lines
 * in `problems.integration.test.ts` — four of which were standalone `it` blocks
 * paying a real-Postgres `withTestDb()` reset to read one compile-time
 * constant. Pinning the whole map is strictly stronger: it catches the new
 * detector nobody wrote an assertion for.
 */
describe("PROBLEM_CLASS", () => {
  const EXPECTED = {
    blockedWorkProjects: "defect",
    duplicateFinancialAccountSourceAliases: "defect",
    duplicateFinancialTransactionSourceRefs: "defect",
    duplicateInventory: "defect",
    duplicateProductIdentities: "defect",
    duplicateVendors: "defect",
    dependencyCycles: "defect",
    entitiesMissingEmbeddings: "defect",
    financialTransactionAllocationDefects: "defect",
    importFindings: "defect",
    incompleteStatementImports: "defect",
    ingredientsWithPartialCoverage: "defect",
    inventoryWithoutPricePath: "defect",
    invalidFinancialJson: "defect",
    locationsWithoutAiDescription: "defect",
    manufacturerSpellingVariants: "defect",
    orphanedProducts: "defect",
    partiallyImportedCookbooks: "defect",
    overdueTasks: "defect",
    pastDuePlannedExpenses: "defect",
    productsMissingPrice: "defect",
    productsWithBetterUpcData: "defect",
    productsWithIslandedMappings: "defect",
    productsWithTitleDerivableSize: "coverage",
    productsWithoutMappings: "defect",
    projectsMissingBudget: "defect",
    projectsWithDateDrift: "defect",
    referentialLivenessViolations: "defect",
    soldButStillStocked: "defect",
    kitsCountedTwice: "defect",
    staleParentRecipes: "defect",
    stalledProjects: "defect",
    toolsUsedOutsideOwnership: "defect",
    unclassifiedExpenses: "defect",
    understatedCostMeals: "defect",
    unknownParkedItems: "defect",
    unusedIngredientsWithProduct: "defect",
    unusedIngredientsWithoutProduct: "defect",

    duplicateSpendCandidates: "coverage",
    emptyLocations: "coverage",
    ingredientsWithoutProduct: "coverage",
    negativeExpectedQuantity: "coverage",
    neverVerifiedInventory: "coverage",
    productsWithNoImages: "coverage",
    imageProcessingIssues: "coverage",
    purchaseFinancialSettlementMismatches: "coverage",
    purchaselessExitExpenses: "coverage",
    purchasesNotReconciling: "coverage",
    staleLocations: "coverage",
    unvaluedBucketProducts: "coverage",
    unlinkedExitExpenses: "coverage",
    vendorsWithoutLogos: "coverage",
    weightSoldProducts: "coverage",
  } satisfies Record<keyof typeof PROBLEM_CLASS, ProblemClass>;

  it("classes every detector exactly as pinned here", () => {
    expect(PROBLEM_CLASS).toEqual(EXPECTED);
  });

  // `PROBLEM_CLASS` is `satisfies Record<ProblemKey, ProblemClass>`, so an
  // unclassed detector is already a type error. This is the runtime half: the
  // pinned table above must not drift out of the key roster either, or a
  // detector could be renamed and silently lose its pin.
  it("covers the whole detector roster", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(
      Object.keys(EMPTY_PROBLEM_ARRAYS).sort(),
    );
  });
});
