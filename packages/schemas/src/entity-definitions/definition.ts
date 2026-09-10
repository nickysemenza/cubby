import type { z } from "zod";

/** The scalar shapes the entity compiler can persist and project. */
export const entityFieldKinds = [
  "text",
  "text-array",
  "number",
  "boolean",
  "date",
  "timestamp",
  "enum",
  "json",
  "identifier",
] as const;
export type EntityFieldKind = (typeof entityFieldKinds)[number];

/** Controls that a declaration may expose to generic entity editing. */
export const entityFieldControlKinds = [
  "text",
  "textarea",
  "checkbox",
  "select",
  "date",
  "number",
  "specialized",
] as const;
export type EntityFieldControlKind = (typeof entityFieldControlKinds)[number];

/** Database-default strategies supported by declared storage columns. */
export const entityStorageDefaultKinds = [
  "none",
  "generated",
  "now",
  "literal",
] as const;
export type EntityStorageDefaultKind =
  (typeof entityStorageDefaultKinds)[number];

type EntityFieldDeclaration = {
  key: string;
  kind: EntityFieldKind;
  nullable?: boolean;
  label?: string;
  description?: string | null;
  readKey?: string | null;
  reference?: { entity: string; multiple?: boolean } | null;
  control?: {
    kind: EntityFieldControlKind;
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
type EntityStorageDeclaration =
  | string
  | {
      key: string;
      column?: string;
      kind?: EntityFieldKind;
      nullable?: boolean;
      default?: EntityStorageDefaultKind;
      defaultValue?: unknown;
      reference?: string | null;
      specialized?: string | null;
    };
type EntityFieldModelDeclaration = {
  fields: readonly EntityFieldDeclaration[];
  storage: readonly EntityStorageDeclaration[];
  create: readonly string[];
  update: readonly string[];
  output: readonly string[];
  bulk: readonly string[];
  audit: readonly string[];
};
export type EntityDeclaration = {
  key: string;
  names: { singular: string; plural: string | null };
  model?: EntityFieldModelDeclaration;
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
