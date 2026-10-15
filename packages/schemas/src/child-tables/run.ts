import { APPLE_APP_IDENTITIES } from "@cubby/shared/apple-app-identity";

import { defineChildTable } from "../entity-definitions/child-definition.js";

export const runChildren = [
  /** Photo membership and replay state belong to the Run, never to an Image singleton. */
  defineChildTable({
    name: "PhotoRunImage",
    exportName: "photoRunImage",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "runId",
        kind: "uuid",
        notNull: true,
        type: "RunId",
        reference: { table: "run", column: "id" },
      },
      {
        key: "imageId",
        kind: "uuid",
        notNull: true,
        type: "ImageId",
        reference: { table: "image", column: "id" },
      },
      { key: "workKey", kind: "text", notNull: true, default: "" },
      { key: "position", kind: "integer" },
      {
        key: "state",
        kind: "text",
        type: "PhotoRunImageState",
        notNull: true,
        default: "pending",
      },
      { key: "targetFingerprint", kind: "text", notNull: true },
      { key: "outcome", kind: "text", type: "PhotoRunImageOutcome" },
      { key: "skipReason", kind: "text" },
      {
        key: "commitReceipt",
        kind: "jsonb",
        type: "PhotoRunImageCommitReceipt",
      },
      { key: "preparedAt", kind: "timestamp" },
      { key: "completedAt", kind: "timestamp" },
      {
        key: "deviceWorkState",
        kind: "text",
        type: "RunTargetDeviceWorkState",
      },
      { key: "deviceWorkAttempts", kind: "integer", notNull: true, default: 0 },
      { key: "deviceWorkError", kind: "text" },
      {
        key: "deviceWorkDeviceId",
        kind: "uuid",
        type: "DeviceId",
        reference: { table: "device", column: "id", onDelete: "set null" },
      },
      { key: "deviceWorkUpdatedAt", kind: "timestamp" },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
        onUpdateNow: true,
      },
    ],
    types: [
      {
        module: "@cubby/schemas/identifiers",
        exports: ["RunId", "ImageId", "DeviceId"],
      },
      {
        module: "@cubby/schemas/photo-import-run",
        exports: [
          "PhotoRunImageState",
          "PhotoRunImageOutcome",
          "PhotoRunImageCommitReceipt",
          "RunTargetDeviceWorkState",
        ],
      },
    ],
    indexes: [
      {
        name: "PhotoRunImage_run_image_work_key",
        unique: true,
        on: ["runId", "imageId", "workKey"],
      },
      { name: "PhotoRunImage_image_idx", on: ["imageId"] },
      {
        name: "PhotoRunImage_device_idx",
        on: ["deviceWorkDeviceId"],
        where: "{deviceWorkDeviceId} IS NOT NULL",
      },
    ],
    checks: [
      {
        name: "PhotoRunImage_state_check",
        sql: "{state} IN ('pending', 'prepared', 'completed', 'skipped', 'unresolved', 'needs_evidence', 'unavailable')",
      },
      {
        name: "PhotoRunImage_outcome_check",
        sql: "{outcome} IS NULL OR {outcome} IN ('attached', 'skipped')",
      },
      {
        name: "PhotoRunImage_device_state_check",
        sql: "{deviceWorkState} IS NULL OR {deviceWorkState} IN ('queued', 'running', 'paused', 'failed', 'completed')",
      },
    ],
  }),
  /** Stable source ownership makes browser pages, email, exports, and orderless receipts replay-safe. */
  defineChildTable({
    name: "ImportSourceClaim",
    exportName: "importSourceClaim",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "ledgerPartyId",
        kind: "uuid",
        notNull: true,
        type: "LedgerPartyId",
        reference: { table: "ledgerParty", column: "id" },
      },
      {
        key: "vendorAccountId",
        kind: "uuid",
        reference: { table: "vendorAccount", column: "id" },
      },
      { key: "kind", kind: "text", notNull: true },
      { key: "externalKey", kind: "text", notNull: true },
      { key: "checksum", kind: "text", notNull: true },
      {
        key: "canonicalClaimId",
        kind: "uuid",
        reference: { table: "importSourceClaim", column: "id" },
      },
      {
        key: "firstRunId",
        kind: "uuid",
        notNull: true,
        reference: { table: "run", column: "id" },
      },
      {
        key: "lastRunId",
        kind: "uuid",
        notNull: true,
        reference: { table: "run", column: "id" },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
        onUpdateNow: true,
      },
    ],
    types: [
      {
        module: "@cubby/schemas/identifiers",
        exports: ["LedgerPartyId"],
      },
    ],
    indexes: [
      {
        name: "ImportSourceClaim_source_key",
        unique: true,
        on: ["ledgerPartyId", "kind", "externalKey"],
      },
      { name: "ImportSourceClaim_canonical_idx", on: ["canonicalClaimId"] },
    ],
    checks: [
      {
        name: "ImportSourceClaim_kind_check",
        sql: "{kind} IN ('browser_order', 'mail_message', 'mail_attachment', 'receipt_photo', 'vendor_export')",
      },
      {
        name: "ImportSourceClaim_canonical_self_check",
        sql: "{canonicalClaimId} IS NULL OR {canonicalClaimId} <> {id}",
      },
    ],
  }),
  /** Each order supported by a source has its own replay and ownership fence. */
  defineChildTable({
    name: "ImportSourceOrder",
    exportName: "importSourceOrder",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "sourceClaimId",
        kind: "uuid",
        notNull: true,
        reference: { table: "importSourceClaim", column: "id" },
      },
      { key: "orderKey", kind: "text", notNull: true },
      {
        key: "purchaseId",
        kind: "uuid",
        notNull: true,
        type: "PurchaseId",
        reference: { table: "purchase", column: "id" },
      },
      { key: "checksum", kind: "text", notNull: true },
      { key: "outputFingerprint", kind: "text", notNull: true },
      { key: "originalOrder", kind: "jsonb", type: "AcceptedSourceOrder" },
      {
        key: "acceptedObservationId",
        kind: "uuid",
        reference: { table: "sourceOrderObservation", column: "id" },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
        onUpdateNow: true,
      },
    ],
    types: [
      { module: "@cubby/schemas/identifiers", exports: ["PurchaseId"] },
      {
        module: "@cubby/schemas/purchase-import",
        exports: ["AcceptedSourceOrder"],
      },
    ],
    indexes: [
      {
        name: "ImportSourceOrder_source_order_key",
        unique: true,
        on: ["sourceClaimId", "orderKey"],
      },
      { name: "ImportSourceOrder_purchase_idx", on: ["purchaseId"] },
      {
        name: "ImportSourceOrder_acceptedObservation_idx",
        on: ["acceptedObservationId"],
      },
    ],
  }),
  /** Replay-safe boundary for the agent's durable tools and external side effects. */
  defineChildTable({
    name: "RunOperation",
    exportName: "runOperation",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      { key: "executor", kind: "jsonb", type: "ActivityExecutor" },
      {
        key: "runId",
        kind: "uuid",
        notNull: true,
        reference: { table: "run", column: "id" },
      },
      { key: "operationId", kind: "text", notNull: true },
      { key: "kind", kind: "text", notNull: true },
      { key: "inputFingerprint", kind: "text", notNull: true },
      { key: "state", kind: "text", notNull: true, default: "started" },
      { key: "result", kind: "jsonb" },
      { key: "error", kind: "text" },
      {
        key: "startedAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
      { key: "completedAt", kind: "timestamp" },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
        onUpdateNow: true,
      },
    ],
    types: [
      { module: "@cubby/schemas/activity", exports: ["ActivityExecutor"] },
    ],
    indexes: [
      {
        name: "RunOperation_run_operation_key",
        unique: true,
        on: ["runId", "operationId"],
      },
      { name: "RunOperation_run_state_idx", on: ["runId", "state"] },
    ],
    checks: [
      {
        name: "RunOperation_state_check",
        sql: "{state} IN ('started', 'paused_approval', 'completed', 'failed')",
      },
    ],
  }),
  /**
   * An agent's proposed grouping of a photo-inventory run's images, awaiting
   * human review. Approval runs the bounded `commit_photo_group` writer with
   * this row's payload; `committed`/`discarded` rows are frozen history.
   * Product and Location are real FKs so a merge can repoint and a delete can
   * detach them; the image roster, category and owner party stay in the
   * payload because images are pinned by `RunTarget` and the writer
   * re-resolves every code at approval time.
   */
  defineChildTable({
    name: "PhotoGroupProposal",
    exportName: "photoGroupProposal",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "runId",
        kind: "uuid",
        notNull: true,
        type: "RunId",
        reference: { table: "run", column: "id" },
      },
      { key: "groupKey", kind: "text", notNull: true },
      {
        key: "state",
        kind: "text",
        notNull: true,
        default: "proposed",
        type: '"proposed" | "committed" | "discarded"',
      },
      {
        key: "images",
        kind: "jsonb",
        notNull: true,
        default: { sql: "'[]'::jsonb" },
        type: '{ imageId: ImageId; purpose: "item" | "label" }[]',
      },
      {
        key: "skip",
        kind: "jsonb",
        notNull: true,
        default: { sql: "'[]'::jsonb" },
        type: "{ imageId: ImageId; reason: string }[]",
      },
      {
        key: "productKind",
        kind: "text",
        notNull: true,
        type: '"existing" | "create"',
      },
      /** The chosen existing Product, or — once committed — the Product the group attached to. */
      {
        key: "productId",
        kind: "uuid",
        type: "ProductId",
        reference: { table: "product", column: "id" },
      },
      /**
       * `commit_photo_group`'s `product.create` payload when `productKind` is
       * `create`, minus its category: that lives in `productCreateCategoryId`
       * so a merge or delete between proposing and approving is followed.
       */
      {
        key: "productCreate",
        kind: "jsonb",
        type: "CommitPhotoGroupProductCreate",
      },
      /** Category FK for a new draft or an existing Product's selected category edit. */
      {
        key: "productCreateCategoryId",
        kind: "uuid",
        type: "ProductCategoryId",
      },
      {
        key: "inventoryLocationId",
        kind: "uuid",
        type: "LocationId",
        reference: { table: "location", column: "id" },
      },
      /**
       * `commit_photo_group`'s inventory minus `locationId` and the owner, which
       * lives in `inventoryOwnerPartyId`; null = no inventory.
       */
      { key: "inventory", kind: "jsonb", type: "PhotoGroupStoredInventory" },
      {
        key: "inventoryOwnerPartyId",
        kind: "uuid",
        type: "LedgerPartyId",
        reference: { table: "ledgerParty", column: "id" },
      },
      { key: "evidence", kind: "text" },
      /** Null on legacy drafts: identity must be explicitly reviewed before approval. */
      { key: "review", kind: "jsonb", type: "PhotoGroupReview" },
      /** Last writer of the payload (`photoGroupProposalOrigin`); null = not recorded. */
      {
        key: "origin",
        kind: "text",
        type: "PhotoGroupProposalOrigin",
      },
      /** Product shortcodes that collided with a `create` name on the last approval. */
      { key: "conflictProductIds", kind: "jsonb", type: "string[]" },
      { key: "lastError", kind: "text" },
      { key: "committedAt", kind: "timestamp" },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
        onUpdateNow: true,
      },
    ],
    types: [
      {
        module: "@cubby/schemas/identifiers",
        exports: [
          "RunId",
          "ImageId",
          "ProductId",
          "ProductCategoryId",
          "LocationId",
          "LedgerPartyId",
        ],
      },
      {
        module: "@cubby/schemas/photo-import-run",
        exports: [
          "CommitPhotoGroupProductCreate",
          "PhotoGroupStoredInventory",
          "PhotoGroupProposalOrigin",
          "PhotoGroupReview",
        ],
      },
    ],
    indexes: [
      {
        name: "PhotoGroupProposal_run_group_key",
        unique: true,
        on: ["runId", "groupKey"],
      },
      { name: "PhotoGroupProposal_product_idx", on: ["productId"] },
      { name: "PhotoGroupProposal_location_idx", on: ["inventoryLocationId"] },
    ],
    checks: [
      {
        name: "PhotoGroupProposal_state_check",
        sql: "{state} IN ('proposed', 'committed', 'discarded')",
      },
      {
        name: "PhotoGroupProposal_product_kind_check",
        sql: "{productKind} IN ('existing', 'create')",
      },
      {
        name: "PhotoGroupProposal_origin_check",
        sql: "{origin} IS NULL OR {origin} IN ('coordinator', 'external_agent', 'member')",
      },
    ],
    foreignKeys: [
      // Named explicitly: Drizzle's default exceeds Postgres's 63-byte limit.
      {
        name: "PhotoGroupProposal_productCreateCategoryId_fk",
        columns: ["productCreateCategoryId"],
        table: "productCategory",
        references: ["id"],
      },
    ],
  }),
  /** Immutable record of which household member prompted, approved, or stopped a run. */
  defineChildTable({
    name: "RunControlEvent",
    exportName: "runControlEvent",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "runId",
        kind: "uuid",
        notNull: true,
        reference: { table: "run", column: "id" },
      },
      { key: "action", kind: "text", notNull: true },
      { key: "controllerUserId", kind: "text", notNull: true, type: "UserId" },
      { key: "controllerName", kind: "text", notNull: true },
      { key: "controllerEmail", kind: "text", notNull: true },
      {
        key: "controllerLedgerPartyId",
        kind: "uuid",
        notNull: true,
        type: "LedgerPartyId",
      },
      { key: "controllerLedgerPartyShortcode", kind: "text", notNull: true },
      { key: "controllerLedgerPartyName", kind: "text", notNull: true },
      { key: "controllerLedgerPartyKind", kind: "text", notNull: true },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
    ],
    types: [
      {
        module: "@cubby/schemas/identifiers",
        exports: ["UserId", "LedgerPartyId"],
      },
    ],
    indexes: [
      { name: "RunControlEvent_run_created_idx", on: ["runId", "createdAt"] },
    ],
    checks: [
      {
        name: "RunControlEvent_action_check",
        sql: "{action} IN ('prompt', 'abort', 'pause', 'resume', 'cancel', 'approve', 'reject', 'retry', 'retry_dispatch', 'upload_evidence', 'no_evidence_available', 'escalate_sol')",
      },
    ],
  }),
  /** Immutable prepared order evidence; commit decisions live in the operation ledger. */
  defineChildTable({
    name: "ImportPreparedOrder",
    exportName: "importPreparedOrder",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "runId",
        kind: "uuid",
        notNull: true,
        reference: { table: "run", column: "id" },
      },
      {
        key: "vendorId",
        kind: "uuid",
        type: "VendorId",
        reference: { table: "vendor", column: "id" },
      },
      {
        key: "targetPurchaseId",
        kind: "uuid",
        type: "PurchaseId",
        reference: { table: "purchase", column: "id" },
      },
      { key: "prepareOperationId", kind: "text", notNull: true },
      { key: "itemOperationId", kind: "text", notNull: true },
      { key: "stableOrderId", kind: "text", notNull: true },
      { key: "sourceKind", kind: "text", notNull: true },
      { key: "sourceExternalKey", kind: "text", notNull: true },
      { key: "sourceChecksum", kind: "text", notNull: true },
      { key: "evidenceChecksum", kind: "text", notNull: true },
      { key: "extractionRevision", kind: "text", notNull: true },
      { key: "extraction", kind: "jsonb", notNull: true },
      {
        key: "primaryDocumentImageId",
        kind: "uuid",
        reference: { table: "image", column: "id" },
      },
      {
        key: "screenshotImageId",
        kind: "uuid",
        reference: { table: "image", column: "id" },
      },
      { key: "targetFingerprint", kind: "text", notNull: true },
      { key: "evidenceFingerprint", kind: "text", notNull: true },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
    ],
    types: [
      {
        module: "@cubby/schemas/identifiers",
        exports: ["PurchaseId", "VendorId"],
      },
    ],
    indexes: [
      {
        name: "ImportPreparedOrder_run_item_operation_key",
        unique: true,
        on: ["runId", "itemOperationId"],
      },
      {
        name: "ImportPreparedOrder_run_stable_order_key",
        unique: true,
        on: ["runId", "stableOrderId"],
      },
      {
        name: "ImportPreparedOrder_prepare_operation_idx",
        on: ["runId", "prepareOperationId"],
      },
    ],
    checks: [
      {
        name: "ImportPreparedOrder_source_kind_check",
        sql: "{sourceKind} IN ('browser_order', 'mail_message', 'mail_attachment', 'receipt_photo', 'vendor_export')",
      },
    ],
  }),
  /** Immutable normalized line, its identifiers, and the bounded candidates shown for approval. */
  defineChildTable({
    name: "ImportPreparedLine",
    exportName: "importPreparedLine",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "preparedOrderId",
        kind: "uuid",
        notNull: true,
        reference: { table: "importPreparedOrder", column: "id" },
      },
      { key: "stableLineId", kind: "text", notNull: true },
      { key: "position", kind: "integer", notNull: true },
      { key: "line", kind: "jsonb", notNull: true },
      {
        key: "identifiers",
        kind: "jsonb",
        type: "Record<string, string>",
        notNull: true,
      },
      { key: "candidates", kind: "jsonb", notNull: true },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
    ],
    indexes: [
      {
        name: "ImportPreparedLine_order_stable_line_key",
        unique: true,
        on: ["preparedOrderId", "stableLineId"],
      },
      {
        name: "ImportPreparedLine_order_position_key",
        unique: true,
        on: ["preparedOrderId", "position"],
      },
    ],
  }),
  /** One exact human grant; commit rechecks fingerprints and consumes it transactionally. */
  defineChildTable({
    name: "RunApproval",
    exportName: "runApproval",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "runId",
        kind: "uuid",
        notNull: true,
        reference: { table: "run", column: "id" },
      },
      { key: "operationId", kind: "text", notNull: true },
      { key: "operationKind", kind: "text", notNull: true },
      { key: "args", kind: "jsonb", notNull: true },
      { key: "argsFingerprint", kind: "text", notNull: true },
      { key: "targetFingerprint", kind: "text", notNull: true },
      { key: "evidenceFingerprint", kind: "text", notNull: true },
      { key: "state", kind: "text", notNull: true, default: "pending" },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
      {
        key: "decidedByUserId",
        kind: "text",
        type: "UserId",
        reference: { table: "user", column: "id" },
      },
      { key: "decidedAt", kind: "timestamp" },
      { key: "rejectedAt", kind: "timestamp" },
      { key: "consumedAt", kind: "timestamp" },
      { key: "invalidatedAt", kind: "timestamp" },
    ],
    types: [{ module: "@cubby/schemas/identifiers", exports: ["UserId"] }],
    indexes: [
      {
        name: "RunApproval_run_operation_key",
        unique: true,
        on: ["runId", "operationId"],
      },
      { name: "RunApproval_run_state_idx", on: ["runId", "state"] },
    ],
    checks: [
      {
        name: "RunApproval_state_check",
        sql: "{state} IN ('pending', 'granted', 'rejected', 'consumed', 'invalidated')",
      },
    ],
  }),
  defineChildTable({
    name: "RunFinding",
    exportName: "runFinding",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      { key: "runId", kind: "uuid", reference: { table: "run", column: "id" } },
      {
        key: "ledgerPartyId",
        kind: "uuid",
        notNull: true,
        type: "LedgerPartyId",
        reference: { table: "ledgerParty", column: "id" },
      },
      { key: "entityId", kind: "uuid", notNull: true },
      {
        key: "entityKind",
        kind: "text",
        notNull: true,
        type: '"purchase" | "expense" | "product" | "run" | "email"',
      },
      { key: "kind", kind: "text", notNull: true },
      { key: "summary", kind: "text", notNull: true },
      { key: "proposedFix", kind: "jsonb" },
      { key: "evidenceFingerprint", kind: "text", notNull: true },
      { key: "autoApplied", kind: "boolean", notNull: true, default: false },
      { key: "probability", kind: "real" },
      { key: "status", kind: "text", notNull: true, default: "open" },
      { key: "resolvedAt", kind: "timestamp" },
      { key: "expiresAt", kind: "timestamp" },
      {
        key: "resolvedByUserId",
        kind: "text",
        reference: { table: "user", column: "id" },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
        onUpdateNow: true,
      },
    ],
    types: [
      { module: "@cubby/schemas/identifiers", exports: ["LedgerPartyId"] },
    ],
    indexes: [
      {
        name: "RunFinding_open_evidence_key",
        unique: true,
        on: [
          "ledgerPartyId",
          "entityKind",
          "entityId",
          "kind",
          "evidenceFingerprint",
        ],
        where: "{status} = 'open'",
      },
      {
        name: "RunFinding_status_idx",
        on: ["status", { column: "createdAt", desc: true }],
      },
    ],
    checks: [
      {
        name: "RunFinding_status_check",
        sql: "{status} IN ('open', 'applied', 'dismissed')",
      },
      {
        name: "RunFinding_entityKind_check",
        sql: "{entityKind} IN ('purchase', 'expense', 'product', 'run', 'email')",
      },
    ],
    foreignKeys: [
      // Findings stay live pointers (ADR 0006): a merge repoints them and a
      // removal deletes them, so the FK always names a live identity.
      {
        name: "RunFinding_entity_fk",
        columns: ["entityId", "entityKind"],
        table: "entityIdentity",
        references: ["id", "kind"],
      },
    ],
  }),
  defineChildTable({
    name: "AiEvaluation",
    exportName: "aiEvaluation",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "runId",
        kind: "uuid",
        type: "RunId",
        notNull: true,
        reference: { table: "run", column: "id" },
      },
      { key: "workKey", kind: "text", notNull: true },
      { key: "shareKey", kind: "text" },
      {
        key: "executionKind",
        kind: "text",
        type: "AiExecutionKind",
        notNull: true,
        default: "ai_refresh",
      },
      { key: "restarts", kind: "integer", notNull: true, default: 0 },
      { key: "feature", kind: "text", notNull: true },
      {
        key: "target",
        kind: "jsonb",
        notNull: true,
        type: "AiEvaluationTarget",
      },
      { key: "provenance", kind: "jsonb", notNull: true, type: "AiProvenance" },
      { key: "snapshot", kind: "jsonb", notNull: true },
      { key: "state", kind: "text", notNull: true, default: "queued" },
      { key: "attempts", kind: "integer", notNull: true, default: 0 },
      { key: "runAttempt", kind: "integer", notNull: true, default: 0 },
      { key: "attemptToken", kind: "uuid" },
      { key: "deadlineAt", kind: "timestamp" },
      { key: "nextAttemptAt", kind: "timestamp" },
      { key: "result", kind: "jsonb" },
      { key: "receipt", kind: "jsonb" },
      { key: "error", kind: "text" },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
        onUpdateNow: true,
      },
    ],
    types: [
      {
        module: "@cubby/schemas/ai-evaluation",
        exports: ["AiEvaluationTarget", "AiProvenance", "AiExecutionKind"],
      },
      { module: "@cubby/schemas/identifiers", exports: ["RunId"] },
    ],
    indexes: [
      { name: "AiEvaluation_work_key", unique: true, on: ["workKey"] },
      {
        name: "AiEvaluation_pending_share_key",
        unique: true,
        on: ["shareKey"],
        where:
          "{shareKey} IS NOT NULL AND {state} IN ('queued','running','result_ready','retry_wait')",
      },
      {
        name: "AiEvaluation_admission_idx",
        on: ["executionKind", "state", "deadlineAt"],
      },
      {
        name: "AiEvaluation_run_state_idx",
        on: ["runId", "state", "nextAttemptAt"],
      },
      { name: "AiEvaluation_feature_idx", on: ["feature"] },
    ],
    checks: [
      {
        name: "AiEvaluation_execution_kind_check",
        sql: "{executionKind} IN ('ai_refresh','mail_reclassify','suggestion_sweep','mail_discovery')",
      },
      {
        name: "AiEvaluation_state_check",
        sql: "{state} IN ('queued','running','result_ready','retry_wait','completed','blocked','failed','obsolete','cancelled')",
      },
    ],
  }),
  defineChildTable({
    name: "AiEvaluationRequest",
    exportName: "aiEvaluationRequest",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "runId",
        kind: "uuid",
        type: "RunId",
        notNull: true,
        reference: { table: "run", column: "id" },
      },
      {
        key: "evaluationId",
        kind: "uuid",
        notNull: true,
        reference: { table: "aiEvaluation", column: "id" },
      },
      { key: "sequence", kind: "integer", notNull: true, default: 0 },
      { key: "cancelledAt", kind: "timestamp" },
      { key: "receipt", kind: "jsonb" },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
    ],
    types: [{ module: "@cubby/schemas/identifiers", exports: ["RunId"] }],
    indexes: [
      {
        name: "AiEvaluationRequest_run_item_key",
        unique: true,
        on: ["runId", "evaluationId"],
      },
      { name: "AiEvaluationRequest_evaluation_idx", on: ["evaluationId"] },
    ],
  }),
  /**
   * An APNs registration an Apple install made for a Run it created: a Live
   * Activity push token (`live_activity`) or its opt-in alert device token
   * (`alert`). The install is `Run.deviceId` (the initiator), never an
   * executor. `pushToken` is an APNs credential: written here, read only by
   * the push sender.
   */
  defineChildTable({
    name: "RunPushRegistration",
    exportName: "runPushRegistration",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "runId",
        kind: "uuid",
        notNull: true,
        type: "RunId",
        reference: { table: "run", column: "id", onDelete: "cascade" },
      },
      {
        key: "deviceId",
        kind: "uuid",
        notNull: true,
        type: "DeviceId",
        reference: { table: "device", column: "id", onDelete: "cascade" },
      },
      {
        key: "kind",
        kind: "text",
        notNull: true,
        type: "RunPushKind",
      },
      { key: "pushToken", kind: "text", notNull: true },
      {
        key: "apnsEnvironment",
        kind: "text",
        notNull: true,
        type: "ApnsEnvironment",
      },
      /** The registering app build; its bundle id is the APNs topic. */
      {
        key: "appIdentity",
        kind: "text",
        notNull: true,
        type: "PhotoRunPushAppIdentity",
      },
      /**
       * `live_activity`: fingerprint of the last content-state delivered,
       * never resent unchanged. `alert`: the last phase and cumulative planned
       * photo count, so late results cannot cross upload batches.
       */
      { key: "lastStateKey", kind: "text" },
      { key: "lastSentAt", kind: "timestamp" },
      /** APNs status and reason of the last failed delivery, verbatim. */
      { key: "lastError", kind: "text" },
      { key: "endedAt", kind: "timestamp" },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
      {
        key: "updatedAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
        onUpdateNow: true,
      },
    ],
    types: [
      {
        module: "@cubby/schemas/identifiers",
        exports: ["RunId", "DeviceId"],
      },
      {
        module: "@cubby/schemas/photo-import-run",
        exports: ["RunPushKind", "ApnsEnvironment", "PhotoRunPushAppIdentity"],
      },
    ],
    indexes: [
      {
        name: "RunPushRegistration_run_device_kind_key",
        unique: true,
        on: ["runId", "deviceId", "kind"],
      },
      { name: "RunPushRegistration_device_idx", on: ["deviceId"] },
    ],
    checks: [
      {
        name: "RunPushRegistration_kind_check",
        sql: "{kind} IN ('live_activity', 'alert')",
      },
      {
        name: "RunPushRegistration_environment_check",
        sql: "{apnsEnvironment} IN ('development', 'production')",
      },
      {
        name: "RunPushRegistration_app_identity_check",
        sql: `{appIdentity} IN (${Object.keys(APPLE_APP_IDENTITIES)
          .map((key) => `'${key}'`)
          .join(", ")})`,
      },
    ],
  }),
];
