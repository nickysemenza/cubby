import { defineChildTable } from "../entity-definitions/child-definition.js";
import { runEvidenceKind, runTargetEntityKind } from "../run-fields.js";

export const runChildren = [
  /** An exposure precedes even a source heading; no source content is copied here. */
  defineChildTable({
    name: "ResearchSourceExposure",
    exportName: "researchSourceExposure",
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
        key: "ledgerPartyId",
        kind: "uuid",
        notNull: true,
        type: "LedgerPartyId",
        reference: { table: "ledgerParty", column: "id" },
      },
      // A source tombstone must survive deletion of its private original.
      { key: "orderMailId", kind: "uuid", notNull: true },
      { key: "checksum", kind: "text", notNull: true },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
    ],
    types: [
      { module: "@cubby/schemas/identifiers", exports: ["LedgerPartyId"] },
    ],
    indexes: [
      {
        name: "ResearchSourceExposure_run_source_key",
        unique: true,
        on: ["runId", "orderMailId", "checksum"],
      },
      {
        name: "ResearchSourceExposure_source_idx",
        on: ["ledgerPartyId", "orderMailId", "checksum"],
      },
    ],
  }),
  /** External receipt survives disposal of every contaminated coordinator. */
  defineChildTable({
    name: "ResearchRetention",
    exportName: "researchRetention",
    columns: [
      { key: "id", kind: "uuid", primaryKey: true },
      {
        key: "runId",
        kind: "uuid",
        notNull: true,
        reference: { table: "run", column: "id" },
      },
      {
        key: "workRef",
        kind: "uuid",
        notNull: true,
        reference: { table: "runTarget", column: "id" },
      },
      {
        key: "ledgerPartyId",
        kind: "uuid",
        notNull: true,
        type: "LedgerPartyId",
        reference: { table: "ledgerParty", column: "id" },
      },
      { key: "orderMailId", kind: "uuid", notNull: true },
      { key: "mailboxId", kind: "text", notNull: true },
      { key: "messageId", kind: "text", notNull: true },
      { key: "checksum", kind: "text", notNull: true },
      {
        key: "phase",
        kind: "text",
        notNull: true,
        type: "ResearchRetentionPhase",
      },
      {
        key: "plan",
        kind: "jsonb",
        notNull: true,
        type: "ResearchRetentionPlan",
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
      { key: "completedAt", kind: "timestamp" },
    ],
    types: [
      { module: "@cubby/schemas/identifiers", exports: ["LedgerPartyId"] },
      {
        module: "@cubby/schemas/run-fields",
        exports: ["ResearchRetentionPhase", "ResearchRetentionPlan"],
      },
    ],
    indexes: [
      {
        name: "ResearchRetention_source_checksum_key",
        unique: true,
        on: ["ledgerPartyId", "orderMailId", "checksum"],
      },
      { name: "ResearchRetention_phase_idx", on: ["phase"] },
    ],
    checks: [
      {
        name: "ResearchRetention_phase_check",
        sql: "{phase} IN ('fenced', 'objects_deleted', 'coordinators_destroyed', 'completed')",
      },
    ],
  }),
  /**
   * Explicit no-op-validation/enrichment targets; the Run's writes are
   * AuditLog rows carrying its `runId`. A target names a purchase, product or image by `entityRef`;
   * the composite FK targets `Entity`, whose rows outlive a hard delete, so a
   * target keeps its tombstone the way the old Purchase FK's policy asked.
   */
  defineChildTable({
    name: "RunTarget",
    exportName: "runTarget",
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
      { key: "entityId", kind: "uuid", notNull: true },
      /** Distinct source work can address the same entity without sharing a task. */
      { key: "workKey", kind: "text", notNull: true, default: "" },
      {
        key: "entityKind",
        kind: "text",
        notNull: true,
        type: "RunTargetEntityKind",
      },
      /** Picker order within a photo-inventory run; the tiebreak when capture times collide. */
      { key: "position", kind: "integer" },
      {
        key: "vendorAccountId",
        kind: "uuid",
        reference: { table: "vendorAccount", column: "id" },
      },
      { key: "sourceKind", kind: "text" },
      { key: "sourceExternalKey", kind: "text" },
      { key: "state", kind: "text", notNull: true, default: "pending" },
      { key: "targetFingerprint", kind: "text", notNull: true },
      { key: "evidenceFingerprint", kind: "text" },
      { key: "outcome", kind: "text" },
      { key: "warning", kind: "text" },
      { key: "diff", kind: "jsonb" },
      { key: "preparedAt", kind: "timestamp" },
      { key: "completedAt", kind: "timestamp" },
      /**
       * Device-side processing state for a photo-run image target, reported by
       * `run.reportDeviceWork`. Null means no device has picked up this photo
       * yet; distinct from `state` (the server-side prepare/complete pipeline).
       */
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
        module: "@cubby/schemas/run-fields",
        exports: ["RunTargetEntityKind"],
      },
      {
        module: "@cubby/schemas/photo-import-run",
        exports: ["RunTargetDeviceWorkState"],
      },
      { module: "@cubby/schemas/identifiers", exports: ["DeviceId"] },
    ],
    indexes: [
      { name: "RunTarget_run_idx", on: ["runId"] },
      // The target's own lookups (product/purchase/image merge and delete).
      { name: "RunTarget_entity_idx", on: ["entityId"] },
      {
        name: "RunTarget_deviceWorkDeviceId_idx",
        on: ["deviceWorkDeviceId"],
        where: "{deviceWorkDeviceId} IS NOT NULL",
      },
      {
        name: "RunTarget_run_entity_key",
        unique: true,
        on: ["runId", "entityId", "workKey"],
      },
    ],
    checks: [
      {
        name: "RunTarget_entityKind_check",
        sql: "{entityKind} IN ('purchase', 'product', 'image', 'run')",
      },
      {
        name: "RunTarget_state_check",
        sql: "{state} IN ('pending', 'prepared', 'completed', 'skipped', 'unresolved', 'needs_evidence', 'unavailable')",
      },
      {
        name: "RunTarget_outcome_check",
        sql: "{outcome} IS NULL OR {outcome} IN ('replayed', 'raw_evidence_drift', 'semantic_drift', 'enriched', 'unavailable', 'skipped', 'attached', 'verified', 'partially_verified', 'researched_with_gaps', 'ambiguous', 'temporarily_blocked', 'no_source_found', 'unrelated')",
      },
      {
        name: "RunTarget_deviceWorkState_check",
        sql: "{deviceWorkState} IS NULL OR {deviceWorkState} IN ('queued', 'running', 'paused', 'failed', 'completed')",
      },
    ],
    foreignKeys: [
      {
        name: "RunTarget_entity_fk",
        columns: ["entityId", "entityKind"],
        table: "entityIdentity",
        references: ["id", "kind"],
      },
    ],
  }),
  /**
   * The orders an account-sync run saw on the vendor's order-history pages. A
   * row is a worklist item, not evidence: `claim_next_import_work` hands the
   * oldest `pending` one to the coordinator, and `ordersSeen` counts these rows
   * rather than commits. No vendorAccount FK: the run already carries it.
   */
  defineChildTable({
    name: "RunOrderCandidate",
    exportName: "runOrderCandidate",
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
      { key: "orderId", kind: "text", notNull: true },
      { key: "orderUrl", kind: "text" },
      { key: "orderedAt", kind: "date" },
      { key: "state", kind: "text", notNull: true, default: "pending" },
      {
        key: "listedAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
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
    indexes: [
      {
        name: "RunOrderCandidate_run_order_key",
        unique: true,
        on: ["runId", "orderId"],
      },
      { name: "RunOrderCandidate_run_state_idx", on: ["runId", "state"] },
    ],
    checks: [
      {
        name: "RunOrderCandidate_state_check",
        sql: "{state} IN ('pending', 'covered', 'imported', 'skipped')",
      },
    ],
  }),
  /**
   * Immutable R2-backed evidence of a run, never a shared Image. A targeted
   * run's evidence names its target; an account sync's captured pages (the
   * DOM the Mac sent) belong to the run alone.
   */
  defineChildTable({
    name: "RunEvidence",
    exportName: "runEvidence",
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
        key: "targetId",
        kind: "uuid",
        reference: { table: "runTarget", column: "id" },
      },
      { key: "kind", kind: "text", notNull: true },
      { key: "objectKey", kind: "text", notNull: true },
      { key: "checksum", kind: "text", notNull: true },
      { key: "mediaType", kind: "text", notNull: true },
      { key: "byteSize", kind: "integer" },
      {
        key: "sourceMetadata",
        kind: "jsonb",
        notNull: true,
        default: { sql: "'{}'::jsonb" },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
    ],
    indexes: [
      {
        name: "RunEvidence_object_key_unique",
        unique: true,
        on: ["objectKey"],
      },
      { name: "RunEvidence_run_target_idx", on: ["runId", "targetId"] },
    ],
    checks: [
      {
        name: "RunEvidence_kind_check",
        sql: `{kind} IN (${runEvidenceKind.options.map((kind) => `'${kind}'`).join(", ")})`,
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
    ],
  }),
  /** Accepted facts retain evidence even when the existing value was already correct. */
  defineChildTable({
    name: "RunFactEvidence",
    exportName: "runFactEvidence",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "targetId",
        kind: "uuid",
        notNull: true,
        reference: { table: "runTarget", column: "id" },
      },
      {
        key: "evidenceId",
        kind: "uuid",
        notNull: true,
        reference: { table: "runEvidence", column: "id" },
      },
      {
        key: "entityKind",
        kind: "text",
        notNull: true,
        type: "RunTargetEntityKind",
      },
      { key: "entityId", kind: "uuid", notNull: true },
      { key: "fieldPath", kind: "text", notNull: true },
      {
        key: "value",
        kind: "jsonb",
        notNull: true,
        type: 'AcceptedResearchFact["value"]',
      },
      { key: "valueFingerprint", kind: "text", notNull: true },
      {
        key: "support",
        kind: "jsonb",
        type: "ResearchClaimSupport",
      },
      { key: "supportRetiredAt", kind: "timestamp" },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
    ],
    types: [
      { module: "@cubby/schemas/run-fields", exports: ["RunTargetEntityKind"] },
      {
        module: "@cubby/schemas/research",
        exports: ["ResearchClaimSupport", "AcceptedResearchFact"],
      },
    ],
    indexes: [
      {
        name: "RunFactEvidence_claim_key",
        unique: true,
        on: [
          "targetId",
          "evidenceId",
          "entityKind",
          "entityId",
          "fieldPath",
          "valueFingerprint",
        ],
      },
      { name: "RunFactEvidence_subject_idx", on: ["entityKind", "entityId"] },
    ],
    checks: [
      {
        name: "RunFactEvidence_entityKind_check",
        sql: `{entityKind} IN (${runTargetEntityKind.options.map((kind) => `'${kind}'`).join(", ")})`,
      },
      {
        name: "RunFactEvidence_support_retirement_check",
        sql: "({support} IS NOT NULL AND {supportRetiredAt} IS NULL) OR ({support} IS NULL AND {supportRetiredAt} IS NOT NULL)",
      },
    ],
    foreignKeys: [
      {
        name: "RunFactEvidence_entity_fk",
        columns: ["entityId", "entityKind"],
        table: "entityIdentity",
        references: ["id", "kind"],
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
        exports: ["CommitPhotoGroupProductCreate", "PhotoGroupStoredInventory"],
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
  /** Durable progress events for the agent and other background Runs. */
  defineChildTable({
    name: "RunProgress",
    exportName: "runProgress",
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
      { key: "eventId", kind: "text", notNull: true },
      { key: "phase", kind: "text", notNull: true },
      { key: "currentItem", kind: "text" },
      {
        key: "awaitingApproval",
        kind: "boolean",
        notNull: true,
        default: false,
      },
      { key: "detail", kind: "text" },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
    ],
    indexes: [
      { name: "RunProgress_eventId_unique", unique: true, on: ["eventId"] },
      {
        name: "RunProgress_run_created_idx",
        on: ["runId", { column: "createdAt", desc: true }],
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
    types: [{ module: "@cubby/schemas/identifiers", exports: ["PurchaseId"] }],
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
        type: '"purchase" | "expense" | "product" | "run"',
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
        sql: "{entityKind} IN ('purchase', 'expense', 'product', 'run')",
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
    name: "ImportHunt",
    exportName: "importHunt",
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
        key: "financialTransactionId",
        kind: "uuid",
        notNull: true,
        type: "FinancialTransactionId",
        reference: { table: "financialTransaction", column: "id" },
      },
      {
        key: "vendorId",
        kind: "uuid",
        type: "VendorId",
        reference: { table: "vendor", column: "id" },
      },
      {
        key: "vendorAccountId",
        kind: "uuid",
        reference: { table: "vendorAccount", column: "id" },
      },
      { key: "state", kind: "text", notNull: true, default: "pending_mail" },
      { key: "dateFrom", kind: "date", notNull: true },
      { key: "dateTo", kind: "date", notNull: true },
      { key: "attempts", kind: "integer", notNull: true, default: 0 },
      {
        key: "matchedOrderIds",
        kind: "jsonb",
        type: "string[]",
        notNull: true,
        default: { sql: "'[]'::jsonb" },
      },
      { key: "error", kind: "text" },
      {
        key: "receiptImageId",
        kind: "uuid",
        reference: { table: "image", column: "id" },
      },
      {
        key: "receiptRunId",
        kind: "uuid",
        reference: { table: "run", column: "id" },
      },
      { key: "receiptQueuedAt", kind: "timestamp" },
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
        exports: ["LedgerPartyId", "FinancialTransactionId", "VendorId"],
      },
    ],
    indexes: [
      {
        name: "ImportHunt_transaction_key",
        unique: true,
        on: ["financialTransactionId"],
      },
      { name: "ImportHunt_worklist_idx", on: ["state", "updatedAt"] },
      {
        name: "ImportHunt_receipt_image_key",
        unique: true,
        on: ["id", "receiptImageId"],
        where: "{receiptImageId} IS NOT NULL",
      },
      { name: "ImportHunt_receipt_run_idx", on: ["receiptRunId"] },
    ],
  }),
];
