type BulkField = {
  key: string;
  semanticRole?: "externalIdentifier" | "attachment";
  display?: { standard?: string | null };
  reference?: { entity: string } | null;
  collection?: { key: string | readonly string[] } | null;
};

/** Bulk is the ordinary update roster, minus fields whose identity cannot be shared. */
export const deriveBulkUpdateFields = (
  model: {
    update: readonly string[];
    fields: readonly BulkField[];
  },
  indexes: readonly (
    | { trigram: string }
    | { unique?: true; on: readonly ({ column: string } | { sql: string })[] }
  )[] = [],
): string[] =>
  model.update.filter((key) => {
    const field = model.fields.find((candidate) => candidate.key === key);
    const uniqueReference =
      field?.reference != null &&
      indexes.some(
        (index) =>
          "on" in index &&
          index.unique === true &&
          index.on.length === 1 &&
          index.on.some((part) => "column" in part && part.column === key),
      );
    return (
      !uniqueReference &&
      field !== undefined &&
      key !== "name" &&
      field.display?.standard !== "name" &&
      field.display?.standard !== "image" &&
      field.reference?.entity !== "image" &&
      field.semanticRole === undefined
    );
  });
