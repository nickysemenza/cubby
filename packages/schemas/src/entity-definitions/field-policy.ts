import { z } from "zod";
import { timestampedFields } from "../base-entity";

/** Read projections are never accepted as member-authored create or update values. */
export const readOnly = <const Schema extends z.ZodType>(read: Schema) => ({
  read,
  create: null,
  update: null,
});

/** An ordinary stored reference inherits its target from the field; explicit null opts out. */
export const storedReference = (
  storage: string | null | undefined,
  field:
    | {
        key?: string;
        kind?: string;
        reference?: { entity: string; multiple?: boolean } | null;
      }
    | undefined,
): string | null => {
  if (storage !== undefined) {
    if (
      storage !== null &&
      field?.kind === "identifier" &&
      field.reference &&
      !field.reference.multiple &&
      storage !== field.reference.entity
    )
      throw new Error(
        `Stored reference ${field.key ?? "field"} targets ${storage}, but its field references ${field.reference.entity}.`,
      );
    return storage;
  }
  return field?.kind === "identifier" && !field.reference?.multiple
    ? (field.reference?.entity ?? null)
    : null;
};

/** Record timestamps share validation; declarations retain their reading placement. */
export const timestampField = <
  const Key extends keyof typeof timestampedFields,
>(
  key: Key,
  display: { list?: false; detail?: false; format?: "timestamp" } = {
    list: false,
  },
) => ({
  key,
  kind: "timestamp" as const,
  display,
  validation: readOnly(timestampedFields[key]),
});

/** Alias writes retain spelling and first occurrence after trimming and dropping blanks. */
export const normalizeAliases = (aliases: readonly string[]): string[] => [
  ...new Set(aliases.map((alias) => alias.trim()).filter(Boolean)),
];

/** Apply only to write inputs; stored read projections preserve historical values. */
export const aliasList = z.array(z.string()).transform(normalizeAliases);
