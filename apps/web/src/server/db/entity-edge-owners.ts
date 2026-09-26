/**
 * Which entity owns each non-entity row that carries an `ENTITY_EDGES` column,
 * so the physical edge graph (`repo/entity-edge-source.ts`) can name both
 * endpoints of an edge whose column sits on a join or child row.
 *
 * `ENTITY_EDGES` records only the referencing column. For an entity table that
 * column's row is the source; for anything else this map supplies the owner:
 *
 * - `owner`: a column on the same row naming the owning entity. The owner
 *   column itself produces no edge (it links the row to its own owner).
 * - `via`: the owner sits one hop away (a line's section names the recipe).
 * - `excluded`: workflow, history, or review rows whose columns are evidence
 *   about entities rather than relationships between them.
 *
 * `entity-edge-owners.unit.test.ts` fails when an `ENTITY_EDGES` table is
 * missing here, so a new join table must decide its owner explicitly.
 */

import type { AnyPgColumn } from "drizzle-orm/pg-core";

import {
  entityAttachment,
  expenseAttribution,
  financialTransactionAllocation,
  gardenEntryPlanting,
  imageDerivative,
  imageDescriptionCorrection,
  imageProcessingJob,
  runTarget,
  mealFoodEntry,
  mealRecipe,
  mealRecipePortion,
  photoGroupProposal,
  productComponent,
  productConversionCoverage,
  productExternalId,
  productUnitMappings,
  projectDependency,
  projectToolUsage,
  purchasePaymentEvidence,
  purchaseProduct,
  recipeSection,
  recipeSectionIngredient,
  statementRow,
  taskDependency,
  wishCandidate,
} from "./schema";

export type EntityEdgeOwner =
  | { owner: AnyPgColumn }
  | {
      /** Joined on `via.table.id = <row>.<via.column>`. */
      via: {
        column: AnyPgColumn;
        table: { id: AnyPgColumn };
        owner: AnyPgColumn;
      };
    }
  /**
   * The owner's kind is not fixed by the table: `EntityAttachment` names any
   * entity, so its kind is read from `Entity`.
   */
  | { ownerIdentity: AnyPgColumn }
  | { excluded: string };

const WORKFLOW =
  "Workflow evidence about entities, not a relationship between them.";

export const ENTITY_EDGE_OWNERS = {
  EntityAttachment: { ownerIdentity: entityAttachment.subjectEntityId },
  ExpenseAttribution: { owner: expenseAttribution.expenseId },
  FinancialTransactionAllocation: {
    owner: financialTransactionAllocation.transactionId,
  },
  GardenEntryPlanting: { owner: gardenEntryPlanting.gardenEntryId },
  MealFoodEntry: { owner: mealFoodEntry.mealId },
  MealRecipe: { owner: mealRecipe.mealId },
  MealRecipePortion: { owner: mealRecipePortion.mealId },
  ProductComponent: { owner: productComponent.parentProductId },
  ProductConversionCoverage: { owner: productConversionCoverage.productId },
  ProductExternalId: { owner: productExternalId.productId },
  ProductUnitMappings: { owner: productUnitMappings.productId },
  ProjectDependency: { owner: projectDependency.projectId },
  ProjectToolUsage: { owner: projectToolUsage.projectId },
  PurchasePaymentEvidence: { owner: purchasePaymentEvidence.purchaseId },
  PurchaseProduct: { owner: purchaseProduct.purchaseId },
  RecipeSection: { owner: recipeSection.recipeId },
  RecipeSectionIngredient: {
    via: {
      column: recipeSectionIngredient.recipeSectionId,
      table: recipeSection,
      owner: recipeSection.recipeId,
    },
  },
  StatementRow: { owner: statementRow.accountId },
  TaskDependency: { owner: taskDependency.taskId },
  WishCandidate: { owner: wishCandidate.wishId },
  // A run's target list is how a run relates to what it imported.
  RunTarget: { owner: runTarget.runId },
  PhotoGroupProposal: { owner: photoGroupProposal.runId },
  ImageDerivative: { owner: imageDerivative.imageId },
  ImageDescriptionCorrection: { owner: imageDescriptionCorrection.imageId },
  ImageProcessingJob: { owner: imageProcessingJob.imageId },
  AiUsage: { excluded: "Telemetry attribution." },
  AuditLog: { excluded: "History attribution." },
  RunFinding: { excluded: WORKFLOW },
  ImportHunt: { excluded: WORKFLOW },
  ImportPreparedOrder: { excluded: WORKFLOW },
  RunApproval: { excluded: WORKFLOW },
  RunControlEvent: { excluded: WORKFLOW },
  RunEvidence: { excluded: WORKFLOW },
  RunMutation: { excluded: WORKFLOW },
  RunOperation: { excluded: WORKFLOW },
  RunOrderCandidate: { excluded: WORKFLOW },
  RunProgress: { excluded: WORKFLOW },
  ImportSourceClaim: { excluded: WORKFLOW },
  LedgerSourceClaim: { excluded: WORKFLOW },
  MailboxCursor: { excluded: WORKFLOW },
  MerchantVendorRule: { excluded: WORKFLOW },
  OrderMail: { excluded: WORKFLOW },
  OrderMailAttachment: { excluded: WORKFLOW },
  ProductMatchCandidate: {
    excluded: "A review queue of possible duplicates, not a relationship.",
  },
} satisfies Record<string, EntityEdgeOwner>;
