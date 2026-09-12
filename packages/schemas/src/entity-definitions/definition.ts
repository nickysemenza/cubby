import { z } from "zod";

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
const entityStorageDefaultKinds = [
  "none",
  "generated",
  "now",
  "literal",
] as const;
export type EntityStorageDefaultKind =
  (typeof entityStorageDefaultKinds)[number];

/**
 * Executable entity declarations deliberately carry Zod instances.  This
 * schema validates the surrounding serializable metadata without parsing,
 * cloning, or reconstructing those instances, so defaults and refinements
 * continue to belong to their declaration modules.
 */
const metadataSchemas = () => {
  const declaredZodSchema = z.instanceof(z.ZodType, {
    error: "must be a Zod schema",
  });

  const nonEmptyString = (message = "must be a non-empty string") =>
    z.string({ error: message }).min(1, { error: message });

  const entityFieldValidationMetadataSchema = z
    .object({
      read: declaredZodSchema.nullable().optional().default(null),
      create: declaredZodSchema.nullable().optional().default(null),
      update: declaredZodSchema.nullable().optional().default(null),
    })
    .strict();

  const entityFieldReferenceMetadataSchema = z
    .object({
      entity: nonEmptyString(),
      multiple: z
        .boolean({ error: "must be a boolean" })
        .optional()
        .default(false),
    })
    .strict();

  const entityFieldControlMetadataSchema = z
    .object({
      kind: z.enum(entityFieldControlKinds),
      renderer: nonEmptyString().nullable().optional().default(null),
      options: z
        .array(
          z
            .object({
              value: nonEmptyString(),
              label: nonEmptyString(),
            })
            .strict(),
        )
        .nullable()
        .optional()
        .default(null),
      section: nonEmptyString().optional().default("main"),
    })
    .strict();

  const entityFieldDisplayMetadataSchema = z
    .object({
      list: z.boolean({ error: "must be a boolean" }).optional().default(false),
      detail: z
        .boolean({ error: "must be a boolean" })
        .optional()
        .default(false),
      columnId: nonEmptyString().nullable().optional().default(null),
      standard: z.enum(["name", "image"]).nullable().optional().default(null),
      detailOrder: z
        .number()
        .int()
        .nonnegative()
        .nullable()
        .optional()
        .default(null),
      /**
       * Orders generated list columns independently of model order (which
       * also drives form field order, so it cannot be re-sequenced). Ordered
       * columns come first, ascending; the rest keep model order.
       */
      listOrder: z
        .number()
        .int()
        .nonnegative()
        .nullable()
        .optional()
        .default(null),
      detailSection: nonEmptyString().optional().default("overview"),
      /** List column width bucket; the shared table maps it to a class. */
      width: z
        .enum(["xs", "sm", "md", "lg"])
        .nullable()
        .optional()
        .default(null),
      /** List cell formatter chosen by the shared column compiler. */
      format: z
        .enum(["currency", "plainDate", "timestamp", "external-link"])
        .nullable()
        .optional()
        .default(null),
      /** Mobile card placement for the list column. */
      mobile: z
        .object({
          slot: nonEmptyString(),
          priority: z.number().int().nonnegative(),
          interactive: z.boolean({ error: "must be a boolean" }).optional(),
        })
        .strict()
        .nullable()
        .optional()
        .default(null),
    })
    .strict();

  const entityFieldMetadataSchema = z
    .object({
      key: nonEmptyString(),
      kind: z.enum(entityFieldKinds),
      nullable: z
        .boolean({ error: "must be a boolean" })
        .optional()
        .default(false),
      label: nonEmptyString().optional(),
      description: nonEmptyString().nullable().optional().default(null),
      readKey: nonEmptyString().nullable().optional(),
      reference: entityFieldReferenceMetadataSchema
        .nullable()
        .optional()
        .default(null),
      control: entityFieldControlMetadataSchema
        .nullable()
        .optional()
        .default(null),
      display: entityFieldDisplayMetadataSchema.optional().prefault({}),
      validation: entityFieldValidationMetadataSchema.optional().prefault({}),
    })
    .strict();

  const entityStorageMetadataSchema = z.union([
    nonEmptyString(),
    z
      .object({
        key: nonEmptyString(),
        column: nonEmptyString().optional(),
        kind: z.enum(entityFieldKinds).optional(),
        nullable: z.boolean({ error: "must be a boolean" }).optional(),
        default: z.enum(entityStorageDefaultKinds).optional(),
        defaultValue: z
          .union([z.string(), z.number(), z.boolean(), z.null()])
          .optional(),
        reference: nonEmptyString().nullable().optional(),
        specialized: nonEmptyString().nullable().optional(),
      })
      .strict(),
  ]);

  const entityFieldModelSortMetadataSchema = z
    .object({
      fields: z.array(nonEmptyString()).min(1),
      default: nonEmptyString(),
      computed: z.array(nonEmptyString()).optional().default([]),
      groupable: z.array(nonEmptyString()).optional().default([]),
    })
    .strict();

  /**
   * Editing intents: named field fragments the browser editor exposes, plus
   * the ordered intent names each operation accepts (the first is the
   * default). `editorFields` lists editor-only pseudo fields (for example a
   * flattened discriminated identity) that intents may name without a model
   * field.
   */
  const entityFieldModelIntentsMetadataSchema = z
    .object({
      fields: z.record(nonEmptyString(), z.array(nonEmptyString()).min(1)),
      create: z.array(nonEmptyString()).min(1),
      update: z.array(nonEmptyString()).min(1),
      editorFields: z.array(nonEmptyString()).optional().default([]),
    })
    .strict();

  const entityFieldModelMetadataSchema = z
    .object({
      fields: z.array(entityFieldMetadataSchema),
      storage: z.array(entityStorageMetadataSchema),
      create: z.array(nonEmptyString()),
      update: z.array(nonEmptyString()),
      output: z.array(nonEmptyString()),
      bulk: z.array(nonEmptyString()),
      audit: z.array(nonEmptyString()),
      sort: entityFieldModelSortMetadataSchema.optional(),
      intents: entityFieldModelIntentsMetadataSchema.optional(),
    })
    .strict();

  const sourceRefMetadataSchema = z
    .object({ module: nonEmptyString(), export: nonEmptyString() })
    .strict();

  const entityRouteMetadataSchema = z
    .object({
      basePath: nonEmptyString(),
      detailParam: nonEmptyString().optional(),
    })
    .strict();

  const entityIdentifiersMetadataSchema = z
    .object({
      brand: nonEmptyString().nullable(),
      shortcode: nonEmptyString().nullable(),
      legacy: nonEmptyString().nullable(),
    })
    .strict();

  const entityPresentationMetadataSchema = z
    .object({ titleField: nonEmptyString() })
    .strict();

  const entityDeleteMetadataSchema = z
    .object({
      mode: z.enum(["soft", "hard"]),
      bulk: z.boolean({ error: "must be a boolean" }),
    })
    .strict();

  const entityBulkUpdateMetadataSchema = z
    .object({ fields: z.array(nonEmptyString()).min(1) })
    .strict();

  const entityCapabilitiesMetadataSchema = z
    .object({
      auditable: z.boolean({ error: "must be a boolean" }),
      images: z.boolean({ error: "must be a boolean" }),
      countable: z.boolean({ error: "must be a boolean" }),
      softDelete: z.boolean({ error: "must be a boolean" }),
      delete: entityDeleteMetadataSchema.nullable(),
      bulkUpdate: entityBulkUpdateMetadataSchema.nullable(),
      merge: z.boolean({ error: "must be a boolean" }),
      operationOwners: z
        .object({
          delete: z.enum(["kernel", "workflow"]).nullable(),
          merge: z.enum(["kernel", "workflow"]).nullable(),
        })
        .strict(),
      mcp: z.array(nonEmptyString()),
    })
    .strict();

  const entityContractMetadataSchema = z
    .object({
      create: sourceRefMetadataSchema.nullable(),
      update: sourceRefMetadataSchema.nullable(),
      output: sourceRefMetadataSchema,
      list: sourceRefMetadataSchema.optional(),
      detail: sourceRefMetadataSchema.optional(),
      mcpOutput: sourceRefMetadataSchema.optional(),
      mcpList: sourceRefMetadataSchema.optional(),
      mcpDetail: sourceRefMetadataSchema.optional(),
    })
    .strict();

  const entityFilterDescriptorMetadataSchema = z
    .object({
      columnId: nonEmptyString(),
      field: nonEmptyString().nullable().optional(),
      urlKey: nonEmptyString().nullable().optional(),
      kind: nonEmptyString(),
      placeholder: nonEmptyString(),
      options: z
        .array(
          z
            .object({
              value: nonEmptyString(),
              label: nonEmptyString(),
              meta: z.boolean({ error: "must be a boolean" }).optional(),
              color: nonEmptyString().optional(),
            })
            .strict(),
        )
        .nullable()
        .optional(),
      optionsRef: sourceRefMetadataSchema.nullable().optional(),
      optionsKey: nonEmptyString().nullable().optional(),
      label: nonEmptyString().nullable().optional(),
      schemaDescription: nonEmptyString().nullable().optional(),
      deriveSchema: z.boolean({ error: "must be a boolean" }).optional(),
      schemaFromRead: z.boolean({ error: "must be a boolean" }).optional(),
      brandRef: z
        .object({ entity: nonEmptyString(), kind: z.enum(["id", "shortcode"]) })
        .strict()
        .nullable()
        .optional(),
      expandRef: sourceRefMetadataSchema.nullable().optional(),
      /** A named schema for select/multiselect values (an enum export). */
      schemaRef: sourceRefMetadataSchema.nullable().optional(),
      /**
       * The filter is the standard predicate over stored columns, so the
       * repository composes it from the declaration. `true` reads the column
       * named by `columnId`; `columns` names one or more stored fields when
       * the descriptor id is virtual (`search`) or the match spans columns;
       * `array` marks a multiselect over a `text-array` column (overlap, not
       * membership).
       */
      stored: z
        .union([
          z.boolean({ error: "must be a boolean" }),
          z
            .object({
              columns: z.array(nonEmptyString()).min(1).optional(),
              array: z.boolean({ error: "must be a boolean" }).optional(),
            })
            .strict(),
        ])
        .optional(),
      /** Range bounds; `kind` is inferred from the model field when omitted. */
      range: z
        .object({
          kind: z.enum(["number", "date"]).optional(),
          int: z.boolean({ error: "must be a boolean" }).optional(),
          nonnegative: z.boolean({ error: "must be a boolean" }).optional(),
          finite: z.boolean({ error: "must be a boolean" }).optional(),
          /** MCP prose for the two bounds the range derives. */
          describe: z
            .object({ lower: nonEmptyString(), upper: nonEmptyString() })
            .strict()
            .optional(),
        })
        .strict()
        .nullable()
        .optional(),
      urlOnly: z.boolean({ error: "must be a boolean" }).optional(),
      nullable: z
        .object({ field: nonEmptyString(), label: nonEmptyString() })
        .strict()
        .nullable()
        .optional(),
    })
    .strict();

  const entityRelationSourceMetadataSchema = z
    .object({
      key: nonEmptyString(),
      label: nonEmptyString(),
      provenance: z.unknown(),
      inverse: z.unknown().optional(),
    })
    .strict();

  const entityRelationMetadataSchema = z
    .object({
      key: nonEmptyString(),
      label: nonEmptyString(),
      target: nonEmptyString(),
      cardinality: z.enum(["one", "many"]),
      sourceKey: nonEmptyString().optional(),
      provenance: z.unknown(),
      inverse: z.unknown().optional(),
      sources: z.array(entityRelationSourceMetadataSchema).optional(),
      mutation: z
        .object({
          source: nonEmptyString(),
          itemSchema: sourceRefMetadataSchema,
          adapter: sourceRefMetadataSchema,
          audiences: z.array(z.enum(["browser", "mcp"])).min(1),
        })
        .strict()
        .optional(),
    })
    .strict();

  const entityExtensionsMetadataSchema = z
    .object({
      countFilter: nonEmptyString().nullable(),
      relatednessSignals: z
        .array(
          z.union([
            z
              .object({
                kind: z.literal("semantic"),
                label: nonEmptyString(),
                pair: nonEmptyString(),
                weight: z.number(),
                limit: z.number().int().positive(),
              })
              .strict(),
            z
              .object({
                kind: z.literal("scalarOverlap"),
                label: nonEmptyString(),
                pair: nonEmptyString(),
                column: nonEmptyString(),
                popularityCap: z.number().int().positive(),
                scoring: z.literal("displayOnly"),
              })
              .strict(),
          ]),
        )
        .nullable(),
      mcpNames: z
        .object({
          singular: nonEmptyString().optional(),
          plural: nonEmptyString().optional(),
          overrides: z.record(nonEmptyString(), nonEmptyString()).optional(),
        })
        .strict()
        .nullable(),
      ports: z
        .object({
          repository: sourceRefMetadataSchema.nullable(),
          references: z
            .object({
              label: sourceRefMetadataSchema.nullable(),
              resolver: sourceRefMetadataSchema.nullable(),
            })
            .strict(),
          filters: sourceRefMetadataSchema.nullable(),
          search: z
            .object({
              projection: sourceRefMetadataSchema.nullable(),
              semanticText: sourceRefMetadataSchema.nullable(),
              dependentRefresh: sourceRefMetadataSchema.nullable(),
            })
            .strict(),
        })
        .strict(),
    })
    .strict();

  /**
   * The compiler imports executable literals, so this schema covers every
   * stable declaration section before semantic cross-entity validation. The
   * relation, filter, and contract contents stay opaque here because their
   * diagnostic-rich semantic validation depends on the whole catalog.
   */
  const entityDeclarationMetadataSchema = z
    .object({
      key: nonEmptyString(),
      names: z
        .object({
          singular: nonEmptyString(),
          plural: nonEmptyString().nullable(),
        })
        .strict(),
      route: entityRouteMetadataSchema.nullable(),
      table: nonEmptyString().nullable(),
      identifiers: entityIdentifiersMetadataSchema,
      presentation: entityPresentationMetadataSchema,
      fields: entityContractMetadataSchema.nullable(),
      model: entityFieldModelMetadataSchema.optional(),
      filters: z
        .object({
          audit: z.boolean({ error: "must be a boolean" }).optional(),
          schema: sourceRefMetadataSchema.nullable().optional(),
          descriptors: z.array(entityFilterDescriptorMetadataSchema),
        })
        .strict(),
      relations: z.array(entityRelationMetadataSchema),
      search: z
        .object({ enabled: z.boolean({ error: "must be a boolean" }) })
        .strict(),
      capabilities: entityCapabilitiesMetadataSchema,
      extensions: entityExtensionsMetadataSchema,
    })
    .strict();

  return {
    declaration: entityDeclarationMetadataSchema,
    field: entityFieldMetadataSchema,
    fieldModel: entityFieldModelMetadataSchema,
    storage: entityStorageMetadataSchema,
  };
};

type EntityMetadataSchemas = ReturnType<typeof metadataSchemas>;
export type EntityStorageMetadata = z.output<EntityMetadataSchemas["storage"]>;
export type EntityFieldModelMetadata = z.output<
  EntityMetadataSchemas["fieldModel"]
>;
export type EntityDeclaration = z.input<EntityMetadataSchemas["declaration"]>;
export type EntityDeclarationMetadata = z.output<
  EntityMetadataSchemas["declaration"]
>;

const pathAt = (context: string, path: readonly PropertyKey[]) =>
  path.length === 0 ? context : `${context}.${path.join(".")}`;

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- This parser-boundary walker only distinguishes omitted input from an explicit invalid value so Zod errors retain their declaration path. */
const valueIsMissingAt = (value: unknown, path: readonly PropertyKey[]) => {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return true;
    const property = Object.getOwnPropertyDescriptor(current, key);
    if (property === undefined) return true;
    current = property.value;
  }
  return current === undefined;
};
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters */

/**
 * Preserve declaration-local diagnostic paths while centralizing strict shape
 * validation and metadata defaults. Semantic roster and storage checks remain
 * in the compiler because they require the complete entity declaration.
 */
export function parseEntityFieldModelMetadata(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- compiler parser boundary
  value: unknown,
  context: string,
): EntityFieldModelMetadata | null {
  if (value === undefined) return null;
  const parsed = metadataSchemas().fieldModel.safeParse(value);
  if (parsed.success) return parsed.data;

  const issue = parsed.error.issues[0];
  if (issue === undefined) throw new Error(`${context} metadata is invalid.`);
  if (issue.code === "unrecognized_keys") {
    const key = issue.keys[0];
    throw new Error(`${pathAt(context, issue.path)}.${key} is not allowed.`);
  }
  const path = pathAt(context, issue.path);
  if (issue.code === "invalid_type" && valueIsMissingAt(value, issue.path)) {
    throw new Error(`${path} is required.`);
  }
  const field = issue.path.at(-1);
  if (
    field === "nullable" ||
    field === "multiple" ||
    field === "list" ||
    field === "detail"
  )
    throw new Error(`${path} must be a boolean.`);
  if (field === "read" || field === "create" || field === "update")
    throw new Error(`${path} must be a Zod schema.`);
  if (
    field === "label" ||
    field === "key" ||
    field === "entity" ||
    field === "columnId" ||
    field === "detailSection" ||
    field === "section"
  )
    throw new Error(`${path} must be a non-empty string.`);
  throw new Error(`${path} ${issue.message}.`);
}

/** Parse an executable declaration once before compiler-only semantic checks. */
export function parseEntityDeclarationMetadata(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- compiler parser boundary
  value: unknown,
  context: string,
): EntityDeclarationMetadata {
  const parsed = metadataSchemas().declaration.safeParse(value);
  if (parsed.success) return parsed.data;

  const issue = parsed.error.issues[0];
  if (issue === undefined) throw new Error(`${context} metadata is invalid.`);
  if (issue.code === "unrecognized_keys") {
    const key = issue.keys[0];
    throw new Error(`${pathAt(context, issue.path)}.${key} is not allowed.`);
  }
  const path = pathAt(context, issue.path);
  if (issue.code === "invalid_type" && valueIsMissingAt(value, issue.path))
    throw new Error(`${path} is required.`);
  throw new Error(`${path} ${issue.message}.`);
}

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
