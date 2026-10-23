import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";

import { referenceFieldReadFields } from "../entity-references";
import { readPathRoot } from "../read-path";

export function listColumnReadFields(
  entity: BrowserRoutedEntity,
  columnId: string,
): string[] {
  if (columnId === "image" || columnId === "images")
    return ["displayImages", "images"];
  const field = entityFieldModels[entity].fields.find(
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
      ...referenceFieldReadFields(field),
      ...(field.resolution
        ? ["fieldResolutions", ...Object.keys(field.resolution.reset)]
        : []),
      ...[
        read,
        ...(projection ? [projection] : []),
        ...(explanation && "sourceDependencies" in explanation
          ? explanation.sourceDependencies.map((source) => source.path)
          : []),
      ].flatMap((path) => {
        const root = readPathRoot(path);
        return root ? [root] : [];
      }),
    ]),
  ];
}
