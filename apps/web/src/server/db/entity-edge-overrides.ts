/** Explicit domain semantics override declaration-derived ordinary references. */
import type { Entity } from "@cubby/schemas/entity";
import type { EdgeLiveness, EdgeRole } from "@cubby/schemas/entity-integrity";
import {
  ENTITY_LINK_KINDS,
  entityLinkEdgeKey,
  type EntityLinkKind,
  type EntityLinkKindDeclaration,
  entityLinkKinds,
} from "@cubby/schemas/entity-links";
import {
  EXTERNAL_ID_KINDS,
  type EntityExternalIdKind,
} from "@cubby/schemas/external-id";
import { mapRecord } from "@cubby/shared";
import { ENTITY_KEYS } from "@cubby/shared/entity-keys";
import type { AnyColumn } from "drizzle-orm";

import { DECLARED_EDGE_OVERRIDES } from "./generated/declared-edges.gen";
import {
  shipment,
  shipmentObservation,
  shipmentSourceCapture,
  shipmentSourcePackage,
  aiUsage,
  mcpToolCall,
  aiEvaluation,
  job,
  aiEvaluationRequest,
  auditLog,
  device,
  entityAttachment,
  entityExternalId,
  entityLink,
  externalSource,
  expense,
  expenseAttribution,
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
  image,
  imageProcessingJob,
  imageSighting,
  importPreparedOrder,
  sourceOrderObservation,
  emailCandidateObservation,
  emailClassificationObservation,
  emailFinancialAssociation,
  emailRetrievalFailure,
  run as runTable,
  runControlEvent,
  runFinding,
  runOperation,
  importSourceClaim,
  importSourceOrder,
  importSourceProduct,
  inventoryEntry,
  ledgerSourceClaim,
  ledgerTransfer,
  mealFoodEntry,
  mealRecipePortion,
  mailboxCursor,
  email as emailTable,
  orderMail,
  photoGroupProposal,
  photoRunImage,
  runPushRegistration,
  runStep,
  product,
  project,
  purchase,
  purchasePaymentEvidence,
  sourceTransactionRecord,
  sourceObservationAnnotation,
  sourceOccurrence,
  financialEvidenceAlias,
  transactionImportRecord,
  suggestionTable,
  task,
  vendorAccount,
} from "./schema";

/** `${pgTable name}.${column name}` — e.g. `"EntityAttachment.imageId"`. */
type EdgeKey<C extends AnyColumn> = `${C["_"]["tableName"]}.${C["_"]["name"]}`;

export interface EntityEdge {
  /** The FK column, on the referencing table, that points at this entity's `id`. */
  column: AnyColumn;
  /**
   * What the edge represents in the domain — never what an operation does
   * about it. See {@link EdgeRole} for the closed vocabulary.
   */
  role: EdgeRole;
  /** Plural noun phrase naming the referencing rows, e.g. "recipes". */
  label: string;
  /** One or two sentences explaining what the edge means and why. */
  description: string;
  /**
   * Whether a live source row is allowed to point at a soft-deleted target.
   * Nearly every edge is `must-target-live`.
   */
  liveness: EdgeLiveness;
  /**
   * True when the relationship is real (modeled in `relations()`, walked by
   * app code) but carries no DB-level FK constraint. Predicates that need to
   * walk the relationship still can; they just can't rely on the database to
   * enforce or cascade it.
   */
  unconstrained?: true;
  /** Free-text justification, for an edge whose key alone doesn't explain itself. */
  note?: string;
  /**
   * The rows of `column`'s table that belong to this edge, when the table
   * carries several edges in one column. Every `EntityLink` edge is scoped to
   * its link kind (`kind = 'productComponent'`): `toEntityId` alone would
   * match a product's purchase, tool, wish, and component links at once.
   * Every consumer that builds SQL from `column` must AND this in.
   */
  scope?: EdgeScope;
}

export interface EdgeScope {
  column: AnyColumn;
  value: string;
}

/**
 * Forces every entry's key to equal `EdgeKey<its own column>`. Drizzle
 * preserves a concretely-declared column's table name and column name as
 * literal string types (see `productImage.imageId`'s inferred type), so
 * key↔column correspondence is checkable even though completeness of the edge
 * SET is not — a mis-keyed entry (wrong table, wrong column, a typo) fails to
 * satisfy this and is a compile error at the `edges({...})` call site. Set
 * completeness is entity-manifest-fk.unit.test.ts's job, not this type's.
 */
type WellKeyed<T extends Record<string, EntityEdge>> = {
  [K in keyof T]: K extends EdgeKey<T[K]["column"]> ? unknown : never;
};

function edges<T extends Record<string, EntityEdge>>(t: T & WellKeyed<T>): T {
  return t;
}

type LinkDeclaration = typeof ENTITY_LINK_KINDS;

/**
 * The two incoming edges every link kind contributes, keyed by
 * `entityLinkEdgeKey`: `.from` is incoming at the owning entity, `.to` at the
 * other end. Each keeps its declaration's literal `role`, which
 * `PRODUCT_EDGE_ROLES` selects retaining edges by.
 */
type LinkEdgesOf<E extends Entity> = {
  [
    K in EntityLinkKind as LinkDeclaration[K]["from"] extends E
      ? `EntityLink[${K}].from`
      : never
  ]: Omit<EntityEdge, "role"> & {
    role: LinkDeclaration[K]["fromEnd"]["role"];
  };
} & {
  [
    K in EntityLinkKind as LinkDeclaration[K]["to"] extends E
      ? `EntityLink[${K}].to`
      : never
  ]: Omit<EntityEdge, "role"> & {
    role: LinkDeclaration[K]["toEnd"]["role"];
  };
};

type ExternalIdEntity =
  (typeof EXTERNAL_ID_KINDS)[EntityExternalIdKind]["entities"][number];

/** The `EntityExternalId` edge of an entity some identifier kind attaches to. */
type ExternalIdEdgesOf<E extends Entity> = E extends ExternalIdEntity
  ? {
      "EntityExternalId.entityId": Omit<EntityEdge, "role"> & {
        role: "metadata";
      };
    }
  : Record<never, never>;

/**
 * `entity`'s incoming `EntityExternalId` edge, present exactly when
 * `EXTERNAL_ID_KINDS` lets some identifier kind attach to it. Identifiers are
 * metadata: they never say the entity was owned, bought, or used.
 */
function externalIdEdgesFor<E extends Entity>(entity: E): ExternalIdEdgesOf<E> {
  const attaches = Object.values(EXTERNAL_ID_KINDS).some((declaration) =>
    declaration.entities.some((candidate: string) => candidate === entity),
  );
  // SAFETY: the edge is present exactly when some kind attaches to `entity`,
  // which is the condition `ExternalIdEdgesOf<E>` spells out.
  return (
    attaches
      ? {
          "EntityExternalId.entityId": {
            column: entityExternalId.entityId,
            role: "metadata",
            label: "external ids",
            description:
              "An identifier another system gives this record (an ASIN, a barcode, a settlement reference, a Notion page); says nothing about ownership or spend.",
            liveness: { kind: "must-target-live" },
          },
        }
      : {}
  ) as ExternalIdEdgesOf<E>;
}

/** `entity`'s incoming `EntityLink` edges, generated from `ENTITY_LINK_KINDS`. */
function linkEdgesFor<E extends Entity>(entity: E): LinkEdgesOf<E> {
  const entries = entityLinkKinds.flatMap((kind) => {
    const declaration: EntityLinkKindDeclaration = ENTITY_LINK_KINDS[kind];
    const scope = { column: entityLink.kind, value: kind };
    const ends = [
      {
        end: "from",
        at: declaration.from,
        column: entityLink.fromEntityId,
        meaning: declaration.fromEnd,
      },
      {
        end: "to",
        at: declaration.to,
        column: entityLink.toEntityId,
        meaning: declaration.toEnd,
      },
    ] as const;
    return ends
      .filter((candidate) => candidate.at === entity)
      .map(
        ({ end, column, meaning }) =>
          [
            entityLinkEdgeKey(kind, end),
            {
              column,
              scope,
              role: meaning.role,
              label: meaning.label,
              description: meaning.description,
              liveness: meaning.liveness,
            } satisfies EntityEdge,
          ] as const,
      );
  });
  // SAFETY: the entries are exactly the ends whose endpoint kind is `entity`,
  // keyed and typed as `LinkEdgesOf<E>` spells out.
  return Object.fromEntries(entries) as LinkEdgesOf<E>;
}

export const ENTITY_EDGE_OVERRIDES = {
  // The generated vocabulary owns empty groups; explicit semantics retain literal edge keys.
  ...mapRecord(ENTITY_KEYS, () => ({})),
  shipment: edges({
    "ShipmentObservation.shipmentId": {
      column: shipmentObservation.shipmentId,
      role: "history",
      label: "tracking observations",
      description: "Retained tracking evidence for this package.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "A retired package keeps its source observations; package merging is unsupported.",
      },
    },
    "ShipmentSourcePackage.shipmentId": {
      column: shipmentSourcePackage.shipmentId,
      role: "history",
      label: "source package identities",
      description: "Stable source package associations for replay.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "A retired package's binding stops replay recreating it; package merging is unsupported.",
      },
    },
  }),
  sourceTransactionRecord: edges({
    "SourceObservationAnnotation.supersededByObservationId": {
      column: sourceObservationAnnotation.supersededByObservationId,
      role: "history",
      label: "original replacements",
      description:
        "Each original observation preserves its reviewed successor.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "The live replacement guard owns deletion eligibility; retained decisions remain historical evidence.",
      },
    },
    "SourceOccurrence.currentObservationId": {
      column: sourceOccurrence.currentObservationId,
      role: "history",
      label: "occurrence frontier",
      description:
        "Retain the selected frontier after observation deletion; never promote an older version.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "A tombstoned frontier reserves source identity without authorizing automatic money.",
      },
    },
    "SourceOccurrence.replacementObservationId": {
      column: sourceOccurrence.replacementObservationId,
      role: "history",
      label: "replacement proof",
      description:
        "The exact reviewed replacement observation remains explainable.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "The deletion hook protects live replacement decisions while history remains retained.",
      },
    },
    "SourceObservationAnnotation.observationId": {
      column: sourceObservationAnnotation.observationId,
      role: "history",
      label: "observation annotations",
      description:
        "Original notes and unresolved judgments survive observation retirement.",
      liveness: {
        kind: "allow-target-deleted",
        reason: "Annotations preserve source history through its tombstone.",
      },
    },
    "FinancialEvidenceAlias.observationId": {
      column: financialEvidenceAlias.observationId,
      role: "history",
      label: "retained evidence aliases",
      description:
        "Original aliases remain explainable through observation tombstones.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Alias evidence is retained, never a live accepted-owner lookup.",
      },
    },

    "TransactionImportRecord.statementRowId": {
      column: transactionImportRecord.statementRowId,
      role: "history",
      label: "import memberships",
      description:
        "The imports that received this immutable source observation.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Intake history retains the original record identity through deletion.",
      },
    },
  }),
  sourceOccurrence: edges({
    "SourceTransactionRecord.occurrenceId": {
      column: sourceTransactionRecord.occurrenceId,
      role: "history",
      label: "source observations",
      description:
        "Immutable observations keep their proven occurrence identity.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Retiring an identity never rewrites the observations that reserved it.",
      },
    },
    "FinancialEvidenceAlias.occurrenceId": {
      column: financialEvidenceAlias.occurrenceId,
      role: "history",
      label: "source aliases",
      description:
        "Alias provenance keeps its original proven source occurrence.",
      liveness: {
        kind: "allow-target-deleted",
        reason: "Evidence is retained through occurrence retirement.",
      },
    },
    "SourceOccurrence.supersededByOccurrenceId": {
      column: sourceOccurrence.supersededByOccurrenceId,
      role: "history",
      label: "reviewed replacements",
      description:
        "An explicit replacement keeps naming its reserved target identity.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Source lifecycle history never releases or silently reassigns replacement identity.",
      },
    },
  }),
  transactionImport: edges({
    "SourceOccurrence.physicalImportId": {
      column: sourceOccurrence.physicalImportId,
      role: "history",
      label: "physical source identities",
      description:
        "The original physical collection reserves each positioned occurrence.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Collection retirement never releases its original position identities.",
      },
    },
    "SourceOccurrence.withdrawalImportId": {
      column: sourceOccurrence.withdrawalImportId,
      role: "history",
      label: "withdrawal proofs",
      description:
        "The completed provider collection that confirmed source withdrawal.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "A retained withdrawal remains evidence after collection retirement.",
      },
    },
    "SourceObservationAnnotation.withdrawalImportId": {
      column: sourceObservationAnnotation.withdrawalImportId,
      role: "history",
      label: "original withdrawal proofs",
      description:
        "Original observation withdrawal history preserves its collection identity.",
      liveness: {
        kind: "allow-target-deleted",
        reason: "Historical provenance survives collection retirement.",
      },
    },
    "SourceTransactionRecord.batchId": {
      column: sourceTransactionRecord.batchId,
      role: "history",
      label: "first-ingest provenance",
      description: "The import that first retained a source observation.",
      liveness: { kind: "must-target-live" },
    },

    "TransactionImportRecord.importId": {
      column: transactionImportRecord.importId,
      role: "history",
      label: "received record memberships",
      description:
        "The retained membership of one resumable transaction import.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Retained import membership survives retirement of its collection.",
      },
    },
  }),

  email: edges({
    "ShipmentSourceCapture.emailId": {
      column: shipmentSourceCapture.emailId,
      role: "history",
      label: "shipment source captures",
      description: "Retained reference to the original shipping Email.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Shipment provenance retains the Email identity after its removal.",
      },
    },
    "EmailCandidateObservation.emailId": {
      column: emailCandidateObservation.emailId,
      role: "history",
      label: "candidate observations",
      description:
        "Immutable evidence about the original Email, retained through its tombstone.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Immutable observation history retains its original subject UUID through deletion and merge.",
      },
    },
    "EmailClassificationObservation.emailId": {
      column: emailClassificationObservation.emailId,
      role: "history",
      label: "classification observations",
      description:
        "Immutable evidence about the original Email, retained through its tombstone.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Immutable observation history retains its original subject UUID through deletion and merge.",
      },
    },
    "EmailFinancialAssociation.emailId": {
      column: emailFinancialAssociation.emailId,
      role: "history",
      label: "financial associations",
      description:
        "A member-reviewed link from this Email's evidence to a settlement transaction, retained through its tombstone.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "A reviewed Email-to-transaction association is append-only history that keeps its original UUIDs through every tombstone.",
      },
    },
    "EmailRetrievalFailure.emailId": {
      column: emailRetrievalFailure.emailId,
      role: "history",
      label: "retrieval failures",
      description:
        "Immutable evidence about the original Email, retained through its tombstone.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Immutable observation history retains its original subject UUID through deletion and merge.",
      },
    },
  }),

  ledgerParty: edges({
    "Task.assigneeId": {
      column: task.assigneeId,
      role: "reference",
      label: "assigned tasks",
      description: "An explicit member assignee on live work.",
      liveness: { kind: "must-target-live" },
    },
    "Project.assigneeId": {
      column: project.assigneeId,
      role: "reference",
      label: "project assignee defaults",
      description: "An explicit member default for project work.",
      liveness: { kind: "must-target-live" },
    },
    "PhotoGroupProposal.inventoryOwnerPartyId": {
      column: photoGroupProposal.inventoryOwnerPartyId,
      role: "metadata",
      label: "photo group proposals",
      description:
        "The member a proposed photo group's inventory will belong to; a merge follows it to the survivor.",
      liveness: { kind: "must-target-live" },
    },
    "VendorAccount.ledgerPartyId": {
      column: vendorAccount.ledgerPartyId,
      role: "reference",
      label: "vendor accounts",
      description: "A member-owned login used for vendor import automation.",
      liveness: { kind: "must-target-live" },
    },
    "Run.ledgerPartyId": {
      column: runTable.ledgerPartyId,
      role: "history",
      label: "import runs",
      description: "The member whose evidence was processed by an import run.",
      liveness: { kind: "must-target-live" },
    },
    "ImportSourceClaim.ledgerPartyId": {
      column: importSourceClaim.ledgerPartyId,
      role: "history",
      label: "import source claims",
      description: "The member scope for an idempotent imported source.",
      liveness: { kind: "must-target-live" },
    },
    "Suggestion.ledgerPartyId": {
      column: suggestionTable.ledgerPartyId,
      role: "history",
      label: "import findings",
      description: "The member whose import requires review.",
      liveness: { kind: "must-target-live" },
    },
    "RunFinding.ledgerPartyId": {
      column: runFinding.ledgerPartyId,
      role: "history",
      label: "run findings",
      description: "The member whose import finding requires review.",
      liveness: { kind: "must-target-live" },
    },
    "MailboxCursor.ledgerPartyId": {
      column: mailboxCursor.ledgerPartyId,
      role: "metadata",
      label: "mailbox cursors",
      description: "A member mailbox's durable Gmail history cursor.",
      liveness: { kind: "must-target-live" },
    },
    "Email.ledgerPartyId": {
      column: emailTable.ledgerPartyId,
      role: "metadata",
      label: "mailbox message status",
      description:
        "Minimal classification and recovery metadata for a member mailbox.",
      liveness: { kind: "must-target-live" },
    },
    "OrderMail.ledgerPartyId": {
      column: orderMail.ledgerPartyId,
      role: "history",
      label: "order mail",
      description: "Normalized order evidence from a member mailbox.",
      liveness: { kind: "must-target-live" },
    },
    "MealFoodEntry.ledgerPartyId": {
      column: mealFoodEntry.ledgerPartyId,
      role: "association",
      label: "meal food entries",
      description:
        "A product or manual food amount naming this member or guest as its eater.",
      liveness: { kind: "must-target-live" },
    },
    "ExpenseAttribution.ledgerPartyId": {
      column: expenseAttribution.ledgerPartyId,
      role: "ledger",
      label: "beneficiary attributions",
      description:
        "A weighted expense beneficiary or funder share; money remains on the expense itself.",
      liveness: { kind: "must-target-live" },
    },
    "FinancialAccount.primaryCardholderId": {
      column: financialAccount.primaryCardholderId,
      role: "reference",
      label: "primary cards",
      description: "The member who primarily uses the credit card.",
      liveness: { kind: "must-target-live" },
    },
    "Purchase.purchaserOverrideId": {
      column: purchase.purchaserOverrideId,
      role: "reference",
      label: "purchaser overrides",
      description:
        "An explicit purchaser independent of funding and consumption.",
      liveness: { kind: "must-target-live" },
    },
    "FinancialAccount.ledgerPartyId": {
      column: financialAccount.ledgerPartyId,
      role: "reference",
      label: "financial accounts",
      description:
        "The member or household party an evidence account belongs to.",
      liveness: { kind: "must-target-live" },
    },
    "InventoryEntry.ownerLedgerPartyId": {
      column: inventoryEntry.ownerLedgerPartyId,
      role: "reference",
      label: "owned inventory entries",
      description:
        "An explicit member or guest owner pinned on a current inventory slot.",
      liveness: { kind: "must-target-live" },
    },
    "LedgerTransfer.fromPartyId": {
      column: ledgerTransfer.fromPartyId,
      role: "ledger",
      label: "outgoing transfers",
      description: "A transfer source endpoint.",
      liveness: { kind: "must-target-live" },
    },
    "LedgerTransfer.toPartyId": {
      column: ledgerTransfer.toPartyId,
      role: "ledger",
      label: "incoming transfers",
      description: "A transfer target endpoint.",
      liveness: { kind: "must-target-live" },
    },
    "MealRecipePortion.ledgerPartyId": {
      column: mealRecipePortion.ledgerPartyId,
      role: "association",
      label: "meal portions",
      description:
        "A planned or confirmed recipe portion naming this member or guest as its eater.",
      liveness: { kind: "must-target-live" },
    },
    "Device.ledgerPartyId": {
      column: device.ledgerPartyId,
      role: "reference",
      label: "devices",
      description: "A native companion install owned by this member.",
      liveness: { kind: "must-target-live" },
    },
    "ImageSighting.ledgerPartyId": {
      column: imageSighting.ledgerPartyId,
      role: "reference",
      label: "image sightings",
      description:
        "The member whose photo library or cloud account a sighting was reported from.",
      liveness: { kind: "must-target-live" },
    },
    "Image.capturedByPartyId": {
      column: image.capturedByPartyId,
      role: "reference",
      label: "captured images",
      description:
        "The member an image's capture is derived (or manually confirmed) as belonging to.",
      liveness: { kind: "must-target-live" },
    },
  }),

  vendor: edges({
    "Shipment.carrierId": {
      column: shipment.carrierId,
      role: "reference",
      label: "carried shipments",
      description: "The carrier's existing Vendor identity.",
      liveness: { kind: "must-target-live" },
    },
    "PhotoGroupProposal.productCreateBrandId": {
      column: photoGroupProposal.productCreateBrandId,
      role: "metadata",
      label: "photo Brand proposals",
      description:
        "The Brand selected for a proposed Product creation or Brand update.",
      liveness: { kind: "must-target-live" },
    },
    "Product.brandId": {
      column: product.brandId,
      role: "reference",
      label: "branded products",
      description:
        "The marketed brand identity, independently of purchased-from sellers and commodity status.",
      liveness: { kind: "must-target-live" },
    },
    "SourceOrderObservation.vendorId": {
      column: sourceOrderObservation.vendorId,
      role: "history",
      label: "observed Vendors",
      description:
        "The original Vendor named by an immutable source extraction.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Immutable observation history retains its original subject UUID through deletion and merge.",
      },
    },

    "EntityAttachment.entityId": {
      column: entityAttachment.entityId,
      role: "media",
      label: "vendor logos",
      description:
        "An optional brand mark for this vendor; absence falls back to the vendor monogram.",
      liveness: { kind: "must-target-live" },
    },
    "FinancialAccount.providerVendorId": {
      column: financialAccount.providerVendorId,
      role: "reference",
      label: "stored-value accounts",
      description:
        "A gift card or store-credit balance this vendor owes a member or the household.",
      liveness: { kind: "must-target-live" },
    },
    "Run.vendorId": {
      column: runTable.vendorId,
      role: "history",
      label: "import runs",
      description:
        "A durable import run tied directly to its vendor when no vendor account supplies that scope.",
      liveness: { kind: "must-target-live" },
    },
    "VendorAccount.vendorId": {
      column: vendorAccount.vendorId,
      role: "reference",
      label: "vendor accounts",
      description: "A member-owned login for this vendor.",
      liveness: { kind: "must-target-live" },
    },
    "ExternalSource.vendorId": {
      column: externalSource.vendorId,
      role: "metadata",
      label: "identifier sources",
      description:
        "A registered identifier source (a catalog, an export) that is this vendor; it names the vendor, it does not depend on it.",
      liveness: { kind: "must-target-live" },
    },
    "ImportPreparedOrder.vendorId": {
      column: importPreparedOrder.vendorId,
      role: "history",
      label: "prepared import orders",
      description:
        "The Vendor a purchase import named while preparing an order.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Preparation is an immutable capture; commit refuses a deleted or merged Vendor and the order must be prepared again.",
      },
    },
    "OrderMail.vendorId": {
      column: orderMail.vendorId,
      role: "history",
      label: "order mail",
      description: "Normalized mailbox evidence classified to this vendor.",
      liveness: { kind: "must-target-live" },
    },
    "Purchase.vendorId": {
      column: purchase.vendorId,
      role: "transaction",
      label: "purchases",
      description:
        "A vendor order/receipt event recorded against this vendor (identified by orderId when one is issued), not the spend ledger or a card charge — the Vendor ──< Purchase ──< Expense chain.",
      liveness: { kind: "must-target-live" },
    },
  }),
  purchase: {
    ...edges({
      "Shipment.purchaseId": {
        column: shipment.purchaseId,
        role: "reference",
        label: "shipments",
        description: "The package's currently accepted order association.",
        liveness: { kind: "must-target-live" },
      },
      "SourceOrderObservation.purchaseId": {
        column: sourceOrderObservation.purchaseId,
        role: "history",
        label: "source order observations",
        description:
          "The original Purchase subject of an immutable source extraction.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "Immutable observation history retains its original subject UUID through deletion and merge.",
        },
      },
      "ImportPreparedOrder.targetPurchaseId": {
        column: importPreparedOrder.targetPurchaseId,
        role: "history",
        label: "prepared purchase targets",
        description:
          "The explicitly reviewed target captured during import preparation.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "Preparation retains its original target tombstone. Deletion or merge invalidates commit and requires preparation against the current Purchase.",
        },
      },
      "ImportSourceOrder.purchaseId": {
        column: importSourceOrder.purchaseId,
        role: "history",
        label: "import source claims",
        description:
          "The accepted source order that produced this purchase and fences its replay. Deleting the purchase clears the link and keeps the row as the Email's accepted history.",
        liveness: { kind: "must-target-live" },
      },
      "PurchasePaymentEvidence.purchaseId": {
        column: purchasePaymentEvidence.purchaseId,
        role: "transaction",
        label: "payment evidence",
        description:
          "A captured shipment or order payment tied to this purchase.",
        liveness: { kind: "must-target-live" },
      },
      "Expense.purchaseId": {
        column: expense.purchaseId,
        role: "ledger",
        label: "expenses",
        description:
          "A categorized line of spend booked against this purchase. All money lives on Expense.cost; the purchase's own statedTotal is a soft reconciliation cue and is never summed into spend.",
        liveness: { kind: "must-target-live" },
      },
      "EntityAttachment.entityId": {
        column: entityAttachment.entityId,
        role: "media",
        label: "purchase documents",
        description:
          "A receipt, invoice, or other document attached to this purchase.",
        liveness: { kind: "must-target-live" },
      },
      "FinancialTransactionAllocation.purchaseId": {
        column: financialTransactionAllocation.purchaseId,
        role: "transaction",
        label: "settlement allocations",
        description:
          "A slice of one card or bank transaction attributed to this purchase. One real charge can settle several purchases, so the slice — not the whole transaction — is what this order settled. The amount is evidence only; spend remains SUM(Expense.cost).",
        liveness: { kind: "must-target-live" },
      },
    }),
    ...linkEdgesFor("purchase"),
  },
  financialAccount: {
    ...edges({
      "FinancialTransaction.accountId": {
        column: financialTransaction.accountId,
        role: "transaction",
        label: "financial transactions",
        description:
          "A settlement-side event recorded by this financial account.",
        liveness: { kind: "must-target-live" },
      },
      "EmailFinancialAssociation.reviewedAccountId": {
        column: emailFinancialAssociation.reviewedAccountId,
        role: "history",
        label: "reviewed Email associations",
        description:
          "The account a member confirmed when linking an Email to a settlement transaction; the review keeps naming it after the account is deleted.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "A reviewed Email-to-transaction association is append-only history that keeps its original UUIDs through every tombstone.",
        },
      },
      "SourceObservationAnnotation.accountId": {
        column: sourceObservationAnnotation.accountId,
        role: "history",
        label: "original source account judgments",
        description:
          "Each retained observation keeps its original account judgment; unresolved active assignments are guarded by account deletion.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "Promoted observations retain their original account history after current occurrence judgments change.",
        },
      },
    }),
    ...linkEdgesFor("financialAccount"),
  },
  financialTransaction: {
    ...edges({
      "SourceOccurrence.acceptedTransactionId": {
        column: sourceOccurrence.acceptedTransactionId,
        role: "history",
        label: "accepted source reservation",
        description: "Acceptance remains reserved after transaction deletion.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "A deleted accepted transaction never releases identity for automatic money recreation.",
        },
      },
      "FinancialEvidenceAlias.historicalTransactionId": {
        column: financialEvidenceAlias.historicalTransactionId,
        role: "history",
        label: "retained source bindings",
        description: "Former source bindings remain original evidence.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "Retained provenance names transaction tombstones without establishing current ownership.",
        },
      },
      "EmailFinancialAssociation.transactionId": {
        column: emailFinancialAssociation.transactionId,
        role: "history",
        label: "reviewed Email associations",
        description:
          "A member-reviewed link from an Email's evidence to this transaction; the review keeps naming it after the transaction is deleted.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "A reviewed Email-to-transaction association is append-only history that keeps its original UUIDs through every tombstone.",
        },
      },
      "FinancialTransactionAllocation.transactionId": {
        column: financialTransactionAllocation.transactionId,
        role: "composition",
        label: "purchase allocations",
        description:
          "One slice of this transaction's amount, attributed to a single Purchase. The slices are meaningless apart from the charge whose amount they decompose: a transaction has either none of them, or a set that sums to its amount exactly and shares its sign.",
        liveness: { kind: "must-target-live" },
      },
    }),
    ...externalIdEdgesFor("financialTransaction"),
  },
  expense: {
    ...edges({
      "ImportSourceProduct.expenseId": {
        column: importSourceProduct.expenseId,
        role: "metadata",
        label: "receipt lines",
        description:
          "The receipt line refers to its current editable Expense; the Expense owns its Product.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "A deleted Expense remains the historical receipt target and contributes no current Product claim.",
        },
      },
      "ExpenseAttribution.expenseId": {
        column: expenseAttribution.expenseId,
        role: "composition",
        label: "party shares",
        description:
          "Unitless beneficiary or initial-funder weights that allocate this Expense without storing money.",
        liveness: { kind: "must-target-live" },
      },
      "LedgerSourceClaim.expenseId": {
        column: ledgerSourceClaim.expenseId,
        role: "metadata",
        label: "import source references",
        description:
          "Durable external identity proving which normalized source row became this Expense.",
        liveness: { kind: "must-target-live" },
      },
    }),
    ...externalIdEdgesFor("expense"),
  },
  ledgerTransfer: edges({
    "FinancialTransaction.ledgerTransferId": {
      column: financialTransaction.ledgerTransferId,
      role: "reference",
      label: "evidence transactions",
      description: "Posted settlement evidence for this transfer.",
      liveness: { kind: "must-target-live" },
    },
    "LedgerSourceClaim.ledgerTransferId": {
      column: ledgerSourceClaim.ledgerTransferId,
      role: "metadata",
      label: "source claims",
      description: "Canonical external evidence claimed by this transfer.",
      liveness: { kind: "must-target-live" },
    },
  }),

  // The read-only run record itself has no delete/merge operation
  // (`capabilities.delete: null`), so nothing here ever dispositions these
  // edges under a runTable operation — see entity-incoming-edges.ts's
  // doc comment. Child rows (target/mutation/operation/progress/
  // control-event/approval/prepared-order) exist only as part
  // of one run, so they're `owned-child`; rows other entities keep about a
  // run (purchases it touched, claims it advanced, findings it produced) are
  // `history`, mirroring vendorAccount's own edges above.
  run: edges({
    "Job.runId": {
      column: job.runId,
      role: "history",
      label: "Execution jobs",
      description: "Execution diagnostics attributed to this Run.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Job diagnostics retain their Run attribution through archival and deletion.",
      },
    },
    "AiEvaluationRequest.runId": {
      column: aiEvaluationRequest.runId,
      role: "history",
      label: "AI work requests",
      description:
        "Frozen work membership and independent receipts requested by this Run.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Request receipts retain their Run identity through archival and deletion.",
      },
    },
    "AiEvaluation.runId": {
      column: aiEvaluation.runId,
      role: "history",
      label: "AI evaluations",
      description:
        "Durable target evaluation and publication history owned by this Run.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Evaluation receipts retain their generating Run through archival and deletion.",
      },
    },
    "SourceOrderObservation.runId": {
      column: sourceOrderObservation.runId,
      role: "history",
      label: "source order observations",
      description:
        "The Run that captured an immutable source order extraction.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Immutable observation history retains its original subject UUID through deletion and merge.",
      },
    },
    "EmailCandidateObservation.runId": {
      column: emailCandidateObservation.runId,
      role: "history",
      label: "Email candidate observations",
      description:
        "The original Run that produced this immutable Email evidence.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Immutable observation history retains its original subject UUID through deletion and merge.",
      },
    },
    "EmailClassificationObservation.runId": {
      column: emailClassificationObservation.runId,
      role: "history",
      label: "Email classification observations",
      description:
        "The original Run that produced this immutable Email evidence.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Immutable observation history retains its original subject UUID through deletion and merge.",
      },
    },
    "EmailRetrievalFailure.runId": {
      column: emailRetrievalFailure.runId,
      role: "history",
      label: "Email retrieval failures",
      description:
        "The original Run that produced this immutable Email evidence.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Immutable observation history retains its original subject UUID through deletion and merge.",
      },
    },

    "PhotoRunImage.runId": {
      column: photoRunImage.runId,
      role: "owned-child",
      label: "photo work",
      description: "The picker and processing membership owned by this Run.",
      liveness: { kind: "must-target-live" },
    },
    "Email.runId": {
      column: emailTable.runId,
      role: "association",
      label: "mail research assignments",
      description:
        "The durable researcher currently processing a retained mailbox message.",
      liveness: { kind: "must-target-live" },
    },
    "AuditLog.runId": {
      column: auditLog.runId,
      role: "history",
      label: "audit entries",
      description: "An audit entry written as part of this run.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Append-only provenance: an audit entry keeps naming the run it belonged to.",
      },
    },
    "AiUsage.runId": {
      column: aiUsage.runId,
      role: "history",
      label: "AI usage",
      description: "One model call made as part of this run.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Append-only provenance: a usage row keeps naming the run it was billed to.",
      },
    },
    "McpToolCall.runId": {
      column: mcpToolCall.runId,
      role: "history",
      label: "agent MCP calls",
      description:
        "One Cubby MCP tool call the in-app agent made for this run.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Append-only telemetry: a call keeps naming its run until a hard delete nulls it.",
      },
    },
    "ImageProcessingJob.runId": {
      column: imageProcessingJob.runId,
      role: "history",
      label: "image processing jobs",
      description:
        "An Image job requested by this run. The FK is NO ACTION; the one Run hard delete (routine-run pruning) skips runs with jobs.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Append-only provenance: a job keeps naming the run that scheduled it.",
      },
    },
    "RunPushRegistration.runId": {
      column: runPushRegistration.runId,
      role: "owned-child",
      label: "push registrations",
      description:
        "A device's Live Activity or notification push registration for this Run; deleting the Run removes it.",
      liveness: { kind: "must-target-live" },
    },
    "Suggestion.runId": {
      column: suggestionTable.runId,
      role: "history",
      label: "Suggestions",
      description:
        "Nullable execution provenance; deleting the Run preserves Suggestions and their decisions.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Field reviews retain execution provenance after archival or deletion.",
      },
    },
    "RunFinding.runId": {
      column: runFinding.runId,
      role: "history",
      label: "Findings",
      description:
        "Nullable execution provenance; deleting the Run preserves the finding and its resolutions.",
      liveness: {
        kind: "allow-target-deleted",
        reason:
          "Import findings retain execution provenance after archival or deletion.",
      },
    },
    "Purchase.runId": {
      column: purchase.runId,
      role: "history",
      label: "purchases",
      description: "A purchase this run imported or validated.",
      liveness: { kind: "must-target-live" },
    },
    "Run.predecessorRunId": {
      column: runTable.predecessorRunId,
      role: "history",
      label: "successor runs",
      description: "A later run that continued from this one.",
      liveness: { kind: "must-target-live" },
    },
    "Run.parentRunId": {
      column: runTable.parentRunId,
      role: "history",
      label: "child runs",
      description: "Work caused by this Run, distinct from its retry attempts.",
      liveness: { kind: "must-target-live" },
    },
    "RunStep.runId": {
      column: runStep.runId,
      role: "owned-child",
      label: "steps",
      description:
        "One ordered step of this step-ledger Run (a backlog or a Suggestion family); deleting the Run removes it.",
      liveness: { kind: "must-target-live" },
    },
    "RunOperation.runId": {
      column: runOperation.runId,
      role: "owned-child",
      label: "operations",
      description: "One idempotent operation this run executed.",
      liveness: { kind: "must-target-live" },
    },
    "RunControlEvent.runId": {
      column: runControlEvent.runId,
      role: "owned-child",
      label: "control events",
      description:
        "A prompt, pause, resume, or other control-plane event for this run.",
      liveness: { kind: "must-target-live" },
    },
    "ImportPreparedOrder.runId": {
      column: importPreparedOrder.runId,
      role: "owned-child",
      label: "prepared orders",
      description: "Immutable prepared order evidence captured by this run.",
      liveness: { kind: "must-target-live" },
    },
    "PhotoGroupProposal.runId": {
      column: photoGroupProposal.runId,
      role: "owned-child",
      label: "photo group proposals",
      description:
        "A proposed item grouping of this photo-inventory run's images.",
      liveness: { kind: "must-target-live" },
    },
    "ImportSourceClaim.firstRunId": {
      column: importSourceClaim.firstRunId,
      role: "history",
      label: "source claims (first seen)",
      description: "An idempotent source claim first captured by this run.",
      liveness: { kind: "must-target-live" },
    },
    "ImportSourceClaim.lastRunId": {
      column: importSourceClaim.lastRunId,
      role: "history",
      label: "source claims (last seen)",
      description:
        "An idempotent source claim most recently confirmed by this run.",
      liveness: { kind: "must-target-live" },
    },
  }),
  ...DECLARED_EDGE_OVERRIDES,
} as const satisfies Record<Entity, Record<string, EntityEdge>>;
