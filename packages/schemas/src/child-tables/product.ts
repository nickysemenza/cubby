import { defineChildTable } from "../entity-definitions/child-definition.js";

export const productChildren = [
  defineChildTable({
    name: "ProductUnitMapping",
    exportName: "productUnitMappings",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "productId",
        kind: "uuid",
        notNull: true,
        type: "ProductId",
        reference: { table: "product", column: "id" },
      },
      { key: "aValue", kind: "doublePrecision", notNull: true },
      { key: "aUnit", kind: "text", notNull: true },
      { key: "bValue", kind: "doublePrecision", notNull: true },
      { key: "bUnit", kind: "text", notNull: true },
      { key: "source", kind: "text" },
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
    types: [{ module: "@cubby/schemas/identifiers", exports: ["ProductId"] }],
    indexes: [{ name: "ProductUnitMapping_productId_idx", on: ["productId"] }],
    relations: [
      {
        name: "product",
        kind: "one",
        table: "product",
        fields: ["productId"],
        references: ["id"],
      },
    ],
  }),
  /**
   * Rebuildable conversion-coverage projection. The conversion engine remains
   * WASM; this table only makes its catalog-wide result filterable/sortable
   * without evaluating a graph for a paginated list page.
   */
  defineChildTable({
    name: "ProductConversionCoverage",
    exportName: "productConversionCoverage",
    columns: [
      {
        key: "productId",
        kind: "uuid",
        primaryKey: true,
        type: "ProductId",
        reference: { table: "product", column: "id", onDelete: "cascade" },
      },
      { key: "coverageTier", kind: "text", notNull: true },
      {
        key: "coveredKinds",
        kind: "text",
        array: true,
        notNull: true,
        default: { sql: "'{}'::text[]" },
      },
      {
        key: "applicableKinds",
        kind: "text",
        array: true,
        notNull: true,
        default: { sql: "'{}'::text[]" },
      },
      { key: "islandCount", kind: "integer", notNull: true, default: 0 },
      // A mutation marks the row stale until the shared conversion engine has
      // rebuilt it. Query filters intentionally only read ready rows.
      { key: "status", kind: "text", notNull: true, default: "ready" },
      { key: "engineVersion", kind: "text", notNull: true },
      { key: "computedAt", kind: "timestamp", notNull: true },
    ],
    types: [{ module: "@cubby/schemas/identifiers", exports: ["ProductId"] }],
    indexes: [
      { name: "ProductConversionCoverage_tier_idx", on: ["coverageTier"] },
      { name: "ProductConversionCoverage_island_idx", on: ["islandCount"] },
      { name: "ProductConversionCoverage_status_idx", on: ["status"] },
    ],
    relations: [
      {
        name: "product",
        kind: "one",
        table: "product",
        fields: ["productId"],
        references: ["id"],
      },
    ],
  }),
];
