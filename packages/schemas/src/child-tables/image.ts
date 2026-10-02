import { defineChildTable } from "../entity-definitions/child-definition.js";

export const imageChildren = [
  /** One report of a stored Image appearing in a member's photo library or
   * cloud asset; see ADR 0005. A child of its Image, not an entity: it has no
   * shortcode or identity row, and its audit history lives on the Image. */
  defineChildTable({
    name: "ImageSighting",
    exportName: "imageSighting",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "imageId",
        kind: "uuid",
        notNull: true,
        reference: { table: "image", column: "id", onDelete: "cascade" },
      },
      {
        key: "ledgerPartyId",
        kind: "uuid",
        type: "LedgerPartyId",
        notNull: true,
        reference: { table: "ledgerParty", column: "id" },
      },
      {
        key: "deviceId",
        kind: "uuid",
        type: "DeviceId",
        notNull: true,
        reference: { table: "device", column: "id" },
      },
      { key: "assetKey", kind: "text", notNull: true },
      { key: "cloudIdentifier", kind: "text" },
      { key: "localIdentifier", kind: "text" },
      {
        key: "sourceType",
        kind: "text",
        values: ["userLibrary", "cloudShared", "iTunesSynced"],
        notNull: true,
      },
      {
        key: "mediaSubtypes",
        kind: "text",
        array: true,
        notNull: true,
        default: { sql: "'{}'::text[]" },
      },
      { key: "originalFilename", kind: "text" },
      { key: "pixelWidth", kind: "integer" },
      { key: "pixelHeight", kind: "integer" },
      { key: "hasAdjustments", kind: "boolean", notNull: true, default: false },
      { key: "capturedAt", kind: "timestamp" },
      { key: "capturedAtOffsetMinutes", kind: "integer" },
      { key: "addedAt", kind: "timestamp" },
      { key: "location", kind: "jsonb", type: "ImageSightingLocation | null" },
      { key: "placeName", kind: "text" },
      { key: "camera", kind: "jsonb", type: "ImageSightingCamera | null" },
      {
        key: "matchKind",
        kind: "text",
        values: ["import", "libraryMatch"],
        notNull: true,
      },
      { key: "hashDistance", kind: "integer" },
      { key: "aspectGate", kind: "boolean" },
      { key: "observedAt", kind: "timestamp", notNull: true },
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
      { key: "deletedAt", kind: "timestamp" },
    ],
    types: [
      {
        module: "@cubby/schemas/identifiers",
        exports: ["LedgerPartyId", "DeviceId"],
      },
      {
        module: "@cubby/schemas/image-sighting-fields",
        exports: ["ImageSightingLocation", "ImageSightingCamera"],
      },
    ],
    indexes: [
      {
        name: "ImageSighting_image_party_asset_key",
        unique: true,
        on: ["imageId", "ledgerPartyId", "assetKey"],
        where: "{deletedAt} IS NULL",
      },
      { name: "ImageSighting_imageId_idx", on: ["imageId"] },
      { name: "ImageSighting_ledgerPartyId_idx", on: ["ledgerPartyId"] },
      { name: "ImageSighting_deviceId_idx", on: ["deviceId"] },
    ],
    checks: [
      {
        name: "ImageSighting_sourceType_check",
        sql: "{sourceType} IN ('userLibrary', 'cloudShared', 'iTunesSynced')",
      },
      {
        name: "ImageSighting_matchKind_check",
        sql: "{matchKind} IN ('import', 'libraryMatch')",
      },
    ],
  }),
];
