import type { z } from "zod";

type FieldKind =
  | "text"
  | "text-array"
  | "number"
  | "boolean"
  | "date"
  | "timestamp"
  | "enum"
  | "json"
  | "identifier";
type FieldDeclaration = {
  key: string;
  kind: FieldKind;
  nullable?: boolean;
  label?: string;
  description?: string | null;
  readKey?: string | null;
  reference?: { entity: string; multiple?: boolean } | null;
  control?: {
    kind:
      | "text"
      | "textarea"
      | "checkbox"
      | "select"
      | "date"
      | "number"
      | "specialized";
    renderer?: string | null;
    options?: readonly { value: string; label: string }[] | null;
    section?: string;
  } | null;
  display?: {
    list?: boolean;
    detail?: boolean;
    columnId?: string | null;
    standard?: "name" | "image" | null;
    detailOrder?: number | null;
    detailSection?: string;
  };
  validation?: Partial<Record<"read" | "create" | "update", z.ZodType | null>>;
};
export type EntityDeclaration = {
  key: string;
  names: { singular: string; plural: string | null };
  model?: {
    fields: readonly FieldDeclaration[];
    storage: readonly (
      | string
      | {
          key: string;
          column?: string;
          kind?: FieldKind;
          nullable?: boolean;
          default?: "none" | "generated" | "now" | "literal";
          defaultValue?: unknown;
          reference?: string | null;
          specialized?: string | null;
        }
    )[];
    create: readonly string[];
    update: readonly string[];
    output: readonly string[];
    bulk: readonly string[];
    audit: readonly string[];
  };
  filterSchemas?: Readonly<Record<string, z.ZodType>>;
};

/** Preserve literal field keys and schema types without inspecting Zod internals. */
export const defineEntity = <const T extends EntityDeclaration>(
  declaration: T,
): T => declaration;

type ReadableDeclaration = {
  model: {
    fields: readonly {
      key: string;
      readKey?: string | null;
      validation?: { read: z.ZodType | null };
    }[];
    output: readonly string[];
  };
};
type ReadFieldSchemas<D extends ReadableDeclaration> = {
  [
    F in D["model"]["fields"][number] as F["key"] extends D["model"]["output"][number]
      ? F extends { readKey: infer R extends string }
        ? R
        : F["key"]
      : never
  ]: F extends { validation: { read: infer S extends z.ZodType } } ? S : never;
};

/** Compose domain projections from the same declared fields without importing generated code. */
export function readFieldSchemas<const D extends ReadableDeclaration>(
  definition: D,
): ReadFieldSchemas<D> {
  const entries = definition.model.output.map((key) => {
    const field = definition.model.fields.find((field) => field.key === key);
    if (!field?.validation?.read)
      throw new Error(`Missing declared read schema for ${key}`);
    return [field.readKey ?? key, field.validation.read];
  });
  // SAFETY: the explicit output roster selects exact declared keys; missing schemas fail above.
  return Object.fromEntries(entries) as ReadFieldSchemas<D>;
}
