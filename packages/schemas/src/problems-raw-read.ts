/** Repository detector DTOs retain calculation evidence; operations own public serialization. */
import { z } from "zod";
import * as publicProblems from "./problems";
export * from "./problems";
export { rawProductWithoutMappingsSchema as productWithoutMappingsSchema } from "./problems";
export { rawIngredientWithPartialCoverageSchema as ingredientWithPartialCoverageSchema } from "./problems";
export { rawProductWithIslandedMappingsSchema as productWithIslandedMappingsSchema } from "./problems";

export const problemDetectors = publicProblems.rawProblemDetectors;
export type ProblemItem<K extends publicProblems.ProblemKey> = z.infer<
  (typeof problemDetectors)[K]["item"]
>;
const problemsFastSchema = publicProblems.problemsFastSchema.extend({
  orphanedProducts: z.array(problemDetectors.orphanedProducts.item),
  weightSoldProducts: z.array(problemDetectors.weightSoldProducts.item),
  toolsUsedOutsideOwnership: z.array(
    problemDetectors.toolsUsedOutsideOwnership.item,
  ),
  partiallyImportedCookbooks: z.array(
    problemDetectors.partiallyImportedCookbooks.item,
  ),
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
