import type { EntityFieldModelMetadata } from "./definition";

/** Receipt-backed provenance for declared automatic fill fields, without a list column. */
export const automaticFields = (
  entity: string,
  table: string,
): EntityFieldModelMetadata["stored"][string] => ({
  publishes: "value",
  dependsOn: [],
  compute: `${entity}.automaticFields`,
  inputs: [
    { table, match: { id: "id" } },
    {
      table: "AssessmentState",
      match: { recordId: "id" },
      where: { entity, family: "field" },
    },
    {
      table: "Assessment",
      match: { id: "id" },
      where: { family: "field" },
      path: [
        {
          table: "AssessmentState",
          from: "id",
          to: "recordId",
          where: { entity, family: "field" },
        },
      ],
    },
    {
      table: "Feedback",
      match: { assessmentId: "id" },
      path: [
        {
          table: "AssessmentState",
          from: "id",
          to: "recordId",
          where: { entity, family: "field" },
        },
      ],
    },
    {
      table: "AuditLog",
      match: { entityId: "id" },
      where: { entityKind: entity },
    },
  ],
});
