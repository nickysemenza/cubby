import { defineChildTable } from "../entity-definitions/child-definition.js";

export const shipmentChildren = [
  defineChildTable({
    name: "ShipmentSourceCapture",
    exportName: "shipmentSourceCapture",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      { key: "sourceKey", kind: "text", notNull: true },
      { key: "checksum", kind: "text", notNull: true },
      { key: "originalContent", kind: "jsonb", type: "RetainedMailContent" },
      {
        key: "source",
        kind: "jsonb",
        notNull: true,
        type: "ShipmentEvidenceSource",
      },
      {
        key: "emailId",
        kind: "uuid",
        reference: { table: "email", column: "id" },
      },
      {
        key: "actorUserId",
        kind: "text",
        notNull: true,
        reference: { table: "user", column: "id" },
      },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
    ],
    types: [
      {
        module: "@cubby/schemas/shipment-evidence",
        exports: ["ShipmentEvidenceSource"],
      },
      {
        module: "@cubby/schemas/mailbox-research",
        exports: ["RetainedMailContent"],
      },
    ],
    indexes: [
      {
        name: "ShipmentSourceCapture_source_checksum_key",
        unique: true,
        on: ["sourceKey", "checksum"],
      },
    ],
  }),
  defineChildTable({
    name: "ShipmentSourcePackage",
    exportName: "shipmentSourcePackage",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "shipmentId",
        kind: "uuid",
        notNull: true,
        type: "ShipmentId",
        reference: { table: "shipment", column: "id" },
      },
      { key: "sourceKey", kind: "text", notNull: true },
      { key: "packageKey", kind: "text", notNull: true },
    ],
    types: [{ module: "@cubby/schemas/identifiers", exports: ["ShipmentId"] }],
    indexes: [
      {
        name: "ShipmentSourcePackage_source_package_key",
        unique: true,
        on: ["sourceKey", "packageKey"],
      },
      { name: "ShipmentSourcePackage_shipment_idx", on: ["shipmentId"] },
    ],
  }),
  defineChildTable({
    name: "ShipmentObservation",
    exportName: "shipmentObservation",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "shipmentId",
        kind: "uuid",
        notNull: true,
        type: "ShipmentId",
        reference: { table: "shipment", column: "id" },
      },
      {
        key: "sourceCaptureId",
        kind: "uuid",
        notNull: true,
        reference: { table: "shipmentSourceCapture", column: "id" },
      },
      { key: "sourceKey", kind: "text", notNull: true },
      {
        key: "sourcePackageId",
        kind: "uuid",
        notNull: true,
        reference: { table: "shipmentSourcePackage", column: "id" },
      },
      { key: "sourceEventKey", kind: "text" },
      { key: "occurrenceKey", kind: "text", notNull: true },
      { key: "fingerprint", kind: "text", notNull: true },
      { key: "memberReviewed", kind: "boolean", notNull: true, default: false },
      {
        key: "event",
        kind: "jsonb",
        notNull: true,
        type: "ShipmentObservationInput",
      },
      { key: "firstSeenAt", kind: "timestamp", notNull: true },
      { key: "lastSeenAt", kind: "timestamp", notNull: true },
      {
        key: "supersededById",
        kind: "uuid",
        reference: { table: "shipmentObservation", column: "id" },
      },
    ],
    types: [
      { module: "@cubby/schemas/identifiers", exports: ["ShipmentId"] },
      {
        module: "@cubby/schemas/shipment-evidence",
        exports: ["ShipmentObservationInput"],
      },
    ],
    indexes: [
      {
        name: "ShipmentObservation_source_fingerprint_idx",
        on: ["shipmentId", "sourceKey", "fingerprint"],
      },
      { name: "ShipmentObservation_shipment_idx", on: ["shipmentId"] },
    ],
  }),
  defineChildTable({
    name: "ShipmentObservationCapture",
    exportName: "shipmentObservationCapture",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "observationId",
        kind: "uuid",
        notNull: true,
        reference: { table: "shipmentObservation", column: "id" },
      },
      {
        key: "captureId",
        kind: "uuid",
        notNull: true,
        reference: { table: "shipmentSourceCapture", column: "id" },
      },
      { key: "firstSeenAt", kind: "timestamp", notNull: true },
      { key: "lastSeenAt", kind: "timestamp", notNull: true },
    ],
    indexes: [
      {
        name: "ShipmentObservationCapture_observation_capture_key",
        unique: true,
        on: ["observationId", "captureId"],
      },
    ],
  }),
];
