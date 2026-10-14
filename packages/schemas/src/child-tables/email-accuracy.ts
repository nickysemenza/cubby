import { defineChildTable } from "../entity-definitions/child-definition.js";

/** A frozen probability sample and append-only independent grades never alter routing. */
export const emailAccuracyChildren = [
  defineChildTable({
    name: "EmailAccuracyEvaluation",
    exportName: "emailAccuracyEvaluation",
    columns: [
      {
        key: "id",
        kind: "uuid",
        primaryKey: true,
        default: { sql: "gen_random_uuid()" },
      },
      {
        key: "ownerUserId",
        kind: "text",
        notNull: true,
        type: "UserId",
        reference: { table: "user", column: "id" },
      },
      { key: "requestedSampleSize", kind: "integer", notNull: true },
      { key: "populationCount", kind: "integer", notNull: true },
      { key: "sampleSize", kind: "integer", notNull: true },
      {
        key: "roster",
        kind: "jsonb",
        notNull: true,
        type: "EmailAccuracyRoster",
      },
      {
        key: "createdAt",
        kind: "timestamp",
        notNull: true,
        default: { now: true },
      },
    ],
    types: [
      { module: "@cubby/schemas/identifiers", exports: ["UserId"] },
      {
        module: "@cubby/schemas/email-accuracy",
        exports: ["EmailAccuracyRoster"],
      },
    ],
    indexes: [
      {
        name: "EmailAccuracyEvaluation_owner_idx",
        on: ["ownerUserId", { column: "createdAt", desc: true }],
      },
    ],
    checks: [
      {
        name: "EmailAccuracyEvaluation_size_check",
        sql: "{requestedSampleSize} BETWEEN 1 AND 1000 AND {populationCount} >= 0 AND {sampleSize} BETWEEN 0 AND {requestedSampleSize} AND {sampleSize} <= {populationCount}",
      },
    ],
  }),
];
