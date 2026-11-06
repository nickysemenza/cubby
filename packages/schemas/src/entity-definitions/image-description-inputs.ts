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
      table: "Image",
      match: { id: "id" },
      columns: [
        "sha256",
        "deletedAt",
        "confirmedDescription",
        "descriptionContentHash",
        "descriptionConfirmedAt",
        "descriptionConfirmationOwner",
      ],
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
