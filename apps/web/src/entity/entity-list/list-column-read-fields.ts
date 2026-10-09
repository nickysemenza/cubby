import { type BrowserRoutedEntity } from "@cubby/schemas/entity-index";

import { entityFieldModel } from "~/entity/entity-model";

export function listColumnReadFields(
  entity: BrowserRoutedEntity,
  columnId: string,
): string[] {
  if (columnId === "image" || columnId === "images")
    return ["displayImages", "images"];
  const field = entityFieldModel(entity).fields.find(
    (candidate) => (candidate.display.columnId ?? candidate.key) === columnId,
  );
  if (!field) return [columnId];
  const read = field.readKey ?? field.key;
  const explanation = field.explanation;
  const projection =
    explanation && "projections" in explanation
      ? explanation.projections?.list
      : explanation && "readPath" in explanation
        ? explanation.readPath
        : undefined;
  return [
    ...new Set([
      field.key,
      read.split(".")[0]!,
      ...(projection ? [projection.split(".")[0]!] : []),
    ]),
  ];
}
