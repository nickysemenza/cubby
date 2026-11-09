/** Repository detector DTOs retain calculation evidence; operations own public serialization. */
import { z } from "zod";
import * as publicProblems from "./problems";
export * from "./problems";
export { rawDuplicateUniqueProductSchema as duplicateUniqueProductSchema } from "./problems";
export { rawOrphanedProductSchema as orphanedProductSchema } from "./problems";
export { rawWeightSoldProductSchema as weightSoldProductSchema } from "./problems";
export { rawToolUsedOutsideOwnershipSchema as toolUsedOutsideOwnershipSchema } from "./problems";
export { rawProductWithoutMappingsSchema as productWithoutMappingsSchema } from "./problems";
export { rawProductWithTitleDerivableSizeSchema as productWithTitleDerivableSizeSchema } from "./problems";
export { rawIngredientWithPartialCoverageSchema as ingredientWithPartialCoverageSchema } from "./problems";
export { rawProductWithIslandedMappingsSchema as productWithIslandedMappingsSchema } from "./problems";
export { rawProductWithBetterUpcDataSchema as productWithBetterUpcDataSchema } from "./problems";
export { rawPartiallyImportedCookbookSchema as partiallyImportedCookbookSchema } from "./problems";
export { rawVendorWithoutLogoSchema as vendorWithoutLogoSchema } from "./problems";
export { rawEmptyLocationSchema as emptyLocationSchema } from "./problems";
export { rawPurchaseNotReconcilingSchema as purchaseNotReconcilingSchema } from "./problems";
export { rawPurchaseFinancialSettlementMismatchSchema as purchaseFinancialSettlementMismatchSchema } from "./problems";
export { rawDuplicateSpendCandidateSchema as duplicateSpendCandidateSchema } from "./problems";

export const problemDetectors = publicProblems.rawProblemDetectors;
export type ProblemItem<K extends publicProblems.ProblemKey> = z.infer<
  (typeof problemDetectors)[K]["item"]
>;
export const problemsFastSchema = publicProblems.problemsFastSchema.extend({
  orphanedProducts: z.array(problemDetectors.orphanedProducts.item),
  weightSoldProducts: z.array(problemDetectors.weightSoldProducts.item),
  toolsUsedOutsideOwnership: z.array(
    problemDetectors.toolsUsedOutsideOwnership.item,
  ),
  partiallyImportedCookbooks: z.array(
    problemDetectors.partiallyImportedCookbooks.item,
  ),
  vendorsWithoutLogos: z.array(problemDetectors.vendorsWithoutLogos.item),
  purchasesNotReconciling: z.array(
    problemDetectors.purchasesNotReconciling.item,
  ),
  purchaseFinancialSettlementMismatches: z.array(
    problemDetectors.purchaseFinancialSettlementMismatches.item,
  ),
  duplicateSpendCandidates: z.array(
    problemDetectors.duplicateSpendCandidates.item,
  ),
});
export type ProblemsFast = z.infer<typeof problemsFastSchema>;
export const problemsCoverageSchema =
  publicProblems.problemsCoverageSchema.extend({
    productsWithTitleDerivableSize: z.array(
      problemDetectors.productsWithTitleDerivableSize.item,
    ),
    ingredientsWithPartialCoverage: z.array(
      problemDetectors.ingredientsWithPartialCoverage.item,
    ),
    productsWithIslandedMappings: z.array(
      problemDetectors.productsWithIslandedMappings.item,
    ),
  });
export type ProblemsCoverage = z.infer<typeof problemsCoverageSchema>;
export const problemsUpcSchema = publicProblems.problemsUpcSchema.extend({
  productsWithBetterUpcData: z.array(
    problemDetectors.productsWithBetterUpcData.item,
  ),
});
export type ProblemsUpc = z.infer<typeof problemsUpcSchema>;
export const problemsViewsSchema = publicProblems.problemsViewsSchema.extend({
  productsWithoutMappings: z.array(
    problemDetectors.productsWithoutMappings.item,
  ),
  emptyLocations: z.array(problemDetectors.emptyLocations.item),
});
export type ProblemsViewsOut = z.infer<typeof problemsViewsSchema>;
export const problemsTrackerSchema =
  publicProblems.problemsTrackerSchema.extend({});
export type ProblemsTracker = z.infer<typeof problemsTrackerSchema>;
export const allProblemsSchema = publicProblems.allProblemsSchema.extend({
  orphanedProducts: z.array(problemDetectors.orphanedProducts.item),
  weightSoldProducts: z.array(problemDetectors.weightSoldProducts.item),
  toolsUsedOutsideOwnership: z.array(
    problemDetectors.toolsUsedOutsideOwnership.item,
  ),
  productsWithoutMappings: z.array(
    problemDetectors.productsWithoutMappings.item,
  ),
  productsWithTitleDerivableSize: z.array(
    problemDetectors.productsWithTitleDerivableSize.item,
  ),
  ingredientsWithPartialCoverage: z.array(
    problemDetectors.ingredientsWithPartialCoverage.item,
  ),
  productsWithIslandedMappings: z.array(
    problemDetectors.productsWithIslandedMappings.item,
  ),
  productsWithBetterUpcData: z.array(
    problemDetectors.productsWithBetterUpcData.item,
  ),
  partiallyImportedCookbooks: z.array(
    problemDetectors.partiallyImportedCookbooks.item,
  ),
  vendorsWithoutLogos: z.array(problemDetectors.vendorsWithoutLogos.item),
  emptyLocations: z.array(problemDetectors.emptyLocations.item),
  purchasesNotReconciling: z.array(
    problemDetectors.purchasesNotReconciling.item,
  ),
  purchaseFinancialSettlementMismatches: z.array(
    problemDetectors.purchaseFinancialSettlementMismatches.item,
  ),
  duplicateSpendCandidates: z.array(
    problemDetectors.duplicateSpendCandidates.item,
  ),
});
export type AllProblems = z.infer<typeof allProblemsSchema>;
