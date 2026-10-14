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
  emailFinancialAssociation,
  entityAttachment,
  entityLink,
  expenseAttribution,
  financialTransactionAllocation,
  imageDerivative,
  imageProcessingAttempt,
  imageProcessingEvent,
  imageProcessingSubmissionJob,
  imageSighting,
  mealFoodEntry,
  mealRecipe,
  mealRecipePortion,
  photoGroupProposal,
  photoRunImage,
  productConversionCoverage,
  entityExternalId,
  productUnitMappings,
  purchasePaymentEvidence,
  recipeSection,
  recipeSectionIngredient,
  statementRow,
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
  /**
   * `EntityLink`: the owner is `fromEntityId`, whose kind the row's link kind
   * declares (`ENTITY_LINK_KINDS[kind].from`). The `.from` end of each kind is
   * the owner column; the `.to` end is the edge.
   */
  | { linkFrom: AnyPgColumn }
  | { excluded: string };

const WORKFLOW =
  "Workflow evidence about entities, not a relationship between them.";

export const ENTITY_EDGE_OWNERS = {
  EntityAttachment: { ownerIdentity: entityAttachment.entityId },
  EntityLink: { linkFrom: entityLink.fromEntityId },
  ExpenseAttribution: { owner: expenseAttribution.expenseId },
  FinancialTransactionAllocation: {
    owner: financialTransactionAllocation.transactionId,
  },
  MealFoodEntry: { owner: mealFoodEntry.mealId },
  MealRecipe: { owner: mealRecipe.mealId },
  MealRecipePortion: { owner: mealRecipePortion.mealId },
  ProductConversionCoverage: { owner: productConversionCoverage.productId },
  EntityExternalId: { ownerIdentity: entityExternalId.entityId },
  ProductUnitMapping: { owner: productUnitMappings.productId },
  PurchasePaymentEvidence: { owner: purchasePaymentEvidence.purchaseId },
  RecipeSection: { owner: recipeSection.recipeId },
  RecipeSectionIngredient: {
    via: {
      column: recipeSectionIngredient.recipeSectionId,
      table: recipeSection,
      owner: recipeSection.recipeId,
    },
  },
  StatementRow: { owner: statementRow.accountId },
  // A run's target list is how a run relates to what it imported.
  PhotoRunImage: { owner: photoRunImage.runId },
  PhotoGroupProposal: { owner: photoGroupProposal.runId },
  ImageDerivative: { owner: imageDerivative.imageId },
  // An Image job's attempts, events and submission memberships belong to the job.
  ImageProcessingAttempt: { owner: imageProcessingAttempt.jobId },
  ImageProcessingEvent: { owner: imageProcessingEvent.jobId },
  ImageProcessingSubmissionJob: { owner: imageProcessingSubmissionJob.jobId },
  ImageSighting: { owner: imageSighting.imageId },
  AiEvaluation: { excluded: "Durable inference and publication history." },
  AiEvaluationRequest: {
    excluded: "Per-Run work membership and publication receipts.",
  },
  AiUsage: { excluded: "Telemetry attribution." },
  ExternalSource: {
    excluded: "Registry metadata naming the vendor a source slug is.",
  },
  AuditLog: { excluded: "History attribution." },
  RunFinding: { excluded: WORKFLOW },
  AssessmentState: { excluded: WORKFLOW },
  ImportPreparedOrder: { excluded: WORKFLOW },
  SourceOrderObservation: { excluded: "Immutable source extraction history." },
  EmailCandidateObservation: { excluded: "Immutable Email candidate history." },
  EmailClassificationObservation: {
    excluded: "Immutable Email classification history.",
  },
  EmailRetrievalFailure: { excluded: "Immutable Email retrieval history." },
  // A reviewed association names the Email whose evidence it settles.
  EmailFinancialAssociation: { owner: emailFinancialAssociation.emailId },
  RunApproval: { excluded: WORKFLOW },
  RunControlEvent: { excluded: WORKFLOW },
  RunPushRegistration: {
    excluded:
      "Push delivery state for a device's Run registration, not a relationship.",
  },
  RunOperation: { excluded: WORKFLOW },
  ImportSourceClaim: { excluded: WORKFLOW },
  ImportSourceOrder: { excluded: WORKFLOW },
  ImportSourceProduct: { excluded: WORKFLOW },
  LedgerSourceClaim: { excluded: WORKFLOW },
  MailboxCursor: { excluded: WORKFLOW },
  MerchantVendorRule: { excluded: WORKFLOW },
  OrderMail: { excluded: WORKFLOW },
  OrderMailAttachment: { excluded: WORKFLOW },
} satisfies Record<string, EntityEdgeOwner>;
