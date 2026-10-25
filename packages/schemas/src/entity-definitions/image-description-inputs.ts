import type { DerivedStoredInput } from "./definition";

/** Search indexes selected descriptions on direct attachments, including corrections. */
export const imageDescriptionInputs = (
  entityKind: string,
): DerivedStoredInput[] => {
  const owners = [
    {
      table: "EntityAttachment",
      from: "imageId",
      to: "entityId",
      where: { entityKind },
    },
  ];
  return [
    {
      table: "AiAnalysis",
      match: { entityId: "id" },
      where: { entityKind: "image", feature: "image-description" },
      path: owners,
    },
    {
      table: "AssessmentState",
      match: { recordId: "id" },
      where: { family: "image_description" },
      path: owners,
    },
    {
      table: "Assessment",
      match: { subject: "id" },
      json: { key: "recordId" },
      where: { family: "image_description" },
      path: owners,
    },
    {
      table: "Feedback",
      match: { assessmentId: "id" },
      path: [
        { table: "AssessmentState", from: "id", to: "recordId" },
        ...owners,
      ],
    },
    {
      table: "Image",
      match: { id: "id" },
      columns: ["sha256", "deletedAt"],
      path: owners,
    },
  ];
};
