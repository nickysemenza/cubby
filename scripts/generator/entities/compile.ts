import {
  FILTER_KINDS,
  parseEntityDeclarationMetadata,
} from "../../../packages/schemas/src/entity-definitions/definition.ts";
import { photoCategories } from "../../../packages/schemas/src/photo-categories.ts";
import type {
  EntityDeclarationMetadata,
  EntityFieldModelMetadata,
  EntityStorageMetadata,
} from "../../../packages/schemas/src/entity-definitions/definition.ts";
import {
  EntityDeclarationError,
  objectValue,
  required,
  stringValue,
  booleanValue,
} from "./declarations.ts";
import {
  compileDataQuality,
  validateDataQualityDeclarations,
} from "./data-quality.ts";
import {
  deriveImageDisplaySources,
  deriveInverseRelations,
  deriveRelationSections,
} from "./derive.ts";
import type {
  CompiledEntity,
  DeclarationObject,
  EntityField,
  EntityFieldModel,
  EntityPorts,
  EntityStorageField,
  FilterDescriptor,
  RelationMutation,
} from "./declarations.ts";
import {
  compilePresentation,
  validateRelationSections,
} from "./presentation.ts";

const entityPorts = (
  ports: EntityDeclarationMetadata["extensions"]["ports"],
): EntityPorts => {
  return {
    repository: ports.repository,
    references: {
      label: ports.references.label,
      resolver: ports.references.resolver,
    },
    filters: ports.filters,
    search: {
      projection: ports.search.projection,
      semanticText: ports.search.semanticText,
      dependentRefresh: ports.search.dependentRefresh,
    },
    timeline: ports.timeline,
  };
};

const filterKinds = FILTER_KINDS;

const compileEditIntents = (
  value: NonNullable<EntityDeclarationMetadata["model"]>["intents"],
  fieldKeys: readonly string[],
  context: string,
): EntityFieldModel["intents"] => {
  if (value === undefined) return null;
  const editorFields = value.editorFields ?? [];
  const allowed = new Set([...fieldKeys, ...editorFields]);
  for (const [intent, keys] of Object.entries(value.fields)) {
    for (const key of keys) {
      if (!allowed.has(key))
        throw new EntityDeclarationError(
          `${context}.fields.${intent} references undeclared field ${key}.`,
        );
    }
    if (new Set(keys).size !== keys.length)
      throw new EntityDeclarationError(
        `${context}.fields.${intent} lists a field twice.`,
      );
  }
  for (const operation of ["create", "update"] as const) {
    for (const intent of value[operation]) {
      if (!Object.hasOwn(value.fields, intent))
        throw new EntityDeclarationError(
          `${context}.${operation} names undeclared intent ${intent}.`,
        );
    }
  }
  return {
    fields: value.fields,
    create: value.create,
    update: value.update,
    editorFields,
  };
};

/**
 * `control.suggest` fields are decision-tier (Jev) auto-fill targets: the
 * target's shape must be something the field-suggest registry can resolve,
 * every `basis` key must be a real model field on the same entity (not an
 * `editorFields` pseudo-field, since detail/table/bulk surfaces only have
 * model data), and the basis -> target edges across an entity's suggest
 * fields must stay acyclic so one request can resolve them in dependency
 * order (see `docs/entities.md`).
 */
const isValidSuggestTarget = (
  field: EntityField,
  mode: "fill" | "prune",
): boolean =>
  mode === "prune"
    ? field.kind === "text-array"
    : (field.kind === "enum" && field.control?.kind === "select") ||
      (field.reference !== null && !field.reference.multiple) ||
      (field.kind === "text" && field.nullable);

const validateSuggestField = (
  field: EntityField,
  fieldKeys: ReadonlySet<string>,
  context: string,
): void => {
  const fieldContext = `${context}.${field.key}.control.suggest`;
  const mode = field.control?.suggest?.mode ?? "fill";
  if (!isValidSuggestTarget(field, mode))
    throw new EntityDeclarationError(
      mode === "prune"
        ? `${fieldContext} prune target must be a text-array field.`
        : `${fieldContext} target must be a select-controlled enum, a singular (non-multiple) reference, or a nullable text field.`,
    );
  for (const key of field.control?.suggest?.basis ?? []) {
    // A prune target judges its own current entries and is therefore an
    // implicit self-basis; naming itself explicitly stays an error.
    if (key === field.key)
      throw new EntityDeclarationError(
        `${fieldContext}.basis cannot name its own field (${key}).`,
      );
    if (!fieldKeys.has(key))
      throw new EntityDeclarationError(
        `${fieldContext}.basis references ${key}, which is not a model field on this entity.`,
      );
  }
};

const validateFieldSuggestions = (
  fields: readonly EntityField[],
  context: string,
): void => {
  const fieldKeys = new Set(fields.map((field) => field.key));
  const suggestFields = fields.filter(
    (field) => field.control?.suggest != null,
  );
  if (suggestFields.length === 0) return;
  for (const field of suggestFields)
    validateSuggestField(field, fieldKeys, context);
  // Edge basisKey -> targetKey only when basisKey is itself a suggest
  // target: the server resolves that basis value from the same request, so
  // it must be reachable before `field.key` resolves.
  const suggestKeys = new Set(suggestFields.map((field) => field.key));
  const adjacency = new Map<string, string[]>();
  for (const field of suggestFields) {
    for (const key of field.control?.suggest?.basis ?? []) {
      if (!suggestKeys.has(key)) continue;
      const edges = adjacency.get(key) ?? [];
      edges.push(field.key);
      adjacency.set(key, edges);
    }
  }
  const UNVISITED = 0;
  const IN_PROGRESS = 1;
  const DONE = 2;
  const state = new Map<string, 0 | 1 | 2>();
  const path: string[] = [];
  const visit = (key: string): void => {
    state.set(key, IN_PROGRESS);
    path.push(key);
    for (const next of adjacency.get(key) ?? []) {
      const nextState = state.get(next) ?? UNVISITED;
      if (nextState === IN_PROGRESS) {
        const cycleStart = path.indexOf(next);
        const cycle = [...path.slice(cycleStart), next].join(" -> ");
        throw new EntityDeclarationError(
          `${context} control.suggest basis graph has a cycle: ${cycle}.`,
        );
      }
      if (nextState === UNVISITED) visit(next);
    }
    path.pop();
    state.set(key, DONE);
  };
  for (const key of suggestKeys) {
    if ((state.get(key) ?? UNVISITED) === UNVISITED) visit(key);
  }
};

const compileFieldProvenance = (
  field: EntityFieldModelMetadata["fields"][number],
  fieldContext: string,
  relations: EntityDeclarationMetadata["relations"],
): EntityField["provenance"] => {
  if (field.reference !== null) {
    return {
      kind: "reference",
      sources: [
        { entity: field.reference.entity, label: null, relation: null },
      ],
    };
  }
  if (field.provenance === null) return null;
  return {
    kind: field.provenance.kind,
    sources: field.provenance.sources.map((source) => {
      if ("label" in source) {
        return { entity: null, label: source.label, relation: null };
      }
      const relation =
        source.relation === null
          ? null
          : relations.find((candidate) => candidate.key === source.relation);
      if (source.relation !== null && relation === undefined)
        throw new EntityDeclarationError(
          `${fieldContext}.provenance source names undeclared relation ${source.relation}.`,
        );
      if (relation != null && relation.target !== source.entity)
        throw new EntityDeclarationError(
          `${fieldContext}.provenance relation ${source.relation} targets ${relation.target}, not ${source.entity}.`,
        );
      return {
        entity: source.entity,
        label: null,
        relation: source.relation,
      };
    }),
  };
};

// Field compilation deliberately keeps cross-property invariants in one pass.
// eslint-disable-next-line complexity
const compileFieldModel = (
  value: EntityFieldModelMetadata | undefined,
  context: string,
  relations: EntityDeclarationMetadata["relations"],
  entityKey: string,
): EntityFieldModel => {
  if (value === undefined) {
    return {
      fields: [],
      storage: [],
      create: [],
      update: [],
      bulk: [],
      audit: [],
      output: [],
      sort: null,
      intents: null,
    };
  }
  const model = value;
  const fields = model.fields.map((field, index): EntityField => {
    const fieldContext = `${context}.fields[${index}]`;
    const key = field.key;
    if (field.control !== null && !field.control.section.trim())
      throw new EntityDeclarationError(
        `${fieldContext}.control.section must be nonempty.`,
      );
    if (field.display.columnId !== null && !field.display.columnId.trim())
      throw new EntityDeclarationError(
        `${fieldContext}.display.columnId must not be blank.`,
      );
    if (field.reference !== null && field.provenance !== null)
      throw new EntityDeclarationError(
        `${fieldContext} cannot declare provenance for a reference field.`,
      );
    // The humanised-key fallback reads "Location Id" for a reference; the
    // editor and facts grid need the target's sentence-case name.
    if (field.reference !== null && field.label === undefined)
      throw new EntityDeclarationError(
        `${fieldContext} is a reference field and must declare a sentence-case label.`,
      );
    const provenance = compileFieldProvenance(field, fieldContext, relations);
    return {
      key,
      kind: field.kind,
      nullable: field.nullable,
      label:
        field.label ??
        key
          .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
          .replace(/^./, (letter) => letter.toUpperCase()),
      description: field.description,
      readKey: field.readKey === undefined ? key : field.readKey,
      reference: field.reference,
      provenance,
      explanation:
        field.explanation ??
        (provenance?.kind === "derived"
          ? {
              ruleId: `${entityKey}.${key}`,
              version: 1,
              description:
                field.description ??
                `Derived from ${provenance.sources.map((source) => source.label ?? source.relation ?? source.entity).join(" and ")}.`,
              resolver: "field",
            }
          : null),
      resolution: field.resolution,
      control: field.control,
      display: {
        columnId: field.display.columnId,
        standard: field.display.standard,
        width: field.display.width ?? null,
        format: field.display.format ?? null,
        renderer: field.display.renderer ?? null,
        mobile: field.display.mobile ?? null,
        detailOrder: field.display.detailOrder,
        listOrder: field.display.listOrder,
        list: field.display.list,
        detail: field.display.detail,
        listHidden: field.display.listHidden ?? false,
      },
      validation: field.validation,
    };
  });
  validateFieldSuggestions(fields, context);
  const displayedColumnIds = new Set<string>();
  for (const field of fields) {
    const listRenderer = field.display.renderer?.list ?? null;
    const detailRenderer = field.display.renderer?.detail ?? null;
    if (listRenderer !== null && !field.display.list) {
      throw new EntityDeclarationError(
        `${context}.${field.key}.display.renderer.list requires display.list.`,
      );
    }
    if (detailRenderer !== null && !field.display.detail) {
      throw new EntityDeclarationError(
        `${context}.${field.key}.display.renderer.detail requires display.detail.`,
      );
    }
    const standard = field.display.standard;
    if (
      standard !== null &&
      (!field.display.list ||
        field.kind !== (standard === "name" ? "text" : "json") ||
        field.readKey !== (standard === "name" ? "name" : "images") ||
        (field.display.columnId ?? field.key) !== standard)
    ) {
      throw new EntityDeclarationError(
        `${context}.${field.key} has an incompatible standard display column.`,
      );
    }
    if (!field.display.list) continue;
    const columnId = field.display.columnId ?? field.key;
    if (displayedColumnIds.has(columnId)) {
      throw new EntityDeclarationError(
        `${context} declares duplicate display column ${columnId}.`,
      );
    }
    displayedColumnIds.add(columnId);
  }
  const isStorageObject = (
    entry: EntityStorageMetadata,
  ): entry is Exclude<EntityStorageMetadata, string> =>
    typeof entry !== "string";
  const storage = model.storage.map((entry, index): EntityStorageField => {
    const fieldContext = `${context}.storage[${index}]`;
    const field = isStorageObject(entry) ? entry : { key: entry };
    const key = field.key;
    const declared = fields.find((candidate) => candidate.key === key);
    if (!declared)
      throw new EntityDeclarationError(
        `${fieldContext} references undeclared field ${key}.`,
      );
    const defaultKind = field.default ?? "none";
    const defaultValue = field.defaultValue ?? null;
    if (defaultKind === "literal" && !("defaultValue" in field))
      throw new EntityDeclarationError(
        `${fieldContext}.defaultValue is required for a literal default.`,
      );
    return {
      key,
      column: field.column ?? key,
      kind: field.kind ?? declared.kind,
      nullable: field.nullable ?? declared.nullable,
      default: defaultKind,
      defaultValue,
      reference: field.reference ?? null,
      specialized: field.specialized ?? null,
    };
  });
  const fieldKeys = fields.map(({ key }) => key);
  const storageKeys = storage.map(({ key }) => key);
  if (new Set(fieldKeys).size !== fieldKeys.length)
    throw new EntityDeclarationError(
      `${context}.fields contains duplicate keys.`,
    );
  if (new Set(storageKeys).size !== storageKeys.length)
    throw new EntityDeclarationError(
      `${context}.storage contains duplicate keys.`,
    );
  const policy = (key: "create" | "update" | "bulk" | "audit" | "output") => {
    const values = model[key];
    if (new Set(values).size !== values.length)
      throw new EntityDeclarationError(
        `${context}.${key} contains duplicates.`,
      );
    for (const field of values) {
      if (!fieldKeys.includes(field))
        throw new EntityDeclarationError(
          `${context}.${key} references undeclared field ${field}.`,
        );
    }
    return values;
  };
  const sortValue = model.sort;
  const sort: EntityFieldModel["sort"] =
    sortValue === undefined
      ? null
      : (() => {
          const sortContext = `${context}.sort`;
          const computed = sortValue.computed ?? [];
          const groupable = sortValue.groupable ?? [];
          const [first, ...rest] = sortValue.fields;
          if (first === undefined)
            throw new EntityDeclarationError(`${sortContext}.fields is empty.`);
          const defaultField =
            sortValue.default ??
            (sortValue.fields.includes("createdAt") ? "createdAt" : first);
          for (const key of sortValue.fields) {
            if (computed.includes(key)) continue;
            if (!fieldKeys.includes(key))
              throw new EntityDeclarationError(
                `${sortContext}.fields references undeclared field ${key}.`,
              );
          }
          if (!sortValue.fields.includes(defaultField))
            throw new EntityDeclarationError(
              `${sortContext}.default ${defaultField} must be one of sort.fields.`,
            );
          for (const key of groupable) {
            if (!sortValue.fields.includes(key))
              throw new EntityDeclarationError(
                `${sortContext}.groupable ${key} must be one of sort.fields.`,
              );
          }
          for (const key of computed) {
            if (!sortValue.fields.includes(key))
              throw new EntityDeclarationError(
                `${sortContext}.computed ${key} must be one of sort.fields.`,
              );
          }
          return {
            fields: [first, ...rest] as const,
            default: defaultField,
            computed,
            groupable,
            direction:
              sortValue.direction ??
              (["text", "enum"].includes(
                fields.find((field) => field.key === defaultField)?.kind ?? "",
              )
                ? "asc"
                : "desc"),
          };
        })();
  const compiled = {
    fields,
    storage,
    create: policy("create"),
    update: policy("update"),
    bulk: policy("bulk"),
    audit: policy("audit"),
    output: policy("output"),
    sort,
    intents: compileEditIntents(model.intents, fieldKeys, `${context}.intents`),
  };
  const storedFields = new Set(storageKeys);
  for (const field of fields) {
    const exposed =
      field.display.list || field.display.detail || field.control !== null;
    if (
      field.explanation?.resolver === "field" &&
      field.readKey === null &&
      !field.explanation.readPath &&
      !field.explanation.projections
    )
      throw new EntityDeclarationError(
        `${context}.${field.key} needs an explicit explanation readPath or projections.`,
      );
    if (exposed && !storedFields.has(field.key) && field.provenance === null)
      throw new EntityDeclarationError(
        `${context}.${field.key} is exposed without storage, a reference, or declared provenance.`,
      );
    if (
      field.provenance?.kind === "derived" &&
      (compiled.create.includes(field.key) ||
        compiled.update.includes(field.key))
    )
      throw new EntityDeclarationError(
        `${context}.${field.key} is derived and cannot be directly createable or updateable.`,
      );
  }
  for (const field of compiled.bulk) {
    if (!compiled.update.includes(field))
      throw new EntityDeclarationError(
        `${context}.bulk field ${field} must also be updateable.`,
      );
  }
  return compiled;
};

const derivableFilterKinds = new Set<string>([
  "text",
  "select",
  "multiselect",
  "boolean",
  "presence",
  "range",
  "id",
  "idMulti",
]);

type RawFilterDescriptor =
  EntityDeclarationMetadata["filters"]["descriptors"][number];

const validateDerivedFilter = (
  value: RawFilterDescriptor,
  kind: FilterDescriptor["kind"],
  modelField: EntityField | undefined,
  context: string,
): void => {
  const deriveSchema = value.deriveSchema ?? false;
  const schemaFromRead = value.schemaFromRead ?? false;
  const schemaRef = value.schemaRef ?? null;
  const schemaDescription = value.schemaDescription ?? null;
  if (
    !deriveSchema &&
    (schemaFromRead || schemaDescription !== null || schemaRef !== null)
  )
    throw new EntityDeclarationError(
      `${context} schemaFromRead/schemaDescription/schemaRef require deriveSchema.`,
    );
  if (schemaFromRead && schemaRef !== null)
    throw new EntityDeclarationError(
      `${context} cannot declare both schemaFromRead and schemaRef.`,
    );
  if (schemaFromRead && modelField?.validation.read == null)
    throw new EntityDeclarationError(
      `${context} schemaFromRead needs a model field ${value.columnId} with a read schema.`,
    );
  if (deriveSchema && !derivableFilterKinds.has(kind))
    throw new EntityDeclarationError(
      `${context} deriveSchema is unsupported for kind ${kind}.`,
    );
  if (value.range != null && !(deriveSchema && kind === "range"))
    throw new EntityDeclarationError(
      `${context} range options apply only to derived range descriptors.`,
    );
};

/** The range kind a model field implies, or null when it implies none. */
const inferredRangeKind = (
  modelField: EntityField | undefined,
): "number" | "date" | null => {
  switch (modelField?.kind) {
    case "number":
      return "number";
    case "date":
    case "timestamp":
      return "date";
    default:
      return null;
  }
};

const resolveFilterRange = (
  value: RawFilterDescriptor,
  kind: FilterDescriptor["kind"],
  modelField: EntityField | undefined,
  context: string,
): FilterDescriptor["range"] => {
  if (!(value.deriveSchema ?? false) || kind !== "range") return null;
  const options = value.range ?? {};
  const rangeKind = options.kind ?? inferredRangeKind(modelField);
  if (rangeKind === null)
    throw new EntityDeclarationError(
      `${context} range needs range.kind or a numeric/date model field ${value.columnId}.`,
    );
  const int = options.int ?? false;
  const finite = options.finite ?? false;
  if (rangeKind === "date" && (int || finite))
    throw new EntityDeclarationError(
      `${context} range.int/finite apply only to numeric ranges.`,
    );
  return {
    kind: rangeKind,
    int,
    nonnegative: options.nonnegative ?? false,
    finite,
    describe: options.describe ?? null,
  };
};

/**
 * A stored filter is composed by the repository from the declaration alone,
 * so every shape it can take must be one the standard predicates handle:
 * several columns only for a text search, `array` only for a multiselect
 * over a `text-array` column (which in turn needs it), and a boolean filter
 * over a column that is not boolean reads as presence (`true` is NOT NULL),
 * which only means something on a nullable column.
 */
/** A stored id filter matches a foreign key by the referenced row's shortcode. */
const validateStoredReference = (
  value: RawFilterDescriptor,
  kind: FilterDescriptor["kind"],
  fields: readonly EntityStorageField[],
  context: string,
): void => {
  if (kind !== "id" && kind !== "idMulti") return;
  if (fields.some((field) => field.reference === null))
    throw new EntityDeclarationError(
      `${context} stored id filter needs a foreign-key field.`,
    );
  if (fields.some((field) => field.reference !== value.brandRef?.entity))
    throw new EntityDeclarationError(
      `${context} stored id filter's brandRef must name the entity its field references.`,
    );
};

const validateStoredFilter = (
  value: RawFilterDescriptor,
  kind: FilterDescriptor["kind"],
  storage: readonly EntityStorageField[],
  context: string,
): FilterDescriptor["stored"] => {
  const raw = value.stored ?? false;
  if (raw === false) return null;
  if (!(value.deriveSchema ?? false))
    throw new EntityDeclarationError(
      `${context} stored requires deriveSchema.`,
    );
  const columns =
    raw === true ? [value.columnId] : (raw.columns ?? [value.columnId]);
  const array = raw === true ? false : (raw.array ?? false);
  const fields = columns.map((column) => {
    const field = storage.find(({ key }) => key === column);
    if (field === undefined)
      throw new EntityDeclarationError(
        `${context} stored needs a stored model field ${column}.`,
      );
    return field;
  });
  if (columns.length > 1 && kind !== "text")
    throw new EntityDeclarationError(
      `${context} stored columns span several fields only for a text filter.`,
    );
  const arrayColumn = fields.some((field) => field.kind === "text-array");
  if (array && !(kind === "multiselect" && arrayColumn))
    throw new EntityDeclarationError(
      `${context} stored.array applies only to a multiselect over a text-array field.`,
    );
  if (arrayColumn && kind !== "text" && !array)
    throw new EntityDeclarationError(
      `${context} stored over a text-array field needs stored.array.`,
    );
  validateStoredReference(value, kind, fields, context);
  if (
    kind === "boolean" &&
    fields.some((field) => field.kind !== "boolean" && !field.nullable)
  )
    throw new EntityDeclarationError(
      `${context} stored boolean over a non-boolean field reads as presence, so the field must be nullable.`,
    );
  return { columns, array };
};

/**
 * The list-route query parameter a filter binds to: the filter field (or the
 * column id) for a scalar, the `From/To` (date) or `Min/Max` (number) pair
 * for a range. A declaration overrides it only where the hand-written filter
 * schema diverges; the http-api stage checks every binding against the list
 * route's parameters.
 */
const filterWire = (
  value: RawFilterDescriptor,
  kind: FilterDescriptor["kind"],
  range: FilterDescriptor["range"],
  modelField: EntityField | undefined,
): FilterDescriptor["wire"] => {
  if (value.wire != null) return value.wire;
  const name = value.field ?? value.columnId;
  if (kind !== "range") return { kind: "param", name };
  const rangeKind = range?.kind ?? inferredRangeKind(modelField) ?? "date";
  return rangeKind === "date"
    ? { kind: "range", from: `${name}From`, to: `${name}To` }
    : { kind: "range", from: `${name}Min`, to: `${name}Max` };
};

const validateFilterReference = (
  value: RawFilterDescriptor,
  kind: FilterDescriptor["kind"],
  context: string,
): void => {
  const isIdentifier = kind === "id" || kind === "idMulti";
  if (isIdentifier && !value.urlOnly && value.brandRef == null) {
    throw new EntityDeclarationError(
      `${context} rendered ${kind} filters require brandRef so browser URL values stay shortcode-native.`,
    );
  }
  // A URL-only id filter still names the entity it scopes by, so a detail
  // page can find it as a back-filter; `brandRef: null` marks a non-entity id.
  if (isIdentifier && value.brandRef === undefined) {
    throw new EntityDeclarationError(
      `${context} ${kind} filters must declare brandRef (null for an id that names no entity).`,
    );
  }
  if (value.brandRef != null && !isIdentifier) {
    throw new EntityDeclarationError(
      `${context} brandRef is only valid for id/idMulti filters.`,
    );
  }
};

/**
 * A select filter over an enum field takes the field's options, so a value
 * added to the enum reaches the filter menu and its URL schema. A declared
 * copy (kept for per-option colors) must name exactly the field's values:
 * a copy that fell behind the enum once hid every AI Run from `/runs`.
 */
const enumFilterOptions = (
  value: RawFilterDescriptor,
  kind: FilterDescriptor["kind"],
  modelField: EntityField | undefined,
  context: string,
): FilterDescriptor["options"] => {
  const declared = value.options ?? null;
  const fieldOptions = modelField?.control?.options ?? null;
  // A descriptor bound to its own param (`field`) has its own vocabulary,
  // such as inventory placement's `all`.
  const filtersField = value.field == null || value.field === value.columnId;
  if (
    (kind !== "select" && kind !== "multiselect") ||
    modelField?.kind !== "enum" ||
    fieldOptions === null ||
    !filtersField
  )
    return declared;
  if (declared === null)
    return value.optionsRef != null ||
      value.optionsKey != null ||
      value.schemaRef != null
      ? null
      : fieldOptions.map(({ value: option, label }) => ({
          value: option,
          label,
        }));
  const declaredValues = declared
    .filter((option) => option.meta !== true)
    .map((option) => option.value)
    .sort();
  const fieldValues = fieldOptions.map((option) => option.value).sort();
  if (declaredValues.join("\0") !== fieldValues.join("\0"))
    throw new EntityDeclarationError(
      `${context} options must match ${value.columnId}'s control options (${fieldValues.join(", ")}); omit them to derive from the field.`,
    );
  return declared;
};

const filterDescriptor = (
  value: RawFilterDescriptor,
  fields: readonly EntityField[],
  storage: readonly EntityStorageField[],
  context: string,
): FilterDescriptor => {
  const parsedKind = filterKinds.find((candidate) => candidate === value.kind);
  if (parsedKind === undefined) {
    throw new EntityDeclarationError(`${context}.kind is unsupported.`);
  }
  const optionsRef = value.optionsRef ?? null;
  if (value.options != null && optionsRef !== null) {
    throw new EntityDeclarationError(
      `${context} cannot declare both options and optionsRef.`,
    );
  }
  const modelField = fields.find((field) => field.key === value.columnId);
  const options = enumFilterOptions(value, parsedKind, modelField, context);
  validateFilterReference(value, parsedKind, context);
  validateDerivedFilter(value, parsedKind, modelField, context);
  const stored = validateStoredFilter(value, parsedKind, storage, context);
  const range = resolveFilterRange(value, parsedKind, modelField, context);
  return {
    columnId: value.columnId,
    field: value.field ?? null,
    urlKey: value.urlKey ?? value.columnId,
    kind: parsedKind,
    placeholder: value.placeholder,
    options,
    optionsRef,
    optionsKey: value.optionsKey ?? null,
    label: value.label ?? null,
    schemaDescription: value.schemaDescription ?? null,
    deriveSchema: value.deriveSchema ?? false,
    schemaFromRead: value.schemaFromRead ?? false,
    brandRef: value.brandRef ?? null,
    expandRef: value.expandRef ?? null,
    schemaRef: value.schemaRef ?? null,
    stored,
    range,
    urlOnly: value.urlOnly ?? false,
    nullable: value.nullable ?? null,
    wire: filterWire(value, parsedKind, range, modelField),
  };
};

const validateDeclarationCapabilities = (
  declaration: EntityDeclarationMetadata,
  context: string,
): void => {
  const capabilities = declaration.capabilities;
  const owners = capabilities.operationOwners;
  const validateOwner = (operation: "delete" | "merge") => {
    return owners[operation];
  };
  const deleteOwner = validateOwner("delete");
  const mergeOwner = validateOwner("merge");
  const deleteCapability = capabilities.delete;
  if (deleteCapability !== null) {
    if (deleteOwner === null) {
      throw new EntityDeclarationError(
        `${context}.capabilities.operationOwners.delete is required for delete.`,
      );
    }
  }
  if (deleteCapability === null && deleteOwner !== null) {
    throw new EntityDeclarationError(
      `${context}.capabilities.operationOwners.delete must be null without delete.`,
    );
  }
  const mergeCapability = capabilities.merge;
  if (mergeCapability !== (mergeOwner !== null)) {
    throw new EntityDeclarationError(
      `${context}.capabilities.operationOwners.merge must match merge capability.`,
    );
  }
  const bulkUpdateCapability = capabilities.bulkUpdate;
  if (bulkUpdateCapability !== null) {
    // The emitted update-schema `.pick({...})` rejects a field absent from the
    // source-referenced update schema at typecheck time.
    const names = bulkUpdateCapability.fields;
    if (new Set(names).size !== names.length) {
      throw new EntityDeclarationError(
        `${context}.capabilities.bulkUpdate.fields contains duplicates.`,
      );
    }
    if (declaration.fields === null) {
      throw new EntityDeclarationError(
        `${context}.capabilities.bulkUpdate requires an update schema.`,
      );
    }
  }
  const mcpActions = capabilities.mcp;
  const supportedMcpActions = [
    "get",
    "list",
    "search",
    "create",
    "update",
    "delete",
    "bulkUpdate",
    "merge",
  ];
  for (const [index, name] of mcpActions.entries()) {
    if (!supportedMcpActions.includes(name))
      throw new EntityDeclarationError(
        `${context}.capabilities.mcp[${index}] is unsupported.`,
      );
  }
};

const opaqueRelationProvenance = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- relation graph provenance is intentionally compiler-semantic opaque data.
  value: unknown,
  context: string,
): DeclarationObject => objectValue(value, context);

// Cross-relation checks use parsed metadata; only graph provenance remains
// opaque because its path semantics are validated against the full catalog.
const normalizedDeclarationRelations = (
  relations: EntityDeclarationMetadata["relations"],
  context: string,
): void => {
  const relationKeys = new Set<string>();
  for (const [index, relation] of relations.entries()) {
    const relationContext = `${context}.relations[${index}]`;
    if (relationKeys.has(relation.key))
      throw new EntityDeclarationError(
        `${context}.relations contains duplicate keys.`,
      );
    relationKeys.add(relation.key);
    const sourceKey = relation.sourceKey ?? relation.key;
    const provenance = opaqueRelationProvenance(
      relation.provenance,
      `${relationContext}.provenance`,
    );
    if (provenance.kind === "local-path" && relation.inverse === undefined)
      throw new EntityDeclarationError(
        `${relationContext} local-path requires inverse.`,
      );
    const sources = relation.sources ?? [];
    const sourceKeys = [sourceKey];
    for (const [sourceIndex, source] of sources.entries()) {
      sourceKeys.push(source.key);
      const sourceProvenance = opaqueRelationProvenance(
        source.provenance,
        `${relationContext}.sources[${sourceIndex}].provenance`,
      );
      if (
        sourceProvenance.kind === "local-path" &&
        source.inverse === undefined
      ) {
        throw new EntityDeclarationError(
          `${relationContext}.sources[${sourceIndex}] local-path requires inverse.`,
        );
      }
    }
    if (new Set(sourceKeys).size !== sourceKeys.length) {
      throw new EntityDeclarationError(
        `${relationContext} contains duplicate source keys.`,
      );
    }
    if (relation.mutation !== undefined) {
      if (!sourceKeys.includes(relation.mutation.source)) {
        throw new EntityDeclarationError(
          `${relationContext}.mutation.source must name a declared source.`,
        );
      }
      if (
        new Set(relation.mutation.audiences).size !==
        relation.mutation.audiences.length
      ) {
        throw new EntityDeclarationError(
          `${relationContext}.mutation.audiences contains duplicates.`,
        );
      }
    }
  }
};

const serializedDeclarationRelations = (
  relations: EntityDeclarationMetadata["relations"],
  context: string,
): DeclarationObject[] =>
  relations.map((relation, index) => {
    const relationContext = `${context}.relations[${index}]`;
    const serialized: DeclarationObject = {
      key: relation.key,
      label: relation.label,
      target: relation.target,
      cardinality: relation.cardinality,
      sourceKey: relation.sourceKey ?? relation.key,
      provenance: opaqueRelationProvenance(
        relation.provenance,
        `${relationContext}.provenance`,
      ),
      sources: (relation.sources ?? []).map((source, sourceIndex) => {
        const serializedSource: DeclarationObject = {
          key: source.key,
          label: source.label,
          provenance: opaqueRelationProvenance(
            source.provenance,
            `${relationContext}.sources[${sourceIndex}].provenance`,
          ),
        };
        if (source.inverse !== undefined)
          serializedSource.inverse = opaqueRelationProvenance(
            source.inverse,
            `${relationContext}.sources[${sourceIndex}].inverse`,
          );
        return serializedSource;
      }),
    };
    if (relation.inverse !== undefined)
      serialized.inverse = opaqueRelationProvenance(
        relation.inverse,
        `${relationContext}.inverse`,
      );
    if (relation.derived === true) serialized.derived = true;
    if (relation.inverseOmit !== undefined)
      serialized.inverseOmit = relation.inverseOmit;
    if (relation.mutation !== undefined) {
      serialized.mutation = {
        source: relation.mutation.source,
        itemSchema: { ...relation.mutation.itemSchema },
        adapter: { ...relation.mutation.adapter },
        audiences: [...relation.mutation.audiences],
      };
    }
    return serialized;
  });

const declarationDescriptor = (
  declaration: EntityDeclarationMetadata,
  context: string,
): DeclarationObject => {
  const extensions = declaration.extensions;
  const descriptor: DeclarationObject = {
    dbTable: declaration.table,
    idBrand: declaration.identifiers.brand,
  };
  if (declaration.identifiers.shortcode !== null) {
    descriptor.shortcodePrefix = declaration.identifiers.shortcode;
  }
  descriptor.softDelete = declaration.capabilities.softDelete;
  if (declaration.route === null) descriptor.browserRoutes = false;
  descriptor.auditable = declaration.capabilities.auditable;
  descriptor.hasImages =
    declaration.capabilities.images.storage === "gallery" ||
    declaration.capabilities.images.storage === "cover";
  descriptor.imageStorage = declaration.capabilities.images.storage;
  descriptor.images = declaration.capabilities.images;
  descriptor.displayImages = true;
  descriptor.searchable = declaration.search.enabled;
  descriptor.embeddable =
    declaration.search.enabled && (declaration.search.embedding ?? true);
  descriptor.countable = declaration.capabilities.countable;
  descriptor.relationships = serializedDeclarationRelations(
    declaration.relations,
    context,
  );
  descriptor.lifecycle = {
    delete: declaration.capabilities.delete,
    merge: declaration.capabilities.merge,
  };
  descriptor.mcp = declaration.capabilities.mcp;
  if (extensions.countFilter !== null && extensions.countFilter !== undefined) {
    descriptor.countFilter = extensions.countFilter;
  }
  if (extensions.mcpNames !== null && extensions.mcpNames !== undefined) {
    descriptor.mcpNames = extensions.mcpNames;
  }
  if (
    extensions.relatednessSignals !== null &&
    extensions.relatednessSignals !== undefined
  ) {
    descriptor.relatednessSignals = extensions.relatednessSignals;
  }

  return descriptor;
};

const compiledShortcode = (
  descriptor: DeclarationObject,
  context: string,
): string | null => {
  const value = descriptor.shortcodePrefix;
  if (value === undefined) return null;
  const shortcode = stringValue(value, `${context}.descriptor.shortcodePrefix`);
  if (!/^[A-Z]{2,5}-$/.test(shortcode))
    throw new EntityDeclarationError(
      `${context}.descriptor.shortcodePrefix must be a 2-5 letter uppercase prefix ending in a hyphen.`,
    );
  return shortcode;
};

// `titleField` names a READ PROJECTION key, not a model field key — the two
// diverge whenever a field renames itself for output (cookbook's `name`
// field reads out as `book`, so `titleField: "book"` is correct and must
// stay valid). A field with `readKey: null` is excluded from the read
// projection entirely and can never be a legal titleField. Skipped when the
// declaration has no read-projected fields at all (no `model`, or every
// field is storage-only) — there is then no read projection to validate
// against, which minimal test-only declarations elsewhere rely on.
const validateTitleField = (
  titleField: string,
  fieldModel: CompiledEntity["fieldModel"],
  key: string,
  context: string,
) => {
  const readProjectionKeys = new Set(
    fieldModel.fields
      .map((field) => field.readKey)
      .filter((readKey): readKey is string => readKey !== null),
  );
  if (readProjectionKeys.size === 0) return;
  if (!readProjectionKeys.has(titleField))
    throw new EntityDeclarationError(
      `${context}.presentation.titleField "${titleField}" for entity "${key}" must be a read-projection key (a field's readKey, or its key when readKey is unset) of a declared, readable field.`,
    );
  // A title that can read out empty leaves every generic surface (page
  // title, list row, relations graph, native row) showing a bare shortcode.
  // Entities whose natural title is optional declare a storage-less
  // `displayName` (read-only, computed in the repo mapper) and point here.
  const titleModel = fieldModel.fields.find(
    (field) => field.readKey === titleField,
  );
  const readSchema = titleModel?.validation.read;
  const readsNull =
    readSchema != null &&
    "safeParse" in readSchema &&
    readSchema.safeParse(null).success;
  if (titleModel?.kind !== "text" || titleModel.nullable || readsNull)
    throw new EntityDeclarationError(
      `${context}.presentation.titleField "${titleField}" for entity "${key}" must be a non-nullable text field; declare a read-only computed \`displayName\` when the natural title can be empty.`,
    );
};

/**
 * Entities whose detail route stays hand-written (`route.detailOverride: null`).
 * Every other entity's page is the generic detail. `recipe` still renders
 * `GenericEntityDetail`; its route is hand-written only for the workflow
 * slot's URL search keys. `usda-food` is the external USDA catalog, keyed by
 * FDC id rather than a Cubby shortcode.
 */
const HAND_WRITTEN_DETAIL_ROUTES = new Set(["recipe", "usda-food"]);

/**
 * A route defaults to generated list and detail pages over the
 * generic renderers, which read the kernel's list/detail projections: the
 * detail roster is every entity with create and update contracts, the list
 * roster its browser-routed members. An entity outside the detail roster
 * declares `detailOverride: { query }` instead (image); one outside the list roster
 * hand-writes its index route.
 */
const validateRouteRosters = (
  key: string,
  route: EntityDeclarationMetadata["route"],
  contract: CompiledEntity["contract"],
  timeline: CompiledEntity["timeline"],
  context: string,
) => {
  if (timeline !== null && contract === null)
    throw new EntityDeclarationError(
      `${context}.capabilities.timeline needs a contract (the timeline is an HTTP resource verb).`,
    );
  if (route === null) return;
  if (route.detail === null && !HAND_WRITTEN_DETAIL_ROUTES.has(key))
    throw new EntityDeclarationError(
      `${context}.route.detail is null; every entity gets the generic detail page. Omit detailOverride, or declare detailOverride: { query } outside the kernel detail roster, and put specialized UI in a detail slot.`,
    );
  const inDetailRoster =
    contract !== null && contract.create !== null && contract.update !== null;
  if (route.detail === true && !inDetailRoster)
    throw new EntityDeclarationError(
      `${context}.route.detail is true but the entity has no create+update contract; declare detailOverride: { query } or null.`,
    );
  if (route.detail !== null && route.detail !== true && inDetailRoster)
    throw new EntityDeclarationError(
      `${context}.route.detail.query is for entities outside the kernel detail roster; omit detailOverride.`,
    );
  // A generated index route needs rows to list: the kernel list read for a
  // roster entity, or (outside the roster) a client-paged override module in
  // `apps/web/src/entities/list-columns` over the entity's own projection.
  if (route.list === true && contract === null)
    throw new EntityDeclarationError(
      `${context}.route.list is true but the entity has no contract (nothing to list); declare listOverride: null.`,
    );
};

/**
 * A dialog-created entity needs a capture intent for the generated index's
 * `CreateDialogAction` (and the `?create=true` search key) to open anything.
 */
const validateRouteCreate = (
  route: EntityDeclarationMetadata["route"],
  fieldModel: EntityFieldModel,
  context: string,
) => {
  if (
    route?.create === "dialog" &&
    !(fieldModel.intents?.create ?? []).includes("capture")
  ) {
    throw new EntityDeclarationError(
      `${context}.route.create is "dialog" but model.intents.create lacks "capture".`,
    );
  }
};

/** Names plus the declaration's `presentation` block with its defaults resolved. */
const compiledInspector = (
  declaration: EntityDeclarationMetadata,
  fieldModel: EntityFieldModel,
  ports: EntityPorts,
  context: string,
): CompiledEntity["inspector"] => ({
  singular: declaration.names.singular,
  plural: declaration.names.plural,
  ...compilePresentation(
    declaration.presentation,
    {
      fieldModel,
      relations: declaration.relations,
      capabilities: declaration.capabilities,
      ports,
      hasUpdate: declaration.fields?.update != null,
      entityKey: declaration.key,
    },
    `${context}.presentation`,
  ),
});

// One compiler pass keeps cross-field capability errors attached to the exact
// entity declaration rather than losing context across partial validators.
export const compileEntity = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- imported declaration boundary
  value: unknown,
  index: number,
): CompiledEntity => {
  const context = `ENTITY_DECLARATIONS[${index}]`;
  const raw = objectValue(value, context);
  const declared = raw;
  let declaration;
  try {
    declaration = parseEntityDeclarationMetadata(declared, context);
  } catch (error) {
    if (error instanceof Error) throw new EntityDeclarationError(error.message);
    throw error;
  }
  const key = declaration.key;
  if (!/^[a-z][a-zA-Z-]*$/.test(key)) {
    throw new EntityDeclarationError(
      `${context}.key must be lower-camel-case or kebab-case.`,
    );
  }

  validateDeclarationCapabilities(declaration, context);
  normalizedDeclarationRelations(declaration.relations, context);
  const descriptor = declarationDescriptor(declaration, context);
  const declaredFieldModel = compileFieldModel(
    declaration.model,
    `${context}.model`,
    declaration.relations,
    key,
  );
  const operationOwners = {
    delete: declaration.capabilities.operationOwners.delete,
    merge: declaration.capabilities.operationOwners.merge,
  };
  validateTitleField(
    declaration.presentation.titleField,
    declaredFieldModel,
    key,
    context,
  );
  const filters = declaration.filters;
  const filterAudit = filters.audit === undefined ? false : filters.audit;
  const filterSchema =
    filters.schema === undefined || filters.schema === null
      ? null
      : { module: filters.schema.module, export: filters.schema.export };
  const declaredDescriptors = filters.descriptors.map((value, index) =>
    filterDescriptor(
      value,
      declaredFieldModel.fields,
      declaredFieldModel.storage,
      `${context}.filters.descriptors[${index}]`,
    ),
  );
  const {
    dataQuality,
    fieldModel,
    descriptors: filterDescriptors,
  } = compileDataQuality(
    declaration.capabilities.dataQuality,
    key,
    declaredFieldModel,
    declaredDescriptors,
    declaration.fields !== null,
    filterSchema !== null,
    context,
  );
  const descriptorColumns = filterDescriptors.map(({ columnId }) => columnId);
  if (new Set(descriptorColumns).size !== descriptorColumns.length) {
    throw new EntityDeclarationError(
      `${context}.filters.descriptors contains duplicate columnId values.`,
    );
  }
  if (
    filterAudit &&
    descriptorColumns.some(
      (columnId) => columnId === "createdAt" || columnId === "updatedAt",
    )
  ) {
    throw new EntityDeclarationError(
      `${context}.filters.audit duplicates an explicit createdAt or updatedAt descriptor.`,
    );
  }
  if (filterAudit && descriptor.auditable !== true) {
    throw new EntityDeclarationError(
      `${context}.filters.audit requires an auditable entity.`,
    );
  }
  const auditDescriptors: FilterDescriptor[] = filterAudit
    ? [
        {
          columnId: "createdAt",
          field: null,
          urlKey: "createdAt",
          kind: "range",
          placeholder: "Filter by created date...",
          options: [
            { value: "30d", label: "Last 30 days" },
            { value: "90d", label: "Last 90 days" },
            { value: "ytd", label: "Year to date" },
            { value: "1y", label: "Last 12 months" },
          ],
          optionsRef: null,
          optionsKey: null,
          label: null,
          schemaDescription: null,
          deriveSchema: false,
          schemaFromRead: false,
          brandRef: null,
          schemaRef: null,
          stored: null,
          range: null,
          expandRef: {
            module: "~/entities/filter-behavior",
            export: "resolveCreatedDate",
          },
          urlOnly: false,
          nullable: null,
          wire: { kind: "range", from: "createdFrom", to: "createdTo" },
        },
        {
          columnId: "updatedAt",
          field: null,
          urlKey: "updatedAt",
          kind: "range",
          placeholder: "Filter by updated date...",
          options: [
            { value: "30d", label: "Last 30 days" },
            { value: "90d", label: "Last 90 days" },
            { value: "ytd", label: "Year to date" },
            { value: "1y", label: "Last 12 months" },
          ],
          optionsRef: null,
          optionsKey: null,
          label: null,
          schemaDescription: null,
          deriveSchema: false,
          schemaFromRead: false,
          brandRef: null,
          schemaRef: null,
          stored: null,
          range: null,
          expandRef: {
            module: "~/entities/filter-behavior",
            export: "resolveUpdatedDate",
          },
          urlOnly: false,
          nullable: null,
          wire: { kind: "range", from: "updatedFrom", to: "updatedTo" },
        },
      ]
    : [];
  const filterDescriptorsWithAudit = [
    ...filterDescriptors,
    ...auditDescriptors,
  ];
  const descriptorUrlKeys = filterDescriptorsWithAudit.map(
    ({ urlKey }) => urlKey,
  );
  const filterUrlKeys = descriptorUrlKeys;
  if (new Set(descriptorUrlKeys).size !== descriptorUrlKeys.length) {
    throw new EntityDeclarationError(
      `${context}.filters.descriptors contains duplicate URL keys.`,
    );
  }
  const route = declaration.route;
  validateRouteCreate(route, fieldModel, context);
  const ports = entityPorts(declaration.extensions.ports);
  const inspector = compiledInspector(declaration, fieldModel, ports, context);
  const shortcode = compiledShortcode(descriptor, context);
  booleanValue(
    required(descriptor, "auditable", `${context}.descriptor`),
    `${context}.descriptor.auditable`,
  );
  if (descriptor.browserRoutes !== undefined)
    booleanValue(
      descriptor.browserRoutes,
      `${context}.descriptor.browserRoutes`,
    );
  booleanValue(
    required(descriptor, "searchable", `${context}.descriptor`),
    `${context}.descriptor.searchable`,
  );
  booleanValue(
    required(descriptor, "embeddable", `${context}.descriptor`),
    `${context}.descriptor.embeddable`,
  );

  const contractValue = declaration.fields;
  const contract =
    contractValue === null
      ? null
      : (() => {
          const output = contractValue.output;
          const list = contractValue.list ?? output;
          const detail = contractValue.detail ?? output;
          return {
            create: contractValue.create,
            update: contractValue.update,
            output,
            list,
            detail,
            mcpOutput: contractValue.mcpOutput ?? output,
            mcpList: contractValue.mcpList ?? list,
            mcpDetail:
              contractValue.mcpDetail ?? contractValue.mcpOutput ?? detail,
          };
        })();

  if (shortcode === null && contract !== null) {
    throw new EntityDeclarationError(
      `${context} cannot declare a contract without a shortcode.`,
    );
  }
  validateRouteRosters(
    declaration.key,
    route,
    contract,
    declaration.capabilities.timeline,
    context,
  );
  const relationMutations = declaration.relations.flatMap(
    (relation): RelationMutation[] =>
      relation.mutation === undefined
        ? []
        : [
            {
              entity: key,
              relation: relation.key,
              target: relation.target,
              source: relation.mutation.source,
              itemSchema: relation.mutation.itemSchema,
              adapter: relation.mutation.adapter,
              audiences: relation.mutation.audiences,
            },
          ],
  );
  const bulkUpdateFields = declaration.capabilities.bulkUpdate?.fields ?? null;
  return {
    key,
    shortcode,
    inspector,
    timeline: declaration.capabilities.timeline,
    contract,
    descriptor,
    route,
    filterUrlKeys,
    filterSchema,
    filterAudit,
    filterDescriptors: filterDescriptorsWithAudit,
    bulkUpdateFields,
    ports,
    imagePolicy: declaration.capabilities.images,
    relations: declaration.relations,
    relationMutations,
    lifecycle: {
      softDelete: declaration.capabilities.softDelete,
      delete: declaration.capabilities.delete,
      merge: declaration.capabilities.merge,
    },
    mcpActions: declaration.capabilities.mcp,
    operationOwners,
    fieldModel,
    dataQuality,
  };
};

export const validateEntityIdentities = (
  entities: readonly CompiledEntity[],
) => {
  const keys = new Set<string>();
  const prefixes = new Map<string, string>();
  for (const entity of entities) {
    if (keys.has(entity.key)) {
      throw new EntityDeclarationError(`Duplicate entity key ${entity.key}.`);
    }
    keys.add(entity.key);
    if (entity.shortcode !== null) {
      const owner = prefixes.get(entity.shortcode);
      if (owner !== undefined) {
        throw new EntityDeclarationError(
          `Canonical shortcode prefix ${entity.shortcode} for ${entity.key} conflicts with ${owner}.`,
        );
      }
      prefixes.set(entity.shortcode, `${entity.key} canonical prefix`);
    }
  }
  for (const entity of entities) {
    for (const field of entity.fieldModel.fields) {
      for (const source of field.provenance?.sources ?? []) {
        if (source.entity !== null && !keys.has(source.entity)) {
          throw new EntityDeclarationError(
            `${entity.key}.${field.key} provenance names undeclared entity ${source.entity}.`,
          );
        }
      }
    }
  }
};

/**
 * Validate dependent reference-picker scope declarations once the complete
 * entity roster is available.  Keeping this in the compiler means a picker
 * cannot silently send a source field or target filter that disappeared from
 * either entity's manifest.
 */
const validateReferenceScopes = (entities: readonly CompiledEntity[]): void => {
  const byKey = new Map(entities.map((entity) => [entity.key, entity]));
  for (const source of entities) {
    for (const field of source.fieldModel.fields) {
      const reference = field.reference;
      if (reference === null || reference.scope.length === 0) continue;
      const target = byKey.get(reference.entity);
      if (target === undefined)
        throw new EntityDeclarationError(
          `${source.key}.${field.key}.reference.scope targets undeclared entity ${reference.entity}.`,
        );
      for (const [index, binding] of reference.scope.entries()) {
        const context = `${source.key}.${field.key}.reference.scope[${index}]`;
        const sourceField = source.fieldModel.fields.find(
          (candidate) => candidate.key === binding.sourceField,
        );
        if (sourceField === undefined)
          throw new EntityDeclarationError(
            `${context}.sourceField ${binding.sourceField} is not declared on ${source.key}.`,
          );
        const targetField = target.fieldModel.fields.find(
          (candidate) => candidate.key === binding.targetField,
        );
        const targetFilter = target.filterDescriptors.find(
          (descriptor) =>
            descriptor.columnId === binding.targetField ||
            descriptor.field === binding.targetField,
        );
        if (targetField === undefined && targetFilter === undefined)
          throw new EntityDeclarationError(
            `${context}.targetField ${binding.targetField} is not declared as a field or filter on ${target.key}.`,
          );
        // Virtual filter parameters (for example Planting.activeOn) have no
        // model field to compare; their schema and URL contract are owned by
        // the target's filter declaration.
        if (targetField === undefined) continue;
        if (
          sourceField.kind !== targetField.kind ||
          sourceField.reference?.entity !== targetField.reference?.entity ||
          sourceField.reference?.multiple !== targetField.reference?.multiple
        )
          throw new EntityDeclarationError(
            `${context} maps incompatible fields ${source.key}.${sourceField.key} and ${target.key}.${targetField.key}.`,
          );
      }
    }
  }
};

const imagePolicyField = (
  entity: CompiledEntity,
  key: string,
  context: string,
): EntityField => {
  const field = entity.fieldModel.fields.find(
    (candidate) => candidate.key === key,
  );
  if (field === undefined)
    throw new EntityDeclarationError(
      `${context} references undeclared field ${key}.`,
    );
  return field;
};

const imagePolicyPathTarget = (
  entities: readonly CompiledEntity[],
  source: CompiledEntity,
  path: readonly string[],
  context: string,
): CompiledEntity => {
  let current = source;
  for (const [index, key] of path.entries()) {
    const relation = current.relations.find(
      (candidate) => candidate.key === key,
    );
    if (relation === undefined)
      throw new EntityDeclarationError(
        `${context}.relationPath[${index}] references undeclared relation ${current.key}.${key}.`,
      );
    const target = entities.find((entity) => entity.key === relation.target);
    if (target === undefined)
      throw new EntityDeclarationError(
        `${context}.relationPath[${index}] targets undeclared entity ${relation.target}.`,
      );
    current = target;
  }
  return current;
};

type ImageIngressRoute = CompiledEntity["imagePolicy"]["ingress"][number];
type ImageIngressBinding = Extract<
  ImageIngressRoute,
  { kind: "createRelated" } | { kind: "createSelf" }
>["bindings"][number];

const constantMatchesImageField = (
  value: Extract<ImageIngressBinding, { from: "constant" }>["value"],
  field: EntityField,
): boolean => {
  if (value === null) return field.nullable;
  if (field.kind === "number") return Number(value) === value;
  if (field.kind === "boolean") return value === true || value === false;
  return (
    ["text", "enum", "date", "timestamp"].includes(field.kind) &&
    String(value) === value
  );
};

const validateSourceIdImageBinding = (
  entity: CompiledEntity,
  targetField: EntityField,
  multiple: boolean,
  context: string,
): void => {
  if (
    targetField.kind !== "identifier" ||
    targetField.reference?.entity !== entity.key ||
    targetField.reference.multiple !== multiple
  )
    throw new EntityDeclarationError(
      `${context} ${multiple ? "source-id-list" : "source-id"} requires a ${multiple ? "multiple" : "singular"} ${entity.key} reference target field.`,
    );
};

const validateSourceFieldImageBinding = (
  entity: CompiledEntity,
  target: CompiledEntity,
  binding: Extract<ImageIngressBinding, { from: "source-field" }>,
  targetField: EntityField,
  context: string,
): void => {
  const sourceField = imagePolicyField(entity, binding.sourceField, context);
  if (
    sourceField.kind !== targetField.kind ||
    sourceField.reference?.entity !== targetField.reference?.entity ||
    sourceField.reference?.multiple !== targetField.reference?.multiple
  )
    throw new EntityDeclarationError(
      `${context} source-field ${binding.sourceField} is incompatible with ${target.key}.${binding.field}.`,
    );
};

const validateRelationItemsImageBinding = (
  entity: CompiledEntity,
  binding: Extract<ImageIngressBinding, { from: "relation-items" }>,
  targetField: EntityField,
  context: string,
): void => {
  if (targetField.kind !== "json")
    throw new EntityDeclarationError(
      `${context} relation-items requires a json target field.`,
    );
  if (binding.item.from === "source-field") {
    if (binding.item.sourceField === undefined)
      throw new EntityDeclarationError(
        `${context} relation-items source-field requires sourceField.`,
      );
    imagePolicyField(entity, binding.item.sourceField, context);
  }
  if (binding.item.from === "constant" && binding.item.value === undefined)
    throw new EntityDeclarationError(
      `${context} relation-items constant requires value.`,
    );
};

const validateImageBinding = (
  entity: CompiledEntity,
  target: CompiledEntity,
  binding: ImageIngressBinding,
  context: string,
): void => {
  const targetField = imagePolicyField(target, binding.field, context);
  if (binding.from === "source-id") {
    validateSourceIdImageBinding(entity, targetField, false, context);
    return;
  }
  if (binding.from === "source-id-list") {
    validateSourceIdImageBinding(entity, targetField, true, context);
    return;
  }
  if (binding.from === "source-field") {
    validateSourceFieldImageBinding(
      entity,
      target,
      binding,
      targetField,
      context,
    );
    return;
  }
  if (binding.from === "capture-date") {
    if (!["date", "timestamp"].includes(targetField.kind))
      throw new EntityDeclarationError(
        `${context} capture-date requires a date or timestamp target field.`,
      );
    return;
  }
  if (binding.from === "constant") {
    if (!constantMatchesImageField(binding.value, targetField))
      throw new EntityDeclarationError(
        `${context} constant is incompatible with ${target.key}.${binding.field}.`,
      );
    return;
  }
  validateRelationItemsImageBinding(entity, binding, targetField, context);
};

type ConditionalImageIngressChoice = Exclude<
  ImageIngressRoute["choice"],
  string
>;

/** `allowInTypeGuards` (`.oxlintrc.json`) permits `typeof` only inside a declared type
 * predicate — this is the one place that decodes the union so nothing downstream re-checks it. */
const isConditionalChoice = (
  choice: ImageIngressRoute["choice"],
): choice is ConditionalImageIngressChoice => typeof choice === "object";

/** The resolved literal a client applies when no conditional predicate overrides it. */
const resolvedRouteChoice = (
  route: ImageIngressRoute,
): "primary" | "alternate" | "prompt" =>
  isConditionalChoice(route.choice) ? route.choice.otherwise : route.choice;

/** `choice.primary.when`: `field` must be a declared enum field on the source entity and every
 * `oneOf` value a member of it — the same enum-membership pattern `validateImageRouting`'s
 * `lifecycleFilters` uses (`safeParse` against the field's own read schema). */
const validateConditionalPrimaryChoice = (
  entity: CompiledEntity,
  when: { field: string; oneOf: readonly string[] },
  context: string,
): void => {
  const field = imagePolicyField(entity, when.field, `${context}.primary.when`);
  if (field.kind !== "enum")
    throw new EntityDeclarationError(
      `${context}.primary.when.field ${when.field} must be a declared enum field.`,
    );
  if (new Set(when.oneOf).size !== when.oneOf.length)
    throw new EntityDeclarationError(
      `${context}.primary.when.oneOf contains duplicate values.`,
    );
  for (const value of when.oneOf) {
    if (field.validation.read?.safeParse(value).success !== true)
      throw new EntityDeclarationError(
        `${context}.primary.when.oneOf contains a value outside the declared enum.`,
      );
  }
};

const validateCreateSelfRoute = (
  entity: CompiledEntity,
  route: Extract<ImageIngressRoute, { kind: "createSelf" }>,
  routeContext: string,
): void => {
  if (route.enabled) {
    if (route.disabledReason !== undefined)
      throw new EntityDeclarationError(
        `${routeContext}.disabledReason must be omitted when enabled is true.`,
      );
    if (entity.imagePolicy.storage === false)
      throw new EntityDeclarationError(
        `${routeContext} is enabled but ${entity.key} has no direct image storage to attach to.`,
      );
    // Weaker than the runtime lookup `createDestination` uses
    // (`ENTITY_KERNEL_BINDINGS[entity].schemas.createInput`/`repository.create`): the generator
    // runs before that generated file exists, so this checks the same manifest-declared signal
    // `kernelActionsFor` uses to add "create" to the entity's kernel action roster instead.
    if (entity.contract === null || entity.contract.create === null)
      throw new EntityDeclarationError(
        `${routeContext} is enabled but ${entity.key} has no create contract.`,
      );
  } else if (route.disabledReason === undefined) {
    throw new EntityDeclarationError(
      `${routeContext}.disabledReason is required when enabled is false.`,
    );
  }
  const bound = new Set<string>();
  for (const binding of route.bindings) {
    if (bound.has(binding.field))
      throw new EntityDeclarationError(
        `${routeContext}.bindings assigns ${binding.field} more than once.`,
      );
    bound.add(binding.field);
    validateImageBinding(entity, entity, binding, `${routeContext}.bindings`);
  }
};

/** Route-count invariants that only need the roster, not each route's shape. */
const validateImageIngressCardinality = (
  ingress: readonly ImageIngressRoute[],
  routing: CompiledEntity["imagePolicy"]["routing"],
  storage: CompiledEntity["imagePolicy"]["storage"],
  context: string,
): void => {
  const selfRoutes = ingress.filter((route) => route.kind === "self");
  const createSelfRoutes = ingress.filter(
    (route) => route.kind === "createSelf",
  );
  if (ingress.length > 0 && routing === null)
    throw new EntityDeclarationError(
      `${context}.routing is required when ingress routes are declared.`,
    );
  if (storage === false && selfRoutes.length !== 0)
    throw new EntityDeclarationError(
      `${context}.ingress self requires direct image storage.`,
    );
  if (storage !== false && selfRoutes.length !== 1)
    throw new EntityDeclarationError(
      `${context}.ingress requires exactly one self route for direct image storage.`,
    );
  if (createSelfRoutes.length > 1)
    throw new EntityDeclarationError(
      `${context}.ingress may declare at most one createSelf route.`,
    );
  // Makes "which entities could create from a photo, and why not" explicit in the manifest
  // rather than an absence a client has to notice on its own.
  if (storage !== false && createSelfRoutes.length !== 1)
    throw new EntityDeclarationError(
      `${context}.ingress requires exactly one createSelf route for direct image storage.`,
    );
};

/** `choice` cardinality: at most one unconditional and one conditional primary, and any
 * route resolving to "alternate" (directly or via a conditional's `otherwise`) needs a
 * primary to be the alternative TO. */
const validateImageChoiceConsistency = (
  ingress: readonly ImageIngressRoute[],
  context: string,
): void => {
  const unconditionalPrimaryRoutes = ingress.filter(
    (route) => route.choice === "primary",
  );
  const conditionalPrimaryRoutes = ingress.filter((route) =>
    isConditionalChoice(route.choice),
  );
  if (unconditionalPrimaryRoutes.length > 1)
    throw new EntityDeclarationError(
      `${context}.ingress may declare at most one primary route.`,
    );
  if (conditionalPrimaryRoutes.length > 1)
    throw new EntityDeclarationError(
      `${context}.ingress may declare at most one conditional-primary route.`,
    );
  if (
    ingress.some((route) => resolvedRouteChoice(route) === "alternate") &&
    unconditionalPrimaryRoutes.length === 0
  )
    throw new EntityDeclarationError(
      `${context}.ingress alternate routes require a primary route or must be prompt routes.`,
    );
};

/** One route's shape: ownership, its `choice.primary.when` predicate (if conditional), and
 * its kind-specific target/binding rules. */
const validateImageIngressRoute = (
  entities: readonly CompiledEntity[],
  entity: CompiledEntity,
  route: ImageIngressRoute,
  routeOwners: Map<string, string>,
  context: string,
): void => {
  const routeOwner = routeOwners.get(route.routeId);
  if (routeOwner !== undefined)
    throw new EntityDeclarationError(
      `${context}.ingress routeId ${route.routeId} conflicts with ${routeOwner}.capabilities.images.ingress.`,
    );
  routeOwners.set(route.routeId, entity.key);
  const routeContext = `${context}.ingress.${route.routeId}`;
  if (isConditionalChoice(route.choice))
    validateConditionalPrimaryChoice(
      entity,
      route.choice.primary.when,
      routeContext,
    );
  if (route.kind === "self") return;
  if (route.kind === "createSelf") {
    validateCreateSelfRoute(entity, route, routeContext);
    return;
  }
  const target = imagePolicyPathTarget(
    entities,
    entity,
    route.relationPath,
    routeContext,
  );
  if (target.imagePolicy.storage === false)
    throw new EntityDeclarationError(
      `${routeContext} targets ${target.key}, which has no direct image storage.`,
    );
  if (route.kind !== "createRelated") return;
  const bound = new Set<string>();
  for (const binding of route.bindings) {
    if (bound.has(binding.field))
      throw new EntityDeclarationError(
        `${routeContext}.bindings assigns ${binding.field} more than once.`,
      );
    bound.add(binding.field);
    validateImageBinding(entity, target, binding, `${routeContext}.bindings`);
  }
};

const validateImageIngress = (
  entities: readonly CompiledEntity[],
  entity: CompiledEntity,
  routeOwners: Map<string, string>,
): void => {
  const { ingress, routing, storage } = entity.imagePolicy;
  const context = `${entity.key}.capabilities.images`;
  validateImageIngressCardinality(ingress, routing, storage, context);
  for (const route of ingress) {
    validateImageIngressRoute(entities, entity, route, routeOwners, context);
  }
  validateImageChoiceConsistency(ingress, context);
};

const validateImageDisplaySources = (
  entities: readonly CompiledEntity[],
  entity: CompiledEntity,
): void => {
  const context = `${entity.key}.capabilities.images`;
  for (const [index, source] of entity.imagePolicy.displaySources.entries()) {
    const sourceContext = `${context}.displaySources[${index}]`;
    imagePolicyPathTarget(entities, entity, source.relationPath, sourceContext);
    if (source.identityEvidence)
      throw new EntityDeclarationError(
        `${sourceContext}.identityEvidence must be false: borrowed display images are not identity evidence.`,
      );
  }
};

const validateImageVisualEvidence = (
  entities: readonly CompiledEntity[],
  entity: CompiledEntity,
): void => {
  const routing = entity.imagePolicy.routing;
  if (routing === null) return;
  const context = `${entity.key}.capabilities.images.routing`;
  const seenPaths = new Set<string>();
  for (const [index, evidence] of routing.visualEvidence.entries()) {
    const evidenceContext = `${context}.visualEvidence[${index}]`;
    const pathKey = evidence.relationPath.join(".");
    if (seenPaths.has(pathKey))
      throw new EntityDeclarationError(
        `${evidenceContext}.relationPath duplicates another visual-evidence path.`,
      );
    seenPaths.add(pathKey);
    const target = imagePolicyPathTarget(
      entities,
      entity,
      evidence.relationPath,
      evidenceContext,
    );
    // PhotoVisualEvidenceMatcher.directGalleryURLs only reads attachment-role (gallery) images;
    // a cover/logo-storage target can never surface a URL, so evidence pointed at one would
    // silently never fire.
    if (target.imagePolicy.storage !== "gallery")
      throw new EntityDeclarationError(
        `${evidenceContext} targets ${target.key}, which does not have gallery image storage.`,
      );
  }
};

/**
 * No classifier label may belong to two categories' BASE lists: a label that did would make
 * a photo hit ambiguous between categories before any entity ever contributes a member label.
 * Runs once over the static category catalog (`packages/schemas/src/photo-categories.ts`),
 * independent of which entities are compiled — exported so a fixture catalog can exercise the
 * duplicate case directly, without needing a full entity declaration.
 */
export const validatePhotoCategoryLabels = (
  categories: Readonly<Record<string, { classifierLabels: readonly string[] }>>,
): void => {
  const owner = new Map<string, string>();
  for (const [key, category] of Object.entries(categories)) {
    for (const label of category.classifierLabels) {
      const existing = owner.get(label);
      if (existing !== undefined)
        throw new EntityDeclarationError(
          `photoCategories.${key} classifierLabel "${label}" also appears in photoCategories.${existing}.`,
        );
      owner.set(label, key);
    }
  }
};

const validateImageRouting = (entity: CompiledEntity): void => {
  const { routing } = entity.imagePolicy;
  if (routing === null) return;
  const context = `${entity.key}.capabilities.images.routing`;
  // `category` is schema-optional (`imageRoutingMetadataSchema`) purely so a missing value
  // reaches here — with the entity's key in hand — instead of failing during the raw
  // declaration parse, where only a declaration index is known. An unrecognized category
  // value still fails at the schema's `z.enum`, before this ever runs.
  if (routing.category === undefined)
    throw new EntityDeclarationError(`${context}.category is required.`);
  const validateFields = (
    keys: readonly string[],
    allowed: readonly EntityField["kind"][],
    name: string,
  ): void => {
    if (new Set(keys).size !== keys.length)
      throw new EntityDeclarationError(
        `${context}.${name} contains duplicates.`,
      );
    for (const key of keys) {
      const field = imagePolicyField(entity, key, `${context}.${name}`);
      if (!allowed.includes(field.kind))
        throw new EntityDeclarationError(
          `${context}.${name}.${key} has incompatible ${field.kind} field type.`,
        );
    }
  };
  validateFields(
    routing.candidateFields,
    ["text", "text-array", "enum"],
    "candidateFields",
  );
  validateFields(
    routing.temporalFields,
    ["date", "timestamp"],
    "temporalFields",
  );
  validateFields(
    routing.signals.ocrFields,
    ["text", "text-array"],
    "signals.ocrFields",
  );
  for (const filter of routing.lifecycleFilters) {
    const field = imagePolicyField(
      entity,
      filter.field,
      `${context}.lifecycleFilters`,
    );
    if (!["boolean", "enum", "text"].includes(field.kind))
      throw new EntityDeclarationError(
        `${context}.lifecycleFilters.${filter.field} has incompatible ${field.kind} field type.`,
      );
    const values = "oneOf" in filter ? filter.oneOf : [filter.equals];
    if (
      field.kind === "enum" &&
      values.some(
        (value) => field.validation.read?.safeParse(value).success !== true,
      )
    )
      throw new EntityDeclarationError(
        `${context}.lifecycleFilters.${filter.field} contains a value outside the declared enum.`,
      );
    if (new Set(values.map(String)).size !== values.length)
      throw new EntityDeclarationError(
        `${context}.lifecycleFilters.${filter.field} contains duplicate values.`,
      );
  }
};

/** Validate image routes after the complete relationship graph is available. */
const validateImagePolicies = (entities: readonly CompiledEntity[]): void => {
  const routeOwners = new Map<string, string>();
  for (const entity of entities) {
    validateImageIngress(entities, entity, routeOwners);
    validateImageDisplaySources(entities, entity);
    validateImageVisualEvidence(entities, entity);
    validateImageRouting(entity);
  }
};

export const compileEntityDeclarations = (
  declarations: readonly unknown[],
): CompiledEntity[] => {
  if (declarations.length === 0)
    throw new EntityDeclarationError("Entity declarations must not be empty.");
  const entities = deriveRelationSections(
    validateDataQualityDeclarations(
      deriveInverseRelations(
        deriveImageDisplaySources(
          declarations.map((value, index) =>
            objectValue(value, `ENTITY_DECLARATIONS[${index}]`),
          ),
        ),
      ).map(compileEntity),
    ),
  );
  validateEntityIdentities(entities);
  validateReferenceScopes(entities);
  validatePhotoCategoryLabels(photoCategories);
  validateImagePolicies(entities);
  validateRelationSections(entities);
  return entities;
};
