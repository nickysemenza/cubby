import { SYSTEM_USER_ID } from "../identifier-fields";
import type { DerivedStoredInput } from "./definition";

/**
 * Only an automatic correction receipt can change selected description text.
 * `currentImageDescriptionConfirmation` and `indexCorrectionReceipts` require
 * these literals; change them together. Member and projection Feedback reach
 * search through their Suggestion transition.
 */
export const imageDescriptionReceiptWhere = {
  authority: "automatic",
  intent: "history",
  actorUserId: SYSTEM_USER_ID,
};

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
      table: "Suggestion",
      match: { recordId: "id" },
      where: { family: "image_description" },
      path: owners,
    },
    {
      table: "Suggestion",
      match: { subject: "id" },
      json: { key: "recordId" },
      where: { family: "image_description" },
      path: owners,
    },
    {
      // Decisions live on the Suggestion, whose own input above captures them.
      table: "Suggestion",
      capture: false,
      match: { id: "id" },
      path: [{ table: "Suggestion", from: "id", to: "recordId" }, ...owners],
    },
    {
      table: "Image",
      match: { id: "id" },
      columns: ["sha256", "deletedAt"],
      path: owners,
    },
  ];
};

type AttachedImageInput = Required<
  Pick<DerivedStoredInput, "table" | "match" | "columns" | "path">
>;

/**
 * An owner's attachment rows and their Images, for checks on displayable images.
 * A tuple, because declaration inference cannot follow two array spreads in one list.
 */
export const attachedImageInputs = (
  path: NonNullable<DerivedStoredInput["path"]>,
): [AttachedImageInput, AttachedImageInput] => [
  {
    table: "EntityAttachment",
    match: { entityId: "id" },
    columns: ["deletedAt", "imageId", "purpose", "role"],
    path,
  },
  {
    table: "Image",
    match: { id: "id" },
    columns: [
      "deletedAt",
      "renderStatus",
      "storageStatus",
      "detectedContentType",
    ],
    path: [
      { table: "EntityAttachment", from: "imageId", to: "entityId" },
      ...path,
    ],
  },
];
