import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  entityFieldControlKinds as fieldControlKinds,
  entityFieldKinds as fieldKinds,
  parseEntityDeclarationMetadata,
} from "../packages/schemas/src/entity-definitions/definition.ts";
import type {
  EntityDeclarationMetadata,
  EntityFieldModelMetadata,
  EntityFieldControlKind,
  EntityFieldKind,
  EntityStorageMetadata,
  EntityStorageDefaultKind,
} from "../packages/schemas/src/entity-definitions/definition.ts";
import { z } from "zod";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_DIRECTORY = resolve(ROOT, "packages/schemas/src/entity-definitions");

type DeclarationValue =
  | string
  | number
  | boolean
  | null
  | DeclarationObject
  | z.ZodType
  | DeclarationValue[];
interface DeclarationObject {
  [key: string]: DeclarationValue;
}

type SourceRef = Readonly<{ module: string; export: string }>;
type ParsedEntityRoute = { basePath: string; detailParam?: string };
type IdentifierRef = Readonly<{
  entity: string;
  kind: "id" | "shortcode";
}>;
type FilterDescriptor = Readonly<{
  columnId: string;
  field: string | null;
  urlKey: string;
  kind:
    | "text"
    | "select"
    | "multiselect"
    | "presence"
    | "boolean"
    | "id"
    | "idMulti"
    | "range";
  placeholder: string;
  options:
    | readonly Readonly<{
        value: string;
        label: string;
        meta?: boolean;
        color?: string;
      }>[]
    | null;
  optionsRef: SourceRef | null;
  optionsKey: string | null;
  label: string | null;
  schemaDescription: string | null;
  deriveSchema: boolean;
  schemaFromRead: boolean;
  brandRef: IdentifierRef | null;
  expandRef: SourceRef | null;
  urlOnly: boolean;
  nullable: Readonly<{ field: string; label: string }> | null;
}>;
type EntityPorts = Readonly<{
  repository: SourceRef | null;
  references: Readonly<{ label: SourceRef | null; resolver: SourceRef | null }>;
  filters: SourceRef | null;
  search: Readonly<{
    projection: SourceRef | null;
    semanticText: SourceRef | null;
    dependentRefresh: SourceRef | null;
  }>;
}>;
type RelationMutation = Readonly<{
  entity: string;
  relation: string;
  target: string;
  source: string;
  itemSchema: SourceRef;
  adapter: SourceRef;
  audiences: readonly ("browser" | "mcp")[];
}>;
type OperationOwner = "kernel" | "workflow" | null;
type EntityFieldControl = Readonly<{
  kind: EntityFieldControlKind;
  renderer: string | null;
  options: readonly Readonly<{ value: string; label: string }>[] | null;
  section: string;
}>;
type EntityField = Readonly<{
  key: string;
  kind: EntityFieldKind;
  nullable: boolean;
  label: string;
  description: string | null;
  readKey: string | null;
  reference: Readonly<{ entity: string; multiple: boolean }> | null;
  control: EntityFieldControl | null;
  display: Readonly<{
    list: boolean;
    detail: boolean;
    columnId: string | null;
    standard: "name" | "image" | null;
    detailOrder: number | null;
    detailSection: string;
  }>;
  validation: Readonly<{
    read: z.ZodType | null;
    create: z.ZodType | null;
    update: z.ZodType | null;
  }>;
}>;
type EntityStorageField = Readonly<{
  key: string;
  column: string;
  kind: EntityFieldKind;
  nullable: boolean;
  default: EntityStorageDefaultKind;
  defaultValue: DeclarationValue;
  reference: string | null;
  specialized: string | null;
}>;
type EntityFieldModel = Readonly<{
  fields: readonly EntityField[];
  storage: readonly EntityStorageField[];
  create: readonly string[];
  update: readonly string[];
  bulk: readonly string[];
  audit: readonly string[];
  output: readonly string[];
}>;
export type CompiledEntity = Readonly<{
  key: string;
  shortcode: string | null;
  legacyShortcode: string | null;
  inspector: Readonly<{
    singular: string;
    plural: string | null;
    titleField: string;
  }>;
  descriptor: DeclarationObject;
  contract: Readonly<{
    create: SourceRef | null;
    update: SourceRef | null;
    output: SourceRef;
    list: SourceRef;
    detail: SourceRef;
    mcpOutput: SourceRef;
    mcpList: SourceRef;
    mcpDetail: SourceRef;
  }> | null;
  route: Readonly<ParsedEntityRoute> | null;
  filterAudit: boolean;
  filterUrlKeys: readonly string[];
  filterSchema: SourceRef | null;
  filterDescriptors: readonly FilterDescriptor[];
  /** Fields a `bulkUpdate` command may patch; null means the capability is undeclared. */
  bulkUpdateFields: readonly string[] | null;
  ports: EntityPorts;
  relations: EntityDeclarationMetadata["relations"];
  relationMutations: readonly RelationMutation[];
  lifecycle: Readonly<{
    softDelete: boolean;
    delete: DeclarationValue | null;
    merge: boolean;
  }>;
  mcpActions: readonly string[];
  operationOwners: Readonly<{
    delete: OperationOwner;
    merge: OperationOwner;
  }>;
  fieldModel: EntityFieldModel;
}>;

export type EntityArtifacts = Readonly<{
  relativePath: string;
  source: string;
}>;

type ContractEntity = CompiledEntity & {
  contract: NonNullable<CompiledEntity["contract"]>;
};

type EntityProjectionMaps = Readonly<{
  schema: readonly ContractEntity[];
  detail: readonly ContractEntity[];
  list: readonly ContractEntity[];
  filters: readonly CompiledEntity[];
  routes: readonly CompiledEntity[];
}>;

/**
 * Detail, list, and filter artifacts consume the same compiled schema map.
 * Keep the surface selection here so generated projections cannot quietly
 * drift into independently-maintained entity rosters.
 */
const entityProjectionMaps = (
  entities: readonly CompiledEntity[],
): EntityProjectionMaps => {
  const schema = entities.filter(
    (entity): entity is ContractEntity => entity.contract !== null,
  );
  const detail = schema.filter(
    ({ contract }) => contract.create !== null && contract.update !== null,
  );
  const list = detail.filter(
    ({ descriptor }) => descriptor.browserRoutes !== false,
  );
  return {
    schema,
    detail,
    list,
    filters: entities,
    routes: entities.filter(
      ({ descriptor }) => descriptor.browserRoutes !== false,
    ),
  };
};

class EntityDeclarationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityDeclarationError";
  }
}

const isDeclarationObject = (value: unknown): value is DeclarationObject =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof z.ZodType);

const isNonEmptyString = (value: DeclarationValue): value is string =>
  typeof value === "string" && value.length > 0;

const isBoolean = (value: DeclarationValue): value is boolean =>
  typeof value === "boolean";

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This compiler boundary validates imported declaration values before consuming them.
const objectValue = (value: unknown, context: string): DeclarationObject => {
  if (!isDeclarationObject(value)) {
    throw new EntityDeclarationError(`${context} must be an object.`);
  }
  return value;
};

const required = (object: DeclarationObject, key: string, context: string) => {
  if (!(key in object)) {
    throw new EntityDeclarationError(`${context}.${key} is required.`);
  }
  const value = object[key];
  if (value === undefined) {
    throw new EntityDeclarationError(
      `${context}.${key} must not be undefined.`,
    );
  }
  return value;
};

const stringValue = (value: DeclarationValue, context: string): string => {
  if (!isNonEmptyString(value)) {
    throw new EntityDeclarationError(`${context} must be a non-empty string.`);
  }
  return value;
};

const booleanValue = (value: DeclarationValue, context: string): boolean => {
  if (!isBoolean(value)) {
    throw new EntityDeclarationError(`${context} must be a boolean.`);
  }
  return value;
};

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
  };
};
const filterKinds = [
  "text",
  "select",
  "multiselect",
  "presence",
  "boolean",
  "id",
  "idMulti",
  "range",
] as const;

const compileFieldModel = (
  value: EntityFieldModelMetadata | undefined,
  context: string,
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
    if (!field.display.detailSection.trim())
      throw new EntityDeclarationError(
        `${fieldContext}.display.detailSection must not be blank.`,
      );
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
      control: field.control,
      display: {
        columnId: field.display.columnId,
        standard: field.display.standard,
        detailSection: field.display.detailSection,
        detailOrder: field.display.detailOrder,
        list: field.display.list,
        detail: field.display.detail,
      },
      validation: field.validation,
    };
  });
  const displayedColumnIds = new Set<string>();
  for (const field of fields) {
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
  const compiled = {
    fields,
    storage,
    create: policy("create"),
    update: policy("update"),
    bulk: policy("bulk"),
    audit: policy("audit"),
    output: policy("output"),
  };
  for (const field of compiled.bulk) {
    if (!compiled.update.includes(field))
      throw new EntityDeclarationError(
        `${context}.bulk field ${field} must also be updateable.`,
      );
  }
  return compiled;
};

const filterDescriptor = (
  value: EntityDeclarationMetadata["filters"]["descriptors"][number],
  context: string,
): FilterDescriptor => {
  const parsedKind = filterKinds.find((candidate) => candidate === value.kind);
  if (parsedKind === undefined) {
    throw new EntityDeclarationError(`${context}.kind is unsupported.`);
  }
  const options = value.options ?? null;
  const optionsRef = value.optionsRef ?? null;
  if (options !== null && optionsRef !== null) {
    throw new EntityDeclarationError(
      `${context} cannot declare both options and optionsRef.`,
    );
  }
  const nullable = value.nullable ?? null;
  const deriveSchema = value.deriveSchema ?? false;
  const schemaFromRead = value.schemaFromRead ?? false;
  const schemaDescription = value.schemaDescription ?? null;
  if (!deriveSchema && (schemaFromRead || schemaDescription !== null))
    throw new EntityDeclarationError(
      `${context} schemaFromRead/schemaDescription require deriveSchema.`,
    );
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
    schemaDescription,
    deriveSchema,
    schemaFromRead,
    brandRef: value.brandRef ?? null,
    expandRef: value.expandRef ?? null,
    urlOnly: value.urlOnly ?? false,
    nullable,
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
  if (declaration.identifiers.legacy !== null) {
    descriptor.legacyShortcodePrefix = declaration.identifiers.legacy;
  }
  descriptor.softDelete = declaration.capabilities.softDelete;
  if (declaration.route === null) descriptor.browserRoutes = false;
  descriptor.auditable = declaration.capabilities.auditable;
  descriptor.hasImages = declaration.capabilities.images;
  descriptor.searchable = declaration.search.enabled;
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
  key: "shortcodePrefix" | "legacyShortcodePrefix",
  expression: RegExp,
  label: string,
  context: string,
): string | null => {
  const value = descriptor[key];
  if (value === undefined) return null;
  const shortcode = stringValue(value, `${context}.descriptor.${key}`);
  if (!expression.test(shortcode))
    throw new EntityDeclarationError(
      `${context}.descriptor.${key} must be an ${label} prefix.`,
    );
  return shortcode;
};

// One compiler pass keeps cross-field capability errors attached to the exact
// entity declaration rather than losing context across partial validators.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- imported declaration boundary
const compileEntity = (value: unknown, index: number): CompiledEntity => {
  const context = `ENTITY_DECLARATIONS[${index}]`;
  const raw = objectValue(value, context);
  const { filterSchemas: _filterSchemas, ...declared } = raw;
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
  const fieldModel = compileFieldModel(declaration.model, `${context}.model`);
  const operationOwners = {
    delete: declaration.capabilities.operationOwners.delete,
    merge: declaration.capabilities.operationOwners.merge,
  };
  const inspector = {
    singular: declaration.names.singular,
    plural: declaration.names.plural,
    titleField: declaration.presentation.titleField,
  };
  const filters = declaration.filters;
  const filterAudit = filters.audit === undefined ? false : filters.audit;
  const filterSchema =
    filters.schema === undefined || filters.schema === null
      ? null
      : { module: filters.schema.module, export: filters.schema.export };
  const filterDescriptors = filters.descriptors.map((value, index) =>
    filterDescriptor(value, `${context}.filters.descriptors[${index}]`),
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
          expandRef: {
            module: "~/entities/filter-behavior",
            export: "resolveCreatedDate",
          },
          urlOnly: false,
          nullable: null,
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
          expandRef: {
            module: "~/entities/filter-behavior",
            export: "resolveUpdatedDate",
          },
          urlOnly: false,
          nullable: null,
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
  const shortcode = compiledShortcode(
    descriptor,
    "shortcodePrefix",
    /^[A-Z]{3}-$/,
    "XXX-",
    context,
  );
  const legacyShortcode = compiledShortcode(
    descriptor,
    "legacyShortcodePrefix",
    /^[A-Z]-$/,
    "X-",
    context,
  );
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
  const ports = entityPorts(declaration.extensions.ports);
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
    legacyShortcode,
    inspector,
    contract,
    descriptor,
    route,
    filterUrlKeys,
    filterSchema,
    filterAudit,
    filterDescriptors: filterDescriptorsWithAudit,
    bulkUpdateFields,
    ports,
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
  };
};

const validateEntityIdentities = (entities: readonly CompiledEntity[]) => {
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
    if (entity.legacyShortcode === null) continue;
    const owner = prefixes.get(entity.legacyShortcode);
    if (owner !== undefined) {
      throw new EntityDeclarationError(
        `Legacy shortcode prefix ${entity.legacyShortcode} for ${entity.key} conflicts with ${owner}.`,
      );
    }
    prefixes.set(entity.legacyShortcode, `${entity.key} legacy prefix`);
  }
};

export const compileEntityDeclarations = (
  declarations: readonly unknown[],
): CompiledEntity[] => {
  if (declarations.length === 0)
    throw new EntityDeclarationError("Entity declarations must not be empty.");
  const entities = declarations.map(compileEntity);
  validateEntityIdentities(entities);
  return entities;
};

const declarationModules = new Map<
  string,
  { path: string; enumExports: string[]; hasFilters: boolean }
>();

export const loadEntityDeclarations = async (): Promise<CompiledEntity[]> => {
  const entries = (await readdir(SPEC_DIRECTORY, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".entity.ts"))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0)
    throw new EntityDeclarationError(
      `${SPEC_DIRECTORY} has no entity declarations.`,
    );
  const entities = await Promise.all(
    entries.map(async (entry) => {
      const module = await import(
        pathToFileURL(resolve(SPEC_DIRECTORY, entry.name)).href
      );
      const raw = objectValue(module.default, entry.name);
      const { filterSchemas: declaredFilters, ...metadata } = raw;
      const filterSchemas = module.filterSchemas ?? declaredFilters;
      if (filterSchemas !== undefined) {
        for (const [key, schema] of Object.entries(
          objectValue(filterSchemas, entry.name),
        ))
          if (!(schema instanceof z.ZodType))
            throw new EntityDeclarationError(
              `${entry.name}.filterSchemas.${key} must be a Zod schema.`,
            );
      }
      const entity = compileEntity(metadata, 0);
      declarationModules.set(entity.key, {
        path: `../entity-definitions/${entry.name.replace(/\.ts$/, "")}`,
        enumExports: Object.keys(module).filter((key) =>
          key.startsWith("generated"),
        ),
        hasFilters: filterSchemas !== undefined,
      });
      return entity;
    }),
  );
  const routes = new Set<string>();
  validateEntityIdentities(entities);
  for (const entity of entities) {
    if (entity.descriptor.browserRoutes === false) continue;
    for (const route of Object.values(browserRoutes(entity).routes)) {
      if (routes.has(route))
        throw new EntityDeclarationError(`Duplicate browser route ${route}.`);
      routes.add(route);
    }
  }
  return entities;
};

const generatedHeader =
  "// Generated by `pnpm entity:generate` from `packages/schemas/src/entity-definitions/*.entity.ts`. Do not edit.\n\n";

const compactLiteral = <T>(value: T) =>
  JSON.stringify(value).replaceAll(
    /"([A-Za-z_$][\w$]*)":/g,
    (_, key: string) => `${key}:`,
  );

const entityColumnFunctionName = (entity: string) =>
  `generated${entity[0]?.toUpperCase() ?? ""}${entity.slice(1).replaceAll("-", "")}Columns`;

const identifierTypeNames = {
  cookbook: "CookbookId",
  expense: "ExpenseId",
  financialAccount: "FinancialAccountId",
  financialTransaction: "FinancialTransactionId",
  ingredient: "IngredientId",
  inventory: "InventoryId",
  ledgerParty: "LedgerPartyId",
  ledgerTransfer: "LedgerTransferId",
  location: "LocationId",
  meal: "MealId",
  product: "ProductId",
  project: "ProjectId",
  purchase: "PurchaseId",
  recipe: "RecipeId",
  task: "TaskId",
  vendor: "VendorId",
  wish: "WishId",
} as const satisfies Readonly<Record<string, string>>;

const storageJsonTypes = {
  "cookbook.rawJson": "ImportRecipe[]",
  "financialAccount.identity": "FinancialAccountIdentity",
  "financialAccount.sourceAliases": "FinancialAccountSourceAlias[]",
  "financialTransaction.sourceRefs": "FinancialTransactionSourceRef[]",
  "ingredient.naKinds": "BaseKind[]",
  "inventory.amount": "Amount",
  "location.valuation": "LocationValuation | null",
  "product.dataExceptions": "DataException[]",
  "purchase.dataExceptions": "DataException[]",
  "recipe.meta": "RecipeStoredMeta | null",
  "recipe.totals": "RecipeTotals | null",
  "recipe.yield": "RecipeYield",
} as const satisfies Readonly<Record<string, string>>;

const lookupGeneratedType = (
  values: Readonly<Record<string, string>>,
  key: string,
): string | undefined => values[key];

const enumColumnExpression = (
  entity: string,
  field: EntityStorageField,
): string | null => {
  const column = JSON.stringify(field.column);
  const key = `${entity}.${field.key}`;
  const expressions = {
    "expense.costType": `text(${column},{enum:costTypeValues})`,
    "expense.lineBasis": `text(${column},{enum:expenseLineBasisValues})`,
    "expense.lineKind": `text(${column},{enum:expenseLineKindValues})`,
    "expense.trade": `text(${column},{enum:tradeValues})`,
    "image.renderStatus": `imageRenderStatusEnum(${column})`,
    "image.status": `imageStatusEnum(${column})`,
    "image.storageStatus": `imageStorageStatusEnum(${column})`,
    "inventory.placement": `inventoryPlacementEnum(${column})`,
    "meal.mealKind": `text(${column},{enum:mealKindValues})`,
    "meal.mealType": `text(${column},{enum:mealTypeValues})`,
    "product.category": `text(${column},{enum:productCategoryValues})`,
    "project.kind": `text(${column},{enum:projectKindValues})`,
    "project.status": `text(${column},{enum:projectStatusValues})`,
    "recipe.SourceType": `recipeSourceEnum(${column})`,
    "task.status": `text(${column},{enum:taskStatusValues})`,
    "task.trade": `text(${column},{enum:tradeValues})`,
  } as const satisfies Readonly<Record<string, string>>;
  return lookupGeneratedType(expressions, key) ?? null;
};

const literalDefaultExpression = (value: DeclarationValue): string => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- String storage defaults have SQL-specific serialization.
  if (typeof value === "string") {
    if (value === "'{}'::text[]") return "sql`'{}'::text[]`";
    if (value === "'[]'::jsonb") return "[]";
    if (value.startsWith("'") && value.endsWith("'"))
      return JSON.stringify(value.slice(1, -1));
  }
  return compactLiteral(value);
};

// oxlint-disable-next-line eslint/complexity -- Ordered branches mirror the finite storage-column DSL.
const renderStorageColumn = (
  entity: CompiledEntity,
  field: EntityStorageField,
): string => {
  const column = JSON.stringify(field.column);
  const ownIdType = lookupGeneratedType(identifierTypeNames, entity.key);
  const referenceIdType =
    field.reference === null
      ? null
      : lookupGeneratedType(identifierTypeNames, field.reference);
  let expression: string;
  if (field.key === "id") {
    expression =
      ownIdType === undefined
        ? `uuid(${column}).primaryKey().default(sql\`gen_random_uuid()\`)`
        : `uuid(${column}).primaryKey().default(sql\`gen_random_uuid()\`).$type<${ownIdType}>()`;
  } else if (field.key === "shortcode") {
    expression = `text(${column}).notNull()`;
  } else if (field.kind === "identifier") {
    expression = `uuid(${column})`;
    if (referenceIdType !== undefined && referenceIdType !== null)
      expression += `.$type<${referenceIdType}>()`;
  } else if (field.kind === "text-array") {
    expression = `text(${column}).array()`;
    if (entity.key === "ingredient" && field.key === "naKinds")
      expression += ".$type<BaseKind[]>()";
  } else if (field.kind === "text") {
    expression = `text(${column})`;
  } else if (field.kind === "number") {
    expression =
      field.specialized === "real"
        ? `real(${column})`
        : field.specialized === "double-precision"
          ? `doublePrecision(${column})`
          : `integer(${column})`;
  } else if (field.kind === "boolean") {
    expression = `boolean(${column})`;
  } else if (field.kind === "date") {
    expression = `date(${column},{mode:"string"})`;
  } else if (field.kind === "timestamp") {
    expression = `timestamp(${column},{mode:"date"})`;
  } else if (field.kind === "json") {
    expression = `jsonb(${column})`;
    const jsonType = lookupGeneratedType(
      storageJsonTypes,
      `${entity.key}.${field.key}`,
    );
    if (jsonType !== undefined) expression += `.$type<${jsonType}>()`;
  } else {
    expression = enumColumnExpression(entity.key, field) ?? `text(${column})`;
    if (entity.key === "ledgerParty" && field.key === "kind")
      expression += ".$type<LedgerPartyKind>()";
  }
  if (
    field.key !== "id" &&
    field.key !== "shortcode" &&
    field.nullable === false
  )
    expression += ".notNull()";
  if (field.default === "now") expression += ".defaultNow()";
  if (field.default === "literal")
    expression += `.default(${literalDefaultExpression(field.defaultValue)})`;
  if (field.specialized === "updated-at")
    expression += ".$onUpdate(() => new Date())";
  if (field.reference !== null)
    expression += `.references(references[${JSON.stringify(field.reference)}])`;
  return `${JSON.stringify(field.key)}:${expression}`;
};

const renderEntityColumnsArtifact = (
  entities: readonly CompiledEntity[],
): string => {
  const columnModels = entities.filter(
    (entity) => entity.fieldModel.storage.length > 0,
  );
  const functions = columnModels
    .map((entity) => {
      const references = [
        ...new Set(
          entity.fieldModel.storage.flatMap((field) =>
            field.reference === null ? [] : [field.reference],
          ),
        ),
      ].sort();
      const parameter =
        references.length === 0
          ? ""
          : `references: Readonly<{${references.map((reference) => `${JSON.stringify(reference)}: () => AnyPgColumn`).join(";")}}>`;
      return `export const ${entityColumnFunctionName(entity.key)} = (${parameter}) => ({${entity.fieldModel.storage.map((field) => renderStorageColumn(entity, field)).join(",")}});`;
    })
    .join("\n\n");
  return (
    generatedHeader +
    'import type { Amount } from "@cubby/schemas/codec";\n' +
    'import type { DataException } from "@cubby/schemas/data-quality";\n' +
    'import type { FinancialAccountIdentity, FinancialAccountSourceAlias } from "@cubby/schemas/financial-account";\n' +
    'import type { FinancialTransactionSourceRef } from "@cubby/schemas/financial-transaction";\n' +
    `import type { ${Object.values(identifierTypeNames).sort().join(", ")} } from "@cubby/schemas/identifiers";\n` +
    'import { imageStatusValues } from "@cubby/schemas/image";\n' +
    'import type { ImportRecipe } from "@cubby/schemas/import-recipe";\n' +
    'import type { LedgerPartyKind } from "@cubby/schemas/ledger-party";\n' +
    'import type { LocationValuation } from "@cubby/schemas/location";\n' +
    'import { mealKindValues, mealTypeValues } from "@cubby/schemas/meal-classification";\n' +
    'import type { BaseKind } from "@cubby/schemas/problems";\n' +
    'import { productCategoryValues } from "@cubby/schemas/product";\n' +
    'import { costTypeValues, projectKindValues, projectStatusValues, taskStatusValues, tradeValues } from "@cubby/schemas/project";\n' +
    'import { expenseLineBasisValues, expenseLineKindValues } from "@cubby/schemas/expense-line-kind";\n' +
    'import type { RecipeStoredMeta, RecipeTotals, RecipeYield } from "@cubby/schemas/recipe-shared";\n' +
    'import { recipeSourceValues } from "@cubby/schemas/recipe-shared";\n' +
    'import { inventoryPlacementValues } from "@cubby/shared";\n' +
    'import { sql } from "drizzle-orm";\n' +
    'import { type AnyPgColumn, boolean, date, doublePrecision, integer, jsonb, pgEnum, real, text, timestamp, uuid } from "drizzle-orm/pg-core";\n\n' +
    'export const recipeSourceEnum = pgEnum("RecipeSource", recipeSourceValues);\n' +
    'export const imageStatusEnum = pgEnum("ImageStatus", imageStatusValues);\n' +
    'export const inventoryPlacementEnum = pgEnum("InventoryPlacement", inventoryPlacementValues);\n' +
    'export const imageRenderStatusEnum = pgEnum("ImageRenderStatus", ["unverified", "verified", "failed"]);\n' +
    'export const imageStorageStatusEnum = pgEnum("ImageStorageStatus", ["unverified", "available", "missing", "metadata_mismatch"]);\n\n' +
    functions +
    "\n"
  );
};

/** PascalCase model name (as recorded in `descriptor.dbTable`) to its Drizzle export name. */
const lowerCamelCase = (value: string): string =>
  value.length === 0
    ? value
    : `${value[0]?.toLowerCase() ?? ""}${value.slice(1)}`;

const browserRouteExtension = new Map<
  string,
  Readonly<{ basePath: string; detailParam?: string }>
>([
  ["inventory", { basePath: "inventory" }],
  ["usda-food", { basePath: "usda", detailParam: "id" }],
]);

const browserBasePath = (entity: string): string =>
  browserRouteExtension.get(entity)?.basePath ??
  (() => {
    const singular = entity.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    return singular.endsWith("y")
      ? `${singular.slice(0, -1)}ies`
      : /(?:s|x|z|ch|sh)$/.test(singular)
        ? `${singular}es`
        : `${singular}s`;
  })();

const browserRoutes = (entity: CompiledEntity) => {
  const basePath = entity.route?.basePath ?? browserBasePath(entity.key);
  const detailParam =
    entity.route?.detailParam ??
    browserRouteExtension.get(entity.key)?.detailParam ??
    "shortcode";
  return {
    basePath,
    routes: { detail: `/${basePath}/$${detailParam}`, list: `/${basePath}` },
  };
};

export const expectedBrowserRouteFiles = (
  entities: readonly CompiledEntity[],
): readonly string[] =>
  entities
    .filter(({ descriptor }) => descriptor.browserRoutes !== false)
    .flatMap((entity) => {
      const { basePath, routes } = browserRoutes(entity);
      const detailParameter = routes.detail.slice(
        routes.detail.lastIndexOf("/$") + 1,
      );
      return [
        `apps/web/src/routes/_authenticated/${basePath}.index.tsx`,
        `apps/web/src/routes/_authenticated/${basePath}.${detailParameter}.tsx`,
      ];
    });

export const missingBrowserRouteFiles = (
  entities: readonly CompiledEntity[],
  exists: (path: string) => boolean = existsSync,
): readonly string[] =>
  expectedBrowserRouteFiles(entities).filter(
    (relativePath) => !exists(resolve(ROOT, relativePath)),
  );

// One render pass preserves deterministic cross-artifact ordering and hashes.
// oxlint-disable-next-line eslint/complexity
export const renderEntityArtifacts = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
  const projections = entityProjectionMaps(entities);
  const relationMutations = entities.flatMap(
    (entity) => entity.relationMutations,
  );
  const relationMutationKeys = relationMutations.map(
    ({ entity, relation }) => `${entity}:${relation}`,
  );
  if (new Set(relationMutationKeys).size !== relationMutationKeys.length) {
    throw new EntityDeclarationError("Relation mutation keys must be unique.");
  }
  const relationSchemaImports = [
    ...new Map(
      relationMutations.map(({ itemSchema }) => [
        `${itemSchema.module}#${itemSchema.export}`,
        itemSchema,
      ]),
    ).values(),
  ]
    .sort((left, right) =>
      `${left.module}#${left.export}`.localeCompare(
        `${right.module}#${right.export}`,
      ),
    )
    .map(
      ({ module, export: exportName }) =>
        `import { ${exportName} } from ${JSON.stringify(module)};`,
    )
    .join("\n");
  const relationCommandVariant = ({
    entity,
    relation,
    target,
    itemSchema,
  }: RelationMutation) =>
    `z.object({action:z.enum(["attach","detach"]),entity:z.literal(${JSON.stringify(entity)}),relation:z.literal(${JSON.stringify(relation)}),id:shortcodeSchema(${JSON.stringify(entity)}),items:z.array(${itemSchema.export}.extend({id:shortcodeSchema(${JSON.stringify(target)})})).min(1).max(500)}).strict()`;
  const relationCommandSchema = (
    audience: "browser" | "mcp" | null,
  ): string => {
    const mutations =
      audience === null
        ? relationMutations
        : relationMutations.filter(({ audiences }) =>
            audiences.includes(audience),
          );
    return mutations.length === 0
      ? "z.never()"
      : `z.union([\n  ${mutations.map(relationCommandVariant).join(",\n  ")}\n])`;
  };
  const relationResultSchema =
    relationMutations.length === 0
      ? "z.never()"
      : `z.union([\n  ${relationMutations
          .map(
            ({ entity, relation }) =>
              `z.object({action:z.enum(["attach","detach"]),entity:z.literal(${JSON.stringify(entity)}),relation:z.literal(${JSON.stringify(relation)}),result:relationMutationOut})`,
          )
          .join(",\n  ")}\n])`;
  const mcpRelationMutations = relationMutations.filter(({ audiences }) =>
    audiences.includes("mcp"),
  );
  const mcpParentIdSchemas = [
    ...new Set(
      mcpRelationMutations.map(
        ({ entity }) => `shortcodeSchema(${JSON.stringify(entity)})`,
      ),
    ),
  ];
  const mcpItemSchemas = [
    ...new Set(
      mcpRelationMutations.map(
        ({ itemSchema, target }) =>
          `${itemSchema.export}.extend({id:shortcodeSchema(${JSON.stringify(target)})})`,
      ),
    ),
  ];
  const schemaUnion = (schemas: readonly string[]) =>
    schemas.length === 1 ? schemas[0] : `z.union([${schemas.join(",")}])`;
  const mcpPreviewInputSchema =
    mcpRelationMutations.length === 0
      ? "z.never()"
      : `z.object({action:z.enum(["attach","detach"]),entity:z.enum(${compactLiteral([...new Set(mcpRelationMutations.map(({ entity }) => entity))])}),relation:z.enum(${compactLiteral([...new Set(mcpRelationMutations.map(({ relation }) => relation))])}),id:${schemaUnion(mcpParentIdSchemas)},items:z.array(${schemaUnion(mcpItemSchemas)}).min(1).max(500)}).strict().superRefine((input,ctx)=>{const result=generatedMcpEntityRelationCommandSchema.safeParse(input);if(!result.success){for(const issue of result.error.issues)ctx.addIssue({code:"custom",path:issue.path,message:issue.message});}})`;
  const relationAdapterImports = [
    ...new Map(
      relationMutations.map(({ adapter }) => [
        `${adapter.module}#${adapter.export}`,
        adapter,
      ]),
    ).values(),
  ]
    .sort((left, right) =>
      `${left.module}#${left.export}`.localeCompare(
        `${right.module}#${right.export}`,
      ),
    )
    .map(
      ({ module, export: exportName }) =>
        `import { ${exportName} } from ${JSON.stringify(module)};`,
    )
    .join("\n");
  const relationRuntimeCases = relationMutations
    .map(
      ({ entity, relation, adapter }) =>
        `    case ${JSON.stringify(`${entity}:${relation}`)}: {\n      const result = await ${adapter.export}.execute(ctx,command.action,command.id,command.items);\n      return {action:command.action,entity:${JSON.stringify(entity)},relation:${JSON.stringify(relation)},result};\n    }`,
    )
    .join("\n");
  const relationTargetCases = relationMutations
    .map(
      ({ entity, relation, target }) =>
        `    case ${JSON.stringify(`${entity}:${relation}`)}: return ${JSON.stringify(target)};`,
    )
    .join("\n");
  const relationPreviewCases = relationMutations
    .map(
      ({ entity, relation, adapter }) =>
        `    case ${JSON.stringify(`${entity}:${relation}`)}: return ${adapter.export}.preview(db,command.action,ownerId,targetIds);`,
    )
    .join("\n");
  const imports = new Map<string, Set<string>>();
  for (const { contract, filterSchema } of entities) {
    if (contract === null) continue;
    for (const ref of [
      contract.create,
      contract.update,
      contract.output,
      contract.list,
      contract.detail,
      contract.mcpOutput,
      contract.mcpList,
      contract.mcpDetail,
      filterSchema,
    ]) {
      if (ref === null) continue;
      const exports = imports.get(ref.module) ?? new Set<string>();
      exports.add(ref.export);
      imports.set(ref.module, exports);
    }
  }
  const schemaImportEntries = [...imports.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const identifierImportIndex = schemaImportEntries.findIndex(
    ([module]) => module.localeCompare("@cubby/schemas/identifiers") > 0,
  );
  schemaImportEntries.splice(
    identifierImportIndex === -1
      ? schemaImportEntries.length
      : identifierImportIndex,
    0,
    ["@cubby/schemas/identifiers", new Set(["shortcodeSchema"])],
  );
  const schemaImports = schemaImportEntries
    .map(
      ([module, exports]) =>
        `import { ${[...exports].sort().join(", ")} } from ${JSON.stringify(module)};`,
    )
    .join("\n");
  const schemaEntitySpecs = projections.schema;
  const schemaBindings = schemaEntitySpecs
    .map((entity) => {
      const { contract, filterSchema } = entity;
      if (entity.bulkUpdateFields !== null && contract.update === null) {
        throw new EntityDeclarationError(
          `${entity.key}.bulkUpdate requires an update contract.`,
        );
      }
      const bulkUpdateInput =
        entity.bulkUpdateFields === null
          ? "null"
          : `${contract.update?.export}.pick({${entity.bulkUpdateFields
              .map((field) => `${JSON.stringify(field)}:true`)
              .join(",")}}).strict()`;
      const filters =
        filterSchema === null
          ? "z.object({})"
          : `z.object(${filterSchema.export})`;
      return `  ${JSON.stringify(entity.key)}: entitySchema(${JSON.stringify(entity.key)},{filters:${filters},createInput:${contract.create?.export ?? "null"},updateInput:${contract.update?.export ?? "null"},bulkUpdateInput:${bulkUpdateInput},output:${contract.output.export},detail:${contract.detail.export},list:${contract.list.export},mcpOutput:${contract.mcpOutput.export},mcpDetail:${contract.mcpDetail.export},mcpList:${contract.mcpList.export}}),`;
    })
    .join("\n");
  const bindings = entities
    .filter((entity) => entity.shortcode !== null)
    .map((entity) => {
      if (
        entity.contract === null ||
        entity.contract.create === null ||
        entity.contract.update === null
      )
        return `  ${JSON.stringify(entity.key)}: { crud: null },`;
      return `  ${JSON.stringify(entity.key)}: {crud:ENTITY_SCHEMA_BINDINGS[${JSON.stringify(entity.key)}]},`;
    })
    .join("\n");
  const detailEntities = projections.detail;
  const detailSchemas = detailEntities
    .map(
      ({ key, contract }) =>
        `  ${JSON.stringify(key)}: ${contract.detail.export},`,
    )
    .join("\n");
  const detailTypeImports = new Map<string, Set<string>>();
  for (const { contract } of detailEntities) {
    const exports =
      detailTypeImports.get(contract.detail.module) ?? new Set<string>();
    exports.add(contract.detail.export);
    detailTypeImports.set(contract.detail.module, exports);
  }
  const detailRuntimeImportSource = [
    ...[...detailTypeImports.entries()].map(([module, exports]) => ({
      module,
      source: `import { ${[...exports].sort().join(", ")} } from ${JSON.stringify(module)};`,
    })),
    {
      module: "@cubby/schemas/identifiers",
      source: 'import { shortcodeSchema } from "@cubby/schemas/identifiers";',
    },
    { module: "zod", source: 'import { z } from "zod";' },
  ]
    .sort((left, right) => left.module.localeCompare(right.module))
    .map(({ source }) => source)
    .join("\n");
  const detailInputVariants = detailEntities
    .map(
      ({ key }) =>
        `z.object({entity:z.literal(${JSON.stringify(key)}),shortcode:shortcodeSchema(${JSON.stringify(key)})})`,
    )
    .join(",\n  ");

  const browserCrudEntitySpecs = projections.list;
  const browserCrudEntities = browserCrudEntitySpecs.map(({ key }) => key);
  const listRuntimeOutputImports = browserCrudEntitySpecs
    .map(
      ({ key, contract }) =>
        `import { ${contract.list.export} as ${key}ListOutputSchema } from ${JSON.stringify(contract.list.module)};`,
    )
    .join("\n");
  const listFilterFieldImports = browserCrudEntitySpecs
    .flatMap(({ key, filterSchema }) =>
      filterSchema === null
        ? []
        : [
            `import { ${filterSchema.export} as ${key}ListFilterFields } from ${JSON.stringify(filterSchema.module)};`,
          ],
    )
    .join("\n");
  const listInputVariants = browserCrudEntitySpecs
    .map(
      ({ key, filterSchema }) =>
        `z.object({entity:z.literal(${JSON.stringify(key)}),filters:${filterSchema === null ? "z.record(z.string(),z.unknown())" : `${key}ListFiltersSchema`},sort:entityListSortsSchema.optional(),pagination:entityListPaginationSchema.optional(),groupBy:z.string().min(1).optional()})`,
    )
    .join(",\n  ");
  const listFilterSchemas = browserCrudEntitySpecs
    .map(({ key, filterSchema }) =>
      filterSchema === null
        ? `const ${key}ListFiltersSchema = z.record(z.string(), z.unknown());`
        : `const ${key}ListFiltersSchema = z.object(${key}ListFilterFields);`,
    )
    .join("\n");
  const listFilterSchemaBindings = browserCrudEntitySpecs
    .map(({ key }) => `  ${JSON.stringify(key)}: ${key}ListFiltersSchema,`)
    .join("\n");
  const listOutputSchemas = browserCrudEntitySpecs
    .map(
      ({ key }) =>
        `  ${JSON.stringify(key)}: z.object({items:z.array(${key}ListOutputSchema),meta:entityListMetaSchema}),`,
    )
    .join("\n");
  const mutationOutputImportEntries = new Map<string, Set<string>>();
  for (const { contract } of browserCrudEntitySpecs) {
    if (!contract)
      throw new EntityDeclarationError(
        "Browser CRUD entity is missing its contract.",
      );
    const exports =
      mutationOutputImportEntries.get(contract.output.module) ??
      new Set<string>();
    exports.add(contract.output.export);
    mutationOutputImportEntries.set(contract.output.module, exports);
  }
  const mutationOutputImports = [...mutationOutputImportEntries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([module, exports]) =>
        `import { ${[...exports].sort().join(", ")} } from ${JSON.stringify(module)};`,
    )
    .join("\n");
  const mutationOutputTypes = browserCrudEntitySpecs
    .map(({ key, contract }) => {
      if (!contract)
        throw new EntityDeclarationError(
          "Browser CRUD entity is missing its contract.",
        );
      return `  ${JSON.stringify(key)}: z.output<typeof ${contract.output.export}>;`;
    })
    .join("\n");
  const mutationOutputSchemas = browserCrudEntitySpecs
    .map(({ key, contract }) => {
      if (!contract)
        throw new EntityDeclarationError(
          "Browser CRUD entity is missing its contract.",
        );
      return `  ${JSON.stringify(key)}: ${contract.output.export},`;
    })
    .join("\n");
  const commandVariants = (
    action: "create" | "update",
    schema: "create" | "update",
    audience: "mcp" | null = null,
  ) =>
    entities
      .filter(
        (entity) =>
          entity.contract !== null &&
          entity.contract[schema] !== null &&
          (audience === null ||
            (Array.isArray(entity.descriptor.mcp) &&
              entity.descriptor.mcp.includes(action))),
      )
      .map((entity) => {
        const schemaRef = entity.contract?.[schema];
        if (!schemaRef)
          throw new EntityDeclarationError(
            `${entity.key}.${schema} is missing.`,
          );
        const id =
          action === "update"
            ? ",id:shortcodeSchema(" + JSON.stringify(entity.key) + ")"
            : "";
        return `z.object({action:z.literal(${JSON.stringify(action)}),entity:z.literal(${JSON.stringify(entity.key)})${id},data:${schemaRef.export}})`;
      })
      .join(",\n  ");
  const mutationResultVariants = (action: "create" | "update") =>
    entities
      .filter(
        (entity) =>
          entity.contract !== null && entity.contract[action] !== null,
      )
      .map((entity) => {
        const output = entity.contract?.output;
        if (!output)
          throw new EntityDeclarationError(`${entity.key}.output is missing.`);
        return `z.object({action:z.literal(${JSON.stringify(action)}),entity:z.literal(${JSON.stringify(entity.key)}),item:${output.export},sideEffects:mutationSideEffectsSchema})`;
      })
      .join(",\n  ");
  const mcpMutationResultVariants = (action: "create" | "update") =>
    entities
      .filter(
        (entity) =>
          entity.contract !== null &&
          entity.contract[action] !== null &&
          Array.isArray(entity.descriptor.mcp) &&
          entity.descriptor.mcp.includes(action),
      )
      .map((entity) => {
        const output = entity.contract?.mcpOutput;
        if (!output)
          throw new EntityDeclarationError(
            `${entity.key}.mcpOutput is missing.`,
          );
        return `z.object({action:z.literal(${JSON.stringify(action)}),entity:z.literal(${JSON.stringify(entity.key)}),item:${output.export},sideEffects:mutationSideEffectsSchema})`;
      })
      .join(",\n  ");
  const queryGetResultVariants = schemaEntitySpecs
    .map(
      ({ key, contract }) =>
        `z.object({action:z.literal("get"),entity:z.literal(${JSON.stringify(key)}),item:${contract.detail.export}.nullable()})`,
    )
    .join(",\n  ");
  const queryListResultVariants = schemaEntitySpecs
    .map(
      ({ key, contract }) =>
        `z.object({action:z.literal("list"),entity:z.literal(${JSON.stringify(key)}),items:z.array(${contract.list.export}),meta:generatedEntityListMetaSchema})`,
    )
    .join(",\n  ");
  const mcpQueryGetResultVariants = schemaEntitySpecs
    .filter(
      (entity) =>
        Array.isArray(entity.descriptor.mcp) &&
        entity.descriptor.mcp.includes("get"),
    )
    .map(
      ({ key, contract }) =>
        `z.object({action:z.literal("get"),entity:z.literal(${JSON.stringify(key)}),item:${contract.mcpDetail.export}.nullable()})`,
    )
    .join(",\n  ");
  const mcpQueryListResultVariants = schemaEntitySpecs
    .filter(
      (entity) =>
        Array.isArray(entity.descriptor.mcp) &&
        entity.descriptor.mcp.includes("list"),
    )
    .map(
      ({ key, contract }) =>
        `z.object({action:z.literal("list"),entity:z.literal(${JSON.stringify(key)}),items:z.array(${contract.mcpList.export}),meta:generatedEntityListMetaSchema})`,
    )
    .join(",\n  ");
  // A declared field list is compiled into `.pick({...}).strict()` on the
  // entity's own update schema: an undeclared field is REFUSED rather than
  // silently stripped, and a field the update schema does not have fails
  // `pnpm typecheck` on the generated file.
  const bulkUpdateEntities = entities.filter(
    (entity) =>
      entity.bulkUpdateFields !== null && entity.contract?.update !== null,
  );
  const bulkUpdateCommandVariantsFor = (
    entitySpecs: readonly CompiledEntity[],
  ) =>
    entitySpecs
      .map((entity) => {
        const schemaRef = entity.contract?.update;
        if (!schemaRef)
          throw new EntityDeclarationError(`${entity.key}.update is missing.`);
        const mask = (entity.bulkUpdateFields ?? [])
          .map((field) => `${JSON.stringify(field)}:true`)
          .join(",");
        return `z.object({action:z.literal("bulkUpdate"),entity:z.literal(${JSON.stringify(entity.key)}),ids,data:${schemaRef.export}.pick({${mask}}).strict()})`;
      })
      .join(",\n  ");
  // No declaration anywhere means the command exists but matches nothing,
  // rather than an empty `z.union([])` that fails far from its cause.
  const bulkUpdateCommandFactoryFor = (
    entitySpecs: readonly CompiledEntity[],
  ) =>
    entitySpecs.length === 0
      ? "(_ids: z.ZodType<string[]>) => z.never()"
      : `(ids: z.ZodType<string[]>) => z.union([\n  ${bulkUpdateCommandVariantsFor(entitySpecs)}\n])`;
  const bulkUpdateCommandFactory =
    bulkUpdateCommandFactoryFor(bulkUpdateEntities);
  const mcpBulkUpdateEntities = bulkUpdateEntities.filter(
    (entity) =>
      Array.isArray(entity.descriptor.mcp) &&
      entity.descriptor.mcp.includes("bulkUpdate"),
  );
  const mcpBulkUpdateCommandFactory = bulkUpdateCommandFactoryFor(
    mcpBulkUpdateEntities,
  );
  const kernelEntities = entities.filter(
    ({ contract, key, ports }) =>
      (contract !== null && ports.repository !== null) || key === "image",
  );
  const kernelEntityKeys = kernelEntities.map(({ key }) => key);
  const runtimeAdapterImports = new Map<string, Set<string>>();
  for (const entity of kernelEntities) {
    const adapter = entity.ports.repository;
    if (adapter === null) {
      throw new EntityDeclarationError(
        `${entity.key}.ports.repository is required for a kernel entity.`,
      );
    }
    const exports =
      runtimeAdapterImports.get(adapter.module) ?? new Set<string>();
    exports.add(adapter.export);
    runtimeAdapterImports.set(adapter.module, exports);
  }
  const runtimeAdapterImportSource = [...runtimeAdapterImports.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([module, exports]) =>
        `import { ${[...exports].sort().join(", ")} } from ${JSON.stringify(module)};`,
    )
    .join("\n");
  const runtimeBindings = kernelEntities
    .map(
      ({ key, ports }) =>
        `  ${JSON.stringify(key)}: ${ports.repository?.export},`,
    )
    .join("\n");
  const runtimeOperations = kernelEntities
    .map(
      ({ key, ports }) =>
        `  ${JSON.stringify(key)}: defineEntityOperations(${ports.repository?.export}),`,
    )
    .join("\n");
  const filterFieldImports = new Map<string, Set<string>>();
  for (const { filterSchema } of entities) {
    if (filterSchema === null) continue;
    const exports =
      filterFieldImports.get(filterSchema.module) ?? new Set<string>();
    exports.add(filterSchema.export);
    filterFieldImports.set(filterSchema.module, exports);
  }
  const filterFieldImportSource = [...filterFieldImports.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([module, exports]) =>
        `import { ${[...exports].sort().join(", ")} } from ${JSON.stringify(module)};`,
    )
    .join("\n");
  const filterFieldBindings = entities
    .flatMap(({ key, filterSchema }) =>
      filterSchema === null
        ? []
        : [`  ${JSON.stringify(key)}: ${filterSchema.export},`],
    )
    .join("\n");
  const httpResources = kernelEntities
    .flatMap((entity) => {
      if (!entity.route || !entity.contract) return [];
      const key = JSON.stringify(entity.key);
      const path = `/api/v1/${entity.route.basePath}`;
      const binding = `ENTITY_SCHEMA_BINDINGS[${key}]`;
      const metadata = (mode: string, operation = "entity.mutate") =>
        JSON.stringify({ entity: entity.key, operation, mode });
      const routes: string[] = [];
      const listIndex = browserCrudEntitySpecs.findIndex(
        (candidate) => candidate.key === entity.key,
      );
      if (listIndex >= 0)
        routes.push(
          `list: httpGet(${JSON.stringify(path)}, resourceListQuerySchema(entityListInputSchema.options[${listIndex}].shape.filters), getEntityListOutputSchema(${key}), ${metadata("list", "entity.list")})`,
        );
      if (detailEntities.some((candidate) => candidate.key === entity.key))
        routes.push(
          `get: httpItem(httpGet(${JSON.stringify(path + "/:id")}, z.strictObject({}), getEntityDetailOutputSchema(${key}), ${metadata("detail", "entity.detail")}), ${binding}.id)`,
        );
      if (entity.contract.create)
        routes.push(
          `create: httpCreate( ${JSON.stringify(path)}, ${binding}.createInput, generatedEntityMutationCreateResultSchema.options[${entities.filter((candidate) => candidate.contract?.create).findIndex((candidate) => candidate.key === entity.key)}], ${metadata("create")})`,
        );
      if (entity.contract.update)
        routes.push(
          `update: httpItem(httpWrite("PATCH", ${JSON.stringify(path + "/:id")}, ${binding}.updateInput, generatedEntityMutationUpdateResultSchema.options[${entities.filter((candidate) => candidate.contract?.update).findIndex((candidate) => candidate.key === entity.key)} ], ${metadata("update")}), ${binding}.id)`,
        );
      if (entity.operationOwners.delete === "kernel")
        routes.push(
          `delete: httpItem(httpDelete(${JSON.stringify(path + "/:id")}, entityDeleteResultSchema, ${metadata("delete")}), ${binding}.id)`,
        );
      return [`${key}: {${routes.join(",\n")}}`];
    })
    .join(",\n");
  const lifecycleFor = (entity: CompiledEntity) => entity.lifecycle;
  const kernelActionsFor = (entity: CompiledEntity) => {
    const lifecycle = lifecycleFor(entity);
    return [
      "get",
      "list",
      ...(entity.descriptor.searchable === true ? ["search"] : []),
      ...(entity.contract?.create ? ["create"] : []),
      ...(entity.contract?.update ? ["update"] : []),
      ...(entity.bulkUpdateFields === null ? [] : ["bulkUpdate"]),
      ...(lifecycle.delete === null ? [] : ["delete"]),
      ...(lifecycle.merge === true ? ["merge"] : []),
    ];
  };
  const kernelContractCases = Object.fromEntries(
    kernelEntities.map((entity) => {
      return [
        entity.key,
        {
          actions: kernelActionsFor(entity),
          filterUrlKeys: entity.filterUrlKeys,
        },
      ];
    }),
  );
  const entitiesForAction = (action: string) =>
    Object.entries(kernelContractCases)
      .filter(([, contractCase]) => contractCase.actions.includes(action))
      .map(([key]) => key);
  const mcpActionsFor = (entity: CompiledEntity): string[] => [
    ...entity.mcpActions,
  ];
  const mcpKernelContractCases = Object.fromEntries(
    kernelEntities.map((entity) => {
      const declared = mcpActionsFor(entity);
      const executable = kernelActionsFor(entity);
      const unsupported = declared.filter(
        (action) => !executable.includes(action),
      );
      if (unsupported.length > 0) {
        throw new EntityDeclarationError(
          `${entity.key}.capabilities.mcp declares unbound actions: ${unsupported.join(", ")}.`,
        );
      }
      return [entity.key, { actions: declared }];
    }),
  );
  const mcpEntitiesForAction = (action: string) =>
    Object.entries(mcpKernelContractCases)
      .filter(([, contractCase]) => contractCase.actions.includes(action))
      .map(([key]) => key);
  const mergeResultVariants = kernelEntities
    .filter((entity) => kernelActionsFor(entity).includes("merge"))
    .map((entity) => {
      if (entity.contract === null) {
        throw new EntityDeclarationError(
          `${entity.key}.merge output is missing.`,
        );
      }
      return `z.object({action:z.literal("merge"),entity:z.literal(${JSON.stringify(entity.key)}),item:${entity.contract.output.export},mergeSummary:z.json(),sideEffects:mutationSideEffectsSchema})`;
    })
    .join(",\n  ");
  const mcpMergeResultVariants = kernelEntities
    .filter((entity) => mcpActionsFor(entity).includes("merge"))
    .map((entity) => {
      if (entity.contract === null) {
        throw new EntityDeclarationError(
          `${entity.key}.merge output is missing.`,
        );
      }
      return `z.object({action:z.literal("merge"),entity:z.literal(${JSON.stringify(entity.key)}),item:${entity.contract.mcpOutput.export},mergeSummary:z.json(),sideEffects:mutationSideEffectsSchema})`;
    })
    .join(",\n  ");
  const shortcodePrefixes = Object.fromEntries(
    entities.flatMap(({ key, shortcode }) =>
      shortcode === null ? [] : [[key, shortcode]],
    ),
  );
  const legacyShortcodePrefixes = Object.fromEntries(
    entities.flatMap(({ key, legacyShortcode }) =>
      legacyShortcode === null ? [] : [[legacyShortcode, key]],
    ),
  );
  const inspectorMetadata = Object.fromEntries(
    entities.map((entity) => {
      const lifecycle = lifecycleFor(entity);
      const kernelActions = kernelEntityKeys.includes(entity.key)
        ? kernelActionsFor(entity)
        : [];
      const mcpOperations = Array.isArray(entity.descriptor.mcp)
        ? entity.descriptor.mcp
        : [];
      const mcpOwner =
        mcpOperations.length === 0
          ? null
          : kernelEntityKeys.includes(entity.key)
            ? "kernel"
            : "workflow";
      const sourceRefs =
        entity.contract === null
          ? null
          : Object.fromEntries(
              Object.entries(entity.contract).flatMap(([operation, ref]) =>
                ref === null
                  ? []
                  : [[operation, `${ref.module}#${ref.export}`]],
              ),
            );
      return [
        entity.key,
        {
          singular: entity.inspector.singular,
          plural: entity.inspector.plural,
          titleField: entity.inspector.titleField,
          shortcodePrefix: entity.shortcode,
          legacyShortcodePrefix: entity.legacyShortcode,
          searchable: entity.descriptor.searchable === true,
          browserRouted: entity.descriptor.browserRoutes !== false,
          auditable: entity.descriptor.auditable === true,
          hasImages: entity.descriptor.hasImages === true,
          countable: entity.descriptor.countable === true,
          kernelActions,
          filterUrlKeys: entity.filterUrlKeys,
          filterDescriptors: entity.filterDescriptors,
          mcpOperations,
          mcpOwner,
          lifecycle: {
            softDelete: entity.descriptor.softDelete === true,
            delete: lifecycle.delete,
            merge: lifecycle.merge === true,
            bulkUpdate:
              entity.bulkUpdateFields === null
                ? null
                : { fields: entity.bulkUpdateFields },
          },
          operationOwners: {
            delete: entity.operationOwners.delete,
            merge: entity.operationOwners.merge,
          },
          sourceRefs,
          ports: entity.ports,
          references: [
            ...new Set(entity.relations.map(({ target }) => target)),
          ],
        },
      ];
    }),
  );
  const fieldModels = Object.fromEntries(
    entities.map(({ key, fieldModel }) => [
      key,
      {
        ...fieldModel,
        fields: fieldModel.fields.map(
          ({ validation: _validation, ...field }) => field,
        ),
      },
    ]),
  );
  const fieldByKey = (entity: CompiledEntity, key: string) => {
    const field = entity.fieldModel.fields.find(
      (candidate) => candidate.key === key,
    );
    if (field === undefined)
      throw new EntityDeclarationError(
        `${entity.key}.model is missing field ${key}.`,
      );
    return field;
  };
  const validationComplete = (
    entity: CompiledEntity,
    mode: "create" | "update" | "read",
    keys: readonly string[],
  ) => keys.every((key) => fieldByKey(entity, key).validation[mode] !== null);
  const fieldSchemaArtifacts = entities.flatMap((entity) => {
    const { fieldModel } = entity;
    if (
      fieldModel.create.length +
        fieldModel.update.length +
        fieldModel.output.length ===
      0
    )
      return [];
    for (const [mode, keys] of [
      ["create", fieldModel.create],
      ["update", fieldModel.update],
      ["read", fieldModel.output],
    ] as const)
      if (!validationComplete(entity, mode, keys))
        throw new EntityDeclarationError(
          `${entity.key}.${mode} roster has missing schemas.`,
        );
    const declaration = declarationModules.get(entity.key);
    if (!declaration)
      throw new EntityDeclarationError(
        `${entity.key} has no declaration module.`,
      );
    const schemaMap = (
      mode: "create" | "update" | "read",
      keys: readonly string[],
    ) =>
      `{${keys
        .map((key) => {
          const index = fieldModel.fields.findIndex(
            (field) => field.key === key,
          );
          const field = fieldByKey(entity, key);
          return `${JSON.stringify(mode === "read" ? (field.readKey ?? key) : key)}:definition.model.fields[${index}].validation.${mode}`;
        })
        .join(",")}}`;
    const prefix = `generated${entity.inspector.singular.replaceAll(" ", "")}`;
    return [
      {
        relativePath: `packages/schemas/src/generated/entity-field-schemas.${entity.key}.gen.ts`,
        source:
          generatedHeader +
          `import definition${declaration.hasFilters ? ", {filterSchemas}" : ""} from ${JSON.stringify(declaration.path)};\n` +
          (declaration.enumExports.length
            ? `export {${declaration.enumExports.join(",")}} from ${JSON.stringify(declaration.path)};\n`
            : "") +
          `export const ${prefix}FieldSchemas = {create:${schemaMap("create", fieldModel.create)},update:${schemaMap("update", fieldModel.update)},read:${schemaMap("read", fieldModel.output)}} as const;\n` +
          (declaration.hasFilters
            ? `export const ${prefix}FilterFields = filterSchemas;\n`
            : ""),
      },
    ];
  });
  const portExportChecks = [
    ...new Map(
      entities.flatMap((entity) => {
        const { ports } = entity;
        const refs = [
          ports.repository,
          ports.references.label,
          ports.references.resolver,
          ports.filters,
          ports.search.projection,
          ports.search.semanticText,
          ports.search.dependentRefresh,
          ...entity.relationMutations.flatMap(({ itemSchema, adapter }) => [
            itemSchema,
            adapter,
          ]),
          ...entity.filterDescriptors.flatMap((descriptor) => [
            descriptor.optionsRef,
            descriptor.expandRef,
          ]),
        ].filter((ref): ref is SourceRef => ref !== null);
        return refs.map((ref) => [`${ref.module}#${ref.export}`, ref] as const);
      }),
    ).values(),
  ].sort((left, right) =>
    `${left.module}#${left.export}`.localeCompare(
      `${right.module}#${right.export}`,
    ),
  );
  const portTypeModuleAliases = new Map(
    [...new Set(portExportChecks.map((ref) => ref.module))]
      .sort((left, right) => left.localeCompare(right))
      .map((module, index) => [module, `entityPortModule${index}`]),
  );
  const portTypeImports = [...portTypeModuleAliases.entries()]
    .map(
      ([module, alias]) =>
        `import type * as ${alias} from ${JSON.stringify(module)};`,
    )
    .join("\n");
  // Every table with a public shortcode, keyed the same way as SHORTCODE_PREFIX.
  // The Drizzle export name is always lowerCamelCase(dbTable) from the single
  // `~/server/db/schema` module — verified for all current shortcode entities.
  const shortcodeTableEntities = entities
    .flatMap((entity) => {
      const { dbTable } = entity.descriptor;
      return entity.shortcode === null ||
        dbTable === null ||
        dbTable === undefined
        ? []
        : [
            {
              key: entity.key,
              dbTable: stringValue(dbTable, `${entity.key}.descriptor.dbTable`),
            },
          ];
    })
    .sort((left, right) => left.key.localeCompare(right.key));
  const shortcodeTableImportNames = [
    ...new Set(
      shortcodeTableEntities.map(({ dbTable }) => lowerCamelCase(dbTable)),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const shortcodeTableBindings = shortcodeTableEntities
    .map(
      ({ key, dbTable }) =>
        `  ${JSON.stringify(key)}: ${lowerCamelCase(dbTable)},`,
    )
    .join("\n");
  return [
    {
      relativePath: "packages/shared/src/generated/shortcode-registry.gen.ts",
      source:
        generatedHeader +
        "// Generated shortcode registry stays one entity per line.\n// oxfmt-ignore\n" +
        `export const SHORTCODE_PREFIX = ${compactLiteral(shortcodePrefixes)} as const;\n` +
        "export type ShortcodeType = keyof typeof SHORTCODE_PREFIX;\n\n" +
        "/** Inbound-only aliases; canonical generation never emits these prefixes. */\n" +
        "// Generated legacy aliases stay compact.\n// oxfmt-ignore\n" +
        `export const LEGACY_SHORTCODE_PREFIX = ${compactLiteral(legacyShortcodePrefixes)} as const satisfies Record<string, ShortcodeType>;\n`,
    },
    {
      relativePath:
        "packages/schemas/src/generated/entity-manifest-data.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "../entity";\n' +
        'import type { EntityDescriptor } from "../entity-manifest";\n\n' +
        "// Generated data stays one entity per line.\n// oxfmt-ignore\n" +
        `export const generatedEntityManifest = ${compactLiteral(
          Object.fromEntries(
            entities.map(({ key, descriptor }) => [key, descriptor]),
          ),
        )} as const satisfies Record<Entity, EntityDescriptor>;\n`,
    },
    {
      relativePath: "packages/schemas/src/generated/entity-names.gen.ts",
      source:
        generatedHeader +
        // `entity-core` rather than `entity`: this artifact is imported by
        // `identifiers.ts`, and `entity.ts` reaches back into the (much
        // larger) manifest module.
        'import type { Entity } from "../entity-core";\n\n' +
        "/**\n" +
        " * Display names for one entity, exactly as its literal declares them.\n" +
        " *\n" +
        " * `singular` is Title Case and names ONE record; `plural` is the\n" +
        " * nav/section name, which is not a pluralization of the singular (see the\n" +
        " * `names` block in `packages/schemas/src/entity-definitions/*.entity.ts`). It is\n" +
        " * `null` for the entities that have no browser route to name a section of.\n" +
        " *\n" +
        " * Deliberately its own artifact rather than a field read off\n" +
        " * `entityInspectorMetadata`: these strings are needed by eagerly-loaded\n" +
        " * client code (the entity registry, `identifiers.ts`), and the inspector\n" +
        " * artifact is two orders of magnitude larger.\n" +
        " */\n" +
        "export type EntityNames = { singular: string; plural: string | null };\n\n" +
        "// Generated names stay one entity per line.\n// oxfmt-ignore\n" +
        `export const entityNames = ${compactLiteral(
          Object.fromEntries(
            entities.map(({ key, inspector }) => [
              key,
              { singular: inspector.singular, plural: inspector.plural },
            ]),
          ),
        )} as const satisfies Record<Entity, EntityNames>;\n`,
    },
    {
      relativePath: "packages/schemas/src/generated/entity-field-model.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "../entity-core";\n\n' +
        `export type GeneratedEntityFieldKind = ${fieldKinds.map((kind) => JSON.stringify(kind)).join(" | ")};\n` +
        `export type GeneratedEntityFieldControlKind = ${fieldControlKinds.map((kind) => JSON.stringify(kind)).join(" | ")};\n\n` +
        "export type GeneratedEntityFieldModel = {\n" +
        '  fields: readonly { key: string; kind: GeneratedEntityFieldKind; nullable: boolean; label: string; description: string | null; readKey: string | null; reference: { entity: string; multiple: boolean } | null; control: { kind: GeneratedEntityFieldControlKind; renderer: string | null; options: readonly { value: string; label: string }[] | null; section: string } | null; display: { list: boolean; detail: boolean; columnId: string | null; standard: "name" | "image" | null; detailOrder: number | null; detailSection: string } }[];\n' +
        '  storage: readonly { key: string; column: string; kind: GeneratedEntityFieldKind; nullable: boolean; default: "none" | "generated" | "now" | "literal"; defaultValue: unknown; reference: string | null; specialized: string | null }[];\n' +
        "  create: readonly string[];\n" +
        "  update: readonly string[];\n" +
        "  bulk: readonly string[];\n" +
        "  audit: readonly string[];\n" +
        "  output: readonly string[];\n" +
        "};\n\n" +
        "// One authoritative field model per compiled entity.\n// oxfmt-ignore\n" +
        `export const generatedEntityFieldModels = ${compactLiteral(fieldModels)} as const satisfies Record<Entity, GeneratedEntityFieldModel>;\n`,
    },
    {
      relativePath: "apps/web/src/server/db/generated/entity-columns.gen.ts",
      source: renderEntityColumnsArtifact(entities),
    },
    ...fieldSchemaArtifacts,
    {
      relativePath: "packages/schemas/src/generated/entity-inspector.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "../entity";\n\n' +
        "export type EntityInspectorMetadata = {\n" +
        "  singular: string;\n" +
        "  plural: string | null;\n" +
        "  titleField: string;\n" +
        "  shortcodePrefix: string | null;\n" +
        "  legacyShortcodePrefix: string | null;\n" +
        "  searchable: boolean;\n" +
        "  browserRouted: boolean;\n" +
        "  auditable: boolean;\n" +
        "  hasImages: boolean;\n" +
        "  countable: boolean;\n" +
        '  kernelActions: readonly ("get" | "list" | "search" | "create" | "update" | "bulkUpdate" | "delete" | "merge")[];\n' +
        "  filterUrlKeys: readonly string[];\n" +
        "  filterDescriptors: readonly EntityFilterDescriptorMetadata[];\n" +
        '  mcpOperations: readonly ("get" | "list" | "search" | "create" | "update" | "delete" | "bulkUpdate" | "merge")[];\n' +
        '  mcpOwner: "kernel" | "workflow" | null;\n' +
        '  lifecycle: { softDelete: boolean; delete: { mode: "soft" | "hard"; bulk: boolean } | null; merge: boolean; bulkUpdate: { fields: readonly string[] } | null };\n' +
        '  operationOwners: { delete: "kernel" | "workflow" | null; merge: "kernel" | "workflow" | null };\n' +
        "  sourceRefs: { create?: string; update?: string; output: string; list: string; detail: string; mcpOutput: string; mcpList: string; mcpDetail: string } | null;\n" +
        "  ports: EntityPortSourceRoster;\n" +
        "  references: readonly Entity[];\n" +
        "};\n\n" +
        "type EntityPortSourceRef = { module: string; export: string };\n" +
        "type EntityInspectorOptionValue = string | number | boolean | null;\n" +
        "type EntityInspectorOption = Readonly<Record<string, EntityInspectorOptionValue>>;\n" +
        "type EntityFilterDescriptorMetadata = {\n" +
        "  columnId: string; field: string | null; urlKey: string; kind: string; placeholder: string;\n" +
        "  options: readonly EntityInspectorOption[] | null; optionsRef: EntityPortSourceRef | null; optionsKey: string | null;\n" +
        '  label: string | null; schemaDescription: string | null; deriveSchema: boolean; schemaFromRead: boolean; brandRef: { entity: string; kind: "id" | "shortcode" } | null; expandRef: EntityPortSourceRef | null;\n' +
        "  urlOnly: boolean; nullable: { field: string; label: string } | null;\n" +
        "};\n" +
        "type EntityPortSourceRoster = {\n" +
        "  repository: EntityPortSourceRef | null;\n" +
        "  references: { label: EntityPortSourceRef | null; resolver: EntityPortSourceRef | null };\n" +
        "  filters: EntityPortSourceRef | null;\n" +
        "  search: { projection: EntityPortSourceRef | null; semanticText: EntityPortSourceRef | null; dependentRefresh: EntityPortSourceRef | null };\n" +
        "};\n\n" +
        "// Generated inspector metadata stays one entity per line.\n// oxfmt-ignore\n" +
        `export const entityInspectorMetadata = ${compactLiteral(inspectorMetadata)} as const satisfies Record<Entity, EntityInspectorMetadata>;\n`,
    },
    {
      relativePath: "apps/web/src/entities/generated/entity-details.gen.ts",
      source:
        generatedHeader +
        `${detailRuntimeImportSource}\n\n` +
        `export const detailEntities = ${compactLiteral(detailEntities.map(({ key }) => key))} as const;\n` +
        "export type DetailEntity = (typeof detailEntities)[number];\n\n" +
        "// One generated detail schema per entity.\n// oxfmt-ignore\n" +
        `const ENTITY_DETAIL_OUTPUT_SCHEMAS = {\n${detailSchemas}\n} as const;\n\n` +
        "// One generated detail input variant per entity.\n// oxfmt-ignore\n" +
        `export const entityDetailInputSchema = z.discriminatedUnion("entity", [\n  ${detailInputVariants}\n]);\n\n` +
        "type EntityDetailInput = z.input<typeof entityDetailInputSchema>;\n" +
        "type ParsedEntityDetailInput = z.output<typeof entityDetailInputSchema>;\n" +
        "export type EntityDetailByEntity = { [E in DetailEntity]: z.output<(typeof ENTITY_DETAIL_OUTPUT_SCHEMAS)[E]> };\n" +
        "export type EntityDetailInputByEntity = { [E in DetailEntity]: Extract<EntityDetailInput, { entity: E }> };\n" +
        "export type ParsedEntityDetailInputByEntity = { [E in DetailEntity]: Extract<ParsedEntityDetailInput, { entity: E }> };\n\n" +
        'export function entityDetailInputFor<E extends DetailEntity>(entity: E, shortcode: EntityDetailInputByEntity[E]["shortcode"]): EntityDetailInputByEntity[E];\n' +
        'export function entityDetailInputFor(entity: DetailEntity, shortcode: EntityDetailInputByEntity[DetailEntity]["shortcode"]) {\n' +
        "  return { entity, shortcode };\n" +
        "}\n\n" +
        "export function parseEntityDetailInput<E extends DetailEntity>(entity: E, value: EntityDetailInputByEntity[E]): ParsedEntityDetailInputByEntity[E];\n" +
        "export function parseEntityDetailInput(entity: DetailEntity, value: EntityDetailInputByEntity[DetailEntity]) {\n" +
        "  const parsed = entityDetailInputSchema.parse(value);\n" +
        '  if (parsed.entity !== entity) throw new Error("Entity detail input discriminator mismatch");\n' +
        "  return parsed;\n" +
        "}\n\n" +
        "export function getEntityDetailOutputSchema<E extends DetailEntity>(entity: E): z.ZodType<EntityDetailByEntity[E]>;\n" +
        "export function getEntityDetailOutputSchema(entity: DetailEntity): z.ZodType {\n" +
        "  return ENTITY_DETAIL_OUTPUT_SCHEMAS[entity];\n" +
        "}\n",
    },
    {
      relativePath: "apps/web/src/entities/generated/entity-lists.gen.ts",
      source:
        generatedHeader +
        "// Generated schema aliases retain deterministic import order.\n" +
        `${listRuntimeOutputImports}\n${listFilterFieldImports}\n` +
        'import { MAX_PAGE_SIZE, MAX_SORTS } from "@cubby/schemas/pagination";\n' +
        'import type { FilterPatch } from "../filters";\n' +
        'import { z } from "zod";\n\n' +
        `export const listEntities = ${compactLiteral(browserCrudEntities)} as const;\n` +
        "export type ListEntity = (typeof listEntities)[number];\n\n" +
        'const entityListSortSchema = z.object({ orderBy: z.string().min(1), direction: z.enum(["asc", "desc"]) });\n' +
        "const entityListSortsSchema = z.union([entityListSortSchema, z.array(entityListSortSchema).min(1).max(MAX_SORTS)]);\n" +
        "const entityListPaginationSchema = z.object({ pageIndex: z.number().int().min(0), pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE) });\n" +
        "const entityListMetaSchema = z.object({ pageIndex: z.number().int().min(0), pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE), totalCount: z.number().int().min(0), sums: z.record(z.string(), z.number()).optional() });\n\n" +
        `${listFilterSchemas}\n\n` +
        "// One generated filter schema per list entity.\n// oxfmt-ignore\n" +
        `const ENTITY_LIST_FILTER_SCHEMAS = {\n${listFilterSchemaBindings}\n} as const;\n\n` +
        `export const entityListInputSchema = z.discriminatedUnion("entity", [\n  ${listInputVariants}\n]);\n\n` +
        "const ENTITY_LIST_OUTPUT_SCHEMAS = {\n" +
        `${listOutputSchemas}\n` +
        "} as const;\n\n" +
        "type EntityListInputFiltersByEntity = { [E in ListEntity]: z.input<(typeof ENTITY_LIST_FILTER_SCHEMAS)[E]> };\n" +
        "type EntityListParsedFiltersByEntity = { [E in ListEntity]: z.output<(typeof ENTITY_LIST_FILTER_SCHEMAS)[E]> };\n" +
        "type EntityListSort = z.input<typeof entityListSortSchema>;\n" +
        "export type EntityListInputByEntity = {\n" +
        "  [E in ListEntity]: { entity: E; filters: EntityListInputFiltersByEntity[E]; sort?: EntityListSort | EntityListSort[]; pagination?: { pageIndex: number; pageSize: number }; groupBy?: string };\n" +
        "};\n" +
        "export type ParsedEntityListInputByEntity = {\n" +
        '  [E in ListEntity]: Omit<EntityListInputByEntity[E], "filters"> & { filters: EntityListParsedFiltersByEntity[E] };\n' +
        "};\n\n" +
        'export type EntityListParamsByEntity = { [E in ListEntity]: Omit<EntityListInputByEntity[E], "entity"> };\n' +
        "export function entityListInputFor<E extends ListEntity>(entity: E, input: EntityListParamsByEntity[E]): EntityListInputByEntity[E];\n" +
        "export function entityListInputFor(entity: ListEntity, input: EntityListParamsByEntity[ListEntity]) {\n" +
        "  return { entity, ...input };\n" +
        "}\n\n" +
        "export function entityListParamsFromParsed<E extends ListEntity>(entity: E, input: ParsedEntityListInputByEntity[E]): EntityListParamsByEntity[E];\n" +
        "export function entityListParamsFromParsed(entity: ListEntity, input: ParsedEntityListInputByEntity[ListEntity]) {\n" +
        '  if (input.entity !== entity) throw new Error("Entity list input discriminator mismatch");\n' +
        "  const { entity: _entity, ...params } = input;\n" +
        "  return params;\n" +
        "}\n\n" +
        "export type EntityListParseInput = EntityListInputByEntity[ListEntity] | { entity: ListEntity; filters: FilterPatch; sort?: EntityListSort | EntityListSort[]; pagination?: { pageIndex: number; pageSize: number }; groupBy?: string };\n\n" +
        "export type EntityListResultByEntity = {\n" +
        "  [E in ListEntity]: z.output<(typeof ENTITY_LIST_OUTPUT_SCHEMAS)[E]>;\n" +
        "};\n\n" +
        "export function parseEntityListInput<E extends ListEntity>(entity: E, value: EntityListInputByEntity[E] | EntityListParseInput): ParsedEntityListInputByEntity[E];\n" +
        "export function parseEntityListInput(entity: ListEntity, value: EntityListParseInput) {\n" +
        "  const parsed = entityListInputSchema.parse(value);\n" +
        '  if (parsed.entity !== entity) throw new Error("Entity list input discriminator mismatch");\n' +
        "  return parsed;\n" +
        "}\n\n" +
        "export function getEntityListOutputSchema<E extends ListEntity>(entity: E): z.ZodType<EntityListResultByEntity[E]>;\n" +
        "export function getEntityListOutputSchema(entity: ListEntity): z.ZodType {\n" +
        "  return ENTITY_LIST_OUTPUT_SCHEMAS[entity];\n" +
        "}\n",
    },
    {
      relativePath:
        "apps/web/src/entities/generated/entity-mutation-results.gen.ts",
      source:
        generatedHeader +
        `${mutationOutputImports}\n` +
        'import type { z } from "zod";\n\n' +
        `export const entityMutationOutputEntities = ${compactLiteral(browserCrudEntities)} as const;\n` +
        "export type EntityMutationOutputEntity = (typeof entityMutationOutputEntities)[number];\n\n" +
        "export type EntityMutationOutputByEntity = {\n" +
        `${mutationOutputTypes}\n` +
        "};\n\n" +
        "// One generated mutation output schema per entity.\n// oxfmt-ignore\n" +
        `const ENTITY_MUTATION_OUTPUT_SCHEMAS = {\n${mutationOutputSchemas}\n} as const;\n\n` +
        'type UnparsedMutationOutput = Parameters<z.ZodType["parse"]>[0];\n' +
        "type EntityMutationOutput = EntityMutationOutputByEntity[EntityMutationOutputEntity];\n\n" +
        "export function parseEntityMutationOutput<E extends EntityMutationOutputEntity>(entity: E, value: UnparsedMutationOutput): EntityMutationOutputByEntity[E];\n" +
        "export function parseEntityMutationOutput(entity: EntityMutationOutputEntity, value: UnparsedMutationOutput): EntityMutationOutput {\n" +
        "  return ENTITY_MUTATION_OUTPUT_SCHEMAS[entity].parse(value);\n" +
        "}\n",
    },
    {
      relativePath:
        "apps/web/src/entities/generated/entity-filter-fields.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "@cubby/schemas/entity";\n' +
        'import type { z } from "zod";\n' +
        `${filterFieldImportSource}\n\n` +
        "// Generated filter field assembly stays one entity per line.\n// oxfmt-ignore\n" +
        `export const entityFilterFieldMaps = {\n${filterFieldBindings}\n} satisfies Partial<Record<Entity, Record<string, z.ZodType>>>;\n`,
    },
    {
      relativePath: "apps/web/src/lib/generated/http-resources.gen.ts",
      source:
        generatedHeader +
        'import { z } from "zod";\n' +
        'import { ENTITY_SCHEMA_BINDINGS, generatedEntityMutationCreateResultSchema, generatedEntityMutationUpdateResultSchema } from "~/server/generated/entity-bindings.gen";\n' +
        'import { resourceListQuerySchema } from "~/lib/http-api/resource-query";\n' +
        'import { entityDeleteResultSchema } from "~/server/entity-kernel/contracts";\n' +
        'import { entityListInputSchema, getEntityListOutputSchema } from "~/entities/generated/entity-lists.gen";\n' +
        'import { getEntityDetailOutputSchema } from "~/entities/generated/entity-details.gen";\n' +
        'import { httpGet, httpWrite, httpItem, httpDelete, httpCreate } from "~/lib/http-api/contract";\n' +
        `export const httpResources = {${httpResources}} as const;\n`,
    },
    {
      relativePath: "apps/web/src/server/generated/entity-bindings.gen.ts",
      source:
        generatedHeader +
        'import { mutationSideEffectsSchema } from "@cubby/schemas/background-jobs";\n' +
        'import { MAX_PAGE_SIZE } from "@cubby/schemas/pagination";\n' +
        'import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";\n' +
        `${schemaImports}\n` +
        'import { z } from "zod";\n\n' +
        "const entitySchema = <\n" +
        "  const E extends ShortcodeEntity,\n" +
        "  SFilters extends z.ZodType,\n" +
        "  SCreate extends z.ZodType | null,\n" +
        "  SUpdate extends z.ZodType | null,\n" +
        "  SBulkUpdate extends z.ZodType | null,\n" +
        "  SOutput extends z.ZodType,\n" +
        "  SDetail extends z.ZodType,\n" +
        "  SList extends z.ZodType,\n" +
        "  SMcpOutput extends z.ZodType,\n" +
        "  SMcpDetail extends z.ZodType,\n" +
        "  SMcpList extends z.ZodType,\n" +
        ">(\n" +
        "  entity: E,\n" +
        "  schemas: {\n" +
        "    filters: SFilters;\n" +
        "    createInput: SCreate;\n" +
        "    updateInput: SUpdate;\n" +
        "    bulkUpdateInput: SBulkUpdate;\n" +
        "    output: SOutput;\n" +
        "    detail: SDetail;\n" +
        "    list: SList;\n" +
        "    mcpOutput: SMcpOutput;\n" +
        "    mcpDetail: SMcpDetail;\n" +
        "    mcpList: SMcpList;\n" +
        "  },\n" +
        ") => ({ entity, id: shortcodeSchema(entity), ...schemas });\n\n" +
        "// Generated schema correlations stay one entity per line.\n// oxfmt-ignore\n" +
        `export const ENTITY_SCHEMA_BINDINGS = {\n${schemaBindings}\n} as const;\n` +
        "export type EntitySchemaBindingMap = typeof ENTITY_SCHEMA_BINDINGS;\n" +
        "export type EntitySchemaBindingEntity = keyof EntitySchemaBindingMap;\n" +
        "type EntitySchemaBinding = EntitySchemaBindingMap[EntitySchemaBindingEntity];\n" +
        "type EntityBinding = { crud: EntitySchemaBinding | null };\n\n" +
        "// Generated bindings stay one entity per line.\n// oxfmt-ignore\n" +
        `export const ENTITY_BINDINGS = {\n${bindings}\n} satisfies Record<ShortcodeEntity, EntityBinding>;\n\n` +
        "// One generated variant per entity.\n// oxfmt-ignore\n" +
        `export const generatedEntityCreateCommandSchema = z.union([\n  ${commandVariants("create", "create")}\n]);\n\n` +
        "// One generated variant per entity.\n// oxfmt-ignore\n" +
        `export const generatedEntityUpdateCommandSchema = z.union([\n  ${commandVariants("update", "update")}\n]);\n\n` +
        "// MCP command variants are filtered by each literal's declared exposure.\n" +
        "// oxfmt-ignore\n" +
        `export const generatedMcpEntityCreateCommandSchema = z.union([\n  ${commandVariants("create", "create", "mcp")}\n]);\n\n` +
        "// oxfmt-ignore\n" +
        `export const generatedMcpEntityUpdateCommandSchema = z.union([\n  ${commandVariants("update", "update", "mcp")}\n]);\n\n` +
        "/** The kernel owns the shared 1-500 unique-id bound, so it injects `ids`. */\n" +
        "// One generated variant per bulk-updatable entity.\n// oxfmt-ignore\n" +
        `export const generatedEntityBulkUpdateCommandSchema = ${bulkUpdateCommandFactory};\n` +
        `export const generatedMcpEntityBulkUpdateCommandSchema = ${mcpBulkUpdateCommandFactory};\n` +
        "\n" +
        `export const generatedEntityMutationCreateResultSchema = z.discriminatedUnion("entity", [\n  ${mutationResultVariants("create")}\n]);\n\n` +
        `export const generatedEntityMutationUpdateResultSchema = z.discriminatedUnion("entity", [\n  ${mutationResultVariants("update")}\n]);\n` +
        "\nconst generatedEntityListMetaSchema = z.object({\n" +
        "  pageIndex: z.number().int().nonnegative(),\n" +
        "  pageSize: z.number().int().positive().max(MAX_PAGE_SIZE),\n" +
        "  totalCount: z.number().int().nonnegative(),\n" +
        "  sums: z.record(z.string(), z.number()).optional(),\n" +
        "});\n\n" +
        "// One generated query result per correlated entity output.\n// oxfmt-ignore\n" +
        `export const generatedEntityGetResultSchema = z.discriminatedUnion("entity", [\n  ${queryGetResultVariants}\n]);\n\n` +
        "// One generated query result per correlated entity output.\n// oxfmt-ignore\n" +
        `export const generatedEntityListResultSchema = z.discriminatedUnion("entity", [\n  ${queryListResultVariants}\n]);\n` +
        "\n// Merge summaries are workflow-specific JSON; the surviving item remains entity-correlated.\n// oxfmt-ignore\n" +
        `export const generatedEntityMergeResultSchema = z.discriminatedUnion("entity", [\n  ${mergeResultVariants}\n]);\n` +
        "\n// MCP variants preserve entity correlation while projecting storage-only child ids.\n// oxfmt-ignore\n" +
        `export const generatedMcpEntityGetResultSchema = z.discriminatedUnion("entity", [\n  ${mcpQueryGetResultVariants}\n]);\n\n` +
        "// oxfmt-ignore\n" +
        `export const generatedMcpEntityListResultSchema = z.discriminatedUnion("entity", [\n  ${mcpQueryListResultVariants}\n]);\n\n` +
        "// oxfmt-ignore\n" +
        `export const generatedMcpEntityMutationCreateResultSchema = z.discriminatedUnion("entity", [\n  ${mcpMutationResultVariants("create")}\n]);\n\n` +
        "// oxfmt-ignore\n" +
        `export const generatedMcpEntityMutationUpdateResultSchema = z.discriminatedUnion("entity", [\n  ${mcpMutationResultVariants("update")}\n]);\n\n` +
        "// oxfmt-ignore\n" +
        `export const generatedMcpEntityMergeResultSchema = z.discriminatedUnion("entity", [\n  ${mcpMergeResultVariants}\n]);\n`,
    },
    {
      relativePath: "apps/web/src/entities/generated/entity-routes.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "@cubby/schemas/entity";\n\n' +
        "// Generated routes stay one entity per line.\n// oxfmt-ignore\n" +
        `export const generatedBrowserRoutes = ${compactLiteral(
          Object.fromEntries(
            projections.routes.map((entity) => [
              entity.key,
              browserRoutes(entity),
            ]),
          ),
        )} as const satisfies Partial<Record<Entity, { basePath: string; routes: { detail: string; list: string } }>>;\n\n` +
        "// Generated entity roster stays one line.\n// oxfmt-ignore\n" +
        `export const generatedBrowserCrudEntities = ${compactLiteral(browserCrudEntities)} as const;\n` +
        "export type GeneratedBrowserCrudEntity = (typeof generatedBrowserCrudEntities)[number];\n",
    },
    {
      relativePath:
        "apps/web/src/server/generated/entity-kernel-entities.gen.ts",
      source:
        generatedHeader +
        "// Generated entity roster stays one line.\n// oxfmt-ignore\n" +
        `export const generatedEntityKernelEntities = ${compactLiteral(kernelEntityKeys)} as const;\n\n` +
        "// Generated capabilities stay compact and reviewable.\n// oxfmt-ignore\n" +
        `export const generatedEntityKernelContractCases = ${compactLiteral(kernelContractCases)} as const;\n\n` +
        "// Generated MCP exposure is a strict subset of executable kernel actions.\n" +
        "// oxfmt-ignore\n" +
        `export const generatedMcpEntityKernelContractCases = ${compactLiteral(mcpKernelContractCases)} as const;\n\n` +
        "// One generated entity roster per MCP action.\n" +
        "// oxfmt-ignore\n" +
        `export const generatedMcpEntityActionEntities = ${compactLiteral(
          Object.fromEntries(
            [
              "get",
              "list",
              "search",
              "create",
              "update",
              "delete",
              "bulkUpdate",
              "merge",
            ].map((action) => [action, mcpEntitiesForAction(action)]),
          ),
        )} as const;\n\n` +
        "// Generated action rosters stay one line each.\n// oxfmt-ignore\n" +
        `export const generatedSearchEntityKernelEntities = ${compactLiteral(entitiesForAction("search"))} as const;\n` +
        `export const generatedMergeEntityKernelEntities = ${compactLiteral(entitiesForAction("merge"))} as const;\n`,
    },
    {
      relativePath:
        "apps/web/src/server/generated/entity-relation-contracts.gen.ts",
      source:
        generatedHeader +
        'import { relationMutationOut } from "@cubby/schemas/common";\n' +
        'import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";\n' +
        'import { shortcodeSchema } from "@cubby/schemas/identifiers";\n' +
        `${relationSchemaImports}\n` +
        'import { z } from "zod";\n\n' +
        "// Generated relation command schemas stay correlated by entity and relation.\n" +
        `const generatedEntityRelationCommandSchema = ${relationCommandSchema(null)};\n` +
        `export const generatedBrowserEntityRelationCommandSchema = ${relationCommandSchema("browser")};\n` +
        `export const generatedMcpEntityRelationCommandSchema = ${relationCommandSchema("mcp")};\n\n` +
        `export const generatedMcpEntityRelationPreviewInputSchema = ${mcpPreviewInputSchema};\n\n` +
        `export const generatedEntityRelationMutationResultSchema = ${relationResultSchema};\n\n` +
        "export type GeneratedEntityRelationCommand = z.infer<typeof generatedEntityRelationCommandSchema>;\n\n" +
        "/** Resolve generated relation metadata without a parallel hand-written roster. */\n" +
        "export function generatedEntityRelationTarget(command: GeneratedEntityRelationCommand): ShortcodeEntity {\n" +
        "  switch (`${command.entity}:${command.relation}`) {\n" +
        `${relationTargetCases}\n` +
        "  }\n" +
        "  throw new Error(`Unsupported relation ${command.entity}:${command.relation}`);\n" +
        "}\n\n" +
        "export const generatedEntityRelationItemIds = (command: GeneratedEntityRelationCommand): string[] => command.items.map((item) => item.id);\n",
    },
    {
      relativePath:
        "apps/web/src/server/generated/entity-relation-bindings.gen.ts",
      source:
        generatedHeader +
        'import type { EntityKernelContext } from "~/server/entity-kernel/adapter";\n' +
        'import type { Database } from "~/server/db";\n' +
        'import type { GeneratedEntityRelationCommand } from "~/server/generated/entity-relation-contracts.gen";\n' +
        'import type { RelationPlan } from "~/server/repo/relation-preflight";\n' +
        'import type { z } from "zod";\n' +
        'import { generatedEntityRelationMutationResultSchema } from "~/server/generated/entity-relation-contracts.gen";\n\n' +
        `${relationAdapterImports}\n\n` +
        "/** Dispatch is generated from each literal relationship mutation declaration. */\n" +
        "export async function executeGeneratedRelationMutation(ctx: EntityKernelContext, command: GeneratedEntityRelationCommand): Promise<z.infer<typeof generatedEntityRelationMutationResultSchema>> {\n" +
        "  switch (`${command.entity}:${command.relation}`) {\n" +
        `${relationRuntimeCases}\n` +
        "  }\n" +
        "  throw new Error(`Unsupported relation mutation ${command.entity}:${command.relation}`);\n" +
        "}\n\n" +
        "/** Advisory planning uses the same generated relation-to-adapter dispatch. */\n" +
        "export async function previewGeneratedRelationMutation(db: Database, command: GeneratedEntityRelationCommand, ownerId: string, targetIds: readonly string[]): Promise<RelationPlan> {\n" +
        "  switch (`${command.entity}:${command.relation}`) {\n" +
        `${relationPreviewCases}\n` +
        "  }\n" +
        "  throw new Error(`Unsupported relation preview ${command.entity}:${command.relation}`);\n" +
        "}\n",
    },
    {
      relativePath:
        "apps/web/src/server/generated/entity-kernel-bindings.gen.ts",
      source:
        generatedHeader +
        "// Generated port aliases retain deterministic import order.\n" +
        'import type { EntityKernelCoreBinding } from "~/server/entity-kernel/adapter";\n' +
        'import type { EntityKernelEntity } from "~/server/entity-kernel/contracts";\n\n' +
        'import { defineEntityOperations } from "~/server/entity-kernel/entity-operations";\n\n' +
        `${portTypeImports}\n\n` +
        "/** Each literal module/export source reference is checked without a runtime import. */\n" +
        `type EntityPortExportChecks = readonly [${portExportChecks
          .map(
            (ref) =>
              `typeof ${portTypeModuleAliases.get(ref.module)}[${JSON.stringify(ref.export)}]`,
          )
          .join(", ")}];\n\n` +
        `${runtimeAdapterImportSource}\n\n` +
        "type CorrelatedEntityKernelBindings = {\n" +
        "  [E in EntityKernelEntity]: EntityKernelCoreBinding<E>;\n" +
        "};\n\n" +
        "// Generated runtime assembly stays one entity per line.\n// oxfmt-ignore\n" +
        `export const ENTITY_KERNEL_BINDINGS = {\n${runtimeBindings}\n} as const satisfies CorrelatedEntityKernelBindings & { readonly __portExportChecks?: EntityPortExportChecks };\n` +
        "// Generated operation closures retain each binding's schema correlation.\n// oxfmt-ignore\n" +
        `export const ENTITY_KERNEL_OPERATIONS = {\n${runtimeOperations}\n} as const;\n`,
    },
    {
      relativePath:
        "apps/web/src/server/repo/generated/shortcode-tables.gen.ts",
      source:
        generatedHeader +
        "// Generated table imports stay one entity per line.\n// oxfmt-ignore\n" +
        `import {\n${shortcodeTableImportNames.map((name) => `  ${name},`).join("\n")}\n} from "~/server/db/schema";\n\n` +
        "// Generated table bindings stay one entity per line.\n// oxfmt-ignore\n" +
        `export const SHORTCODE_TABLE = {\n${shortcodeTableBindings}\n} as const;\n`,
    },
  ];
};

export const renderFilterArtifacts = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
  const { filters: filterEntities } = entityProjectionMaps(entities);
  const roster = Object.fromEntries(
    filterEntities.map(({ key, filterUrlKeys }) => [key, filterUrlKeys]),
  );
  const filterRefs = [
    ...new Map(
      filterEntities.flatMap(({ filterDescriptors }) =>
        filterDescriptors.flatMap((descriptor) =>
          [descriptor.optionsRef, descriptor.expandRef]
            .filter((ref): ref is SourceRef => ref !== null)
            .map((ref) => [`${ref.module}#${ref.export}`, ref] as const),
        ),
      ),
    ).values(),
  ].sort((left, right) =>
    `${left.module}#${left.export}`.localeCompare(
      `${right.module}#${right.export}`,
    ),
  );
  const refAliases = new Map(
    filterRefs.map((ref, index) => [
      `${ref.module}#${ref.export}`,
      `filterRef${index}`,
    ]),
  );
  const runtimeImportsByModule = new Map<
    string,
    Array<{ export: string; alias: string }>
  >();
  for (const [index, ref] of filterRefs.entries()) {
    const imports = runtimeImportsByModule.get(ref.module) ?? [];
    imports.push({ export: ref.export, alias: `filterRef${index}` });
    runtimeImportsByModule.set(ref.module, imports);
  }
  const runtimeImports = [...runtimeImportsByModule.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([module, imports]) =>
        `import { ${imports.map(({ export: name, alias }) => `${name} as ${alias}`).join(", ")} } from ${JSON.stringify(module)};`,
    )
    .join("\n");
  const runtimeDescriptor = (descriptor: FilterDescriptor): string => {
    const properties = [
      `columnId:${JSON.stringify(descriptor.columnId)}`,
      ...(descriptor.field === null
        ? []
        : [`field:${JSON.stringify(descriptor.field)}`]),
      ...(descriptor.urlKey === descriptor.columnId
        ? []
        : [`urlKey:${JSON.stringify(descriptor.urlKey)}`]),
      `kind:${JSON.stringify(descriptor.kind)}`,
      `placeholder:${JSON.stringify(descriptor.placeholder)}`,
      ...(descriptor.options === null
        ? []
        : [`options:${compactLiteral(descriptor.options)}`]),
      ...(descriptor.optionsRef === null
        ? []
        : [
            `options:${refAliases.get(`${descriptor.optionsRef.module}#${descriptor.optionsRef.export}`)}`,
          ]),
      ...(descriptor.optionsKey === null
        ? []
        : [`optionsKey:${JSON.stringify(descriptor.optionsKey)}`]),
      ...(descriptor.label === null
        ? []
        : [`label:${JSON.stringify(descriptor.label)}`]),
      ...(descriptor.brandRef === null
        ? []
        : [
            `brand:(value) => ${
              descriptor.brandRef.kind === "id"
                ? `parseEntityId(${JSON.stringify(descriptor.brandRef.entity)}, value)`
                : `parseShortcodeFor(${JSON.stringify(descriptor.brandRef.entity)}, value)`
            }`,
          ]),
      ...(descriptor.expandRef === null
        ? []
        : [
            `expand:${refAliases.get(`${descriptor.expandRef.module}#${descriptor.expandRef.export}`)}`,
          ]),
      ...(descriptor.urlOnly ? ["urlOnly:true"] : []),
      ...(descriptor.nullable === null
        ? []
        : [`nullable:${compactLiteral(descriptor.nullable)}`]),
    ];
    return `{${properties.join(",")}}`;
  };
  const runtimeRoster = filterEntities
    .map(
      ({ key, filterDescriptors }) =>
        `${JSON.stringify(key)}:[${filterDescriptors.map(runtimeDescriptor).join(",")}],`,
    )
    .join("\n");
  const filterContractCases = Object.fromEntries(
    filterEntities.map(
      ({ key, filterAudit, filterSchema, filterDescriptors }) => [
        key,
        {
          descriptorColumns: filterDescriptors.map(({ columnId }) => columnId),
          urlKeys: filterDescriptors.map(({ urlKey }) => urlKey),
          schema:
            filterSchema === null
              ? null
              : `${filterSchema.module}#${filterSchema.export}`,
          optionSources: [
            ...new Set(
              filterDescriptors.flatMap((descriptor) => [
                ...(descriptor.optionsKey === null
                  ? []
                  : [descriptor.optionsKey]),
                ...(descriptor.optionsRef === null
                  ? []
                  : [
                      `${descriptor.optionsRef.module}#${descriptor.optionsRef.export}`,
                    ]),
              ]),
            ),
          ],
          audit: filterAudit,
          rangeExpanders: filterDescriptors.flatMap((descriptor) =>
            descriptor.kind === "range" && descriptor.expandRef !== null
              ? [
                  `${descriptor.columnId}:${descriptor.expandRef.module}#${descriptor.expandRef.export}`,
                ]
              : [],
          ),
        },
      ],
    ),
  );
  return [
    {
      relativePath:
        "apps/web/src/entities/generated/entity-filter-contracts.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "@cubby/schemas/entity";\n\n' +
        "export type EntityFilterContractCase = {\n" +
        "  descriptorColumns: readonly string[];\n" +
        "  urlKeys: readonly string[];\n" +
        "  schema: string | null;\n" +
        "  optionSources: readonly string[];\n" +
        "  audit: boolean;\n" +
        "  rangeExpanders: readonly string[];\n" +
        "};\n\n" +
        "// Generated contract cases keep mechanical filter invariants reviewable.\n" +
        "// Generated filter contract cases stay compact.\n// oxfmt-ignore\n" +
        `export const generatedEntityFilterContractCases = ${compactLiteral(filterContractCases)} as const satisfies Record<Entity, EntityFilterContractCase>;\n`,
    },
    {
      relativePath: "apps/web/src/entities/filter-search-fields.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "@cubby/schemas/entity";\n' +
        'import { urlStringParam } from "~/lib/search-params";\n\n' +
        "// Generated data stays one entity per line.\n// oxfmt-ignore\n" +
        `const entityFilterUrlKeyRoster = ${compactLiteral(roster)} as const satisfies Record<Entity, readonly string[]>;\n` +
        "\n" +
        "/** The URL keys an entity accepts for its canonical filter assembly. */\n" +
        "export const entityFilterUrlKeys = (entity: Entity): readonly string[] =>\n" +
        "  entityFilterUrlKeyRoster[entity] ?? [];\n\n" +
        "export function entityFilterSearchFields(\n" +
        "  entity: Entity,\n" +
        ") {\n" +
        "  return Object.fromEntries(\n" +
        "    entityFilterUrlKeys(entity).map((key) => [key, urlStringParam]),\n" +
        "  );\n" +
        "}\n",
    },
    {
      relativePath:
        "apps/web/src/entities/generated/entity-filter-bindings.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "@cubby/schemas/entity";\n' +
        'import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";\n' +
        `${runtimeImports}\n` +
        'import type { FilterSpec } from "../filter-manifest";\n\n' +
        "// Generated runtime filter assembly stays one entity per line.\n// oxfmt-ignore\n" +
        `export const generatedEntityFilters = {\n${runtimeRoster}\n} satisfies Record<Entity, readonly FilterSpec[]>;\n`,
    },
  ];
};

const formatSource = (root: string, artifact: EntityArtifacts): string => {
  const result = execFileSync(
    "pnpm",
    ["exec", "oxfmt", "--stdin-filepath", artifact.relativePath],
    { cwd: root, encoding: "utf8", input: artifact.source },
  );
  return result;
};

const ARTIFACT_HASH_PATTERN =
  /^\/\/ Entity artifact hashes: source=([a-f0-9]+) content=([a-f0-9]+)\n/m;
const artifactHash = (source: string) =>
  createHash("sha256").update(source).digest("hex").slice(0, 16);

const sealArtifact = (
  root: string,
  artifact: EntityArtifacts,
): EntityArtifacts => {
  const formatted = formatSource(root, artifact);
  const hashLine = `// Entity artifact hashes: source=${artifactHash(artifact.source)} content=${artifactHash(formatted)}\n`;
  return {
    ...artifact,
    source: formatted.replace(generatedHeader, generatedHeader + hashLine),
  };
};

const generatedName =
  /^(?:entity-literal-.+|entity-manifest-data|entity-field-model|entity-field-schemas(?:\.[^.]+)?|entity-columns|entity-inspector|entity-details|entity-lists|entity-filter-catalog|entity-filter-bindings|entity-filter-fields|entity-bindings|entity-routes|entity-kernel-bindings|entity-kernel-entities|entity-runtime-ports|filter-search-fields|shortcode-registry|shortcode-tables)\.gen\.ts$/;

const findExtraArtifacts = async (
  root: string,
  artifacts: readonly EntityArtifacts[],
) => {
  const expected = new Set(artifacts.map(({ relativePath }) => relativePath));
  const directories = new Set(
    artifacts.map(({ relativePath }) => dirname(relativePath)),
  );
  const extras: string[] = [];
  for (const directory of directories) {
    const absoluteDirectory = resolve(root, directory);
    try {
      const entries = await readdir(absoluteDirectory, { withFileTypes: true });
      for (const entry of entries) {
        const relativePath = `${directory}/${entry.name}`;
        if (
          entry.isFile() &&
          generatedName.test(entry.name) &&
          !expected.has(relativePath)
        ) {
          extras.push(relativePath);
        }
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }
  return extras.sort();
};

export const checkEntityArtifacts = async (
  root: string,
  artifacts: readonly EntityArtifacts[],
) => {
  const problems: string[] = [];
  for (const artifact of artifacts) {
    const artifactPath = resolve(root, artifact.relativePath);
    try {
      const current = await readFile(artifactPath, "utf8");
      if (current !== artifact.source) {
        problems.push(`stale: ${artifact.relativePath}`);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        problems.push(`missing: ${artifact.relativePath}`);
        continue;
      }
      throw error;
    }
  }
  for (const extra of await findExtraArtifacts(root, artifacts)) {
    problems.push(`extraneous: ${extra}`);
  }
  return problems;
};

const checkSealedEntityArtifacts = async (
  root: string,
  artifacts: readonly EntityArtifacts[],
) => {
  const problems: string[] = [];
  for (const artifact of artifacts) {
    try {
      const current = await readFile(
        resolve(root, artifact.relativePath),
        "utf8",
      );
      const hashes = current.match(ARTIFACT_HASH_PATTERN);
      const content = current.replace(ARTIFACT_HASH_PATTERN, "");
      if (
        hashes?.[1] !== artifactHash(artifact.source) ||
        hashes?.[2] !== artifactHash(content)
      ) {
        problems.push(`stale: ${artifact.relativePath}`);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        problems.push(`missing: ${artifact.relativePath}`);
        continue;
      }
      throw error;
    }
  }
  for (const extra of await findExtraArtifacts(root, artifacts)) {
    problems.push(`extraneous: ${extra}`);
  }
  return problems;
};

const writeEntityArtifacts = async (
  root: string,
  artifacts: readonly EntityArtifacts[],
) => {
  const problems = await checkEntityArtifacts(root, artifacts);
  const extras = problems.filter((problem) =>
    problem.startsWith("extraneous:"),
  );
  if (extras.length > 0) {
    throw new EntityDeclarationError(
      `Refusing to overwrite with ${extras.join(", ")}.`,
    );
  }
  for (const artifact of artifacts) {
    const artifactPath = resolve(root, artifact.relativePath);
    await stat(dirname(artifactPath)).catch(async (error) => {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        await mkdir(dirname(artifactPath), { recursive: true });
        return;
      }
      throw error;
    });
    await writeFile(artifactPath, artifact.source);
  }
};

const generateEntityArtifacts = async (root = ROOT) => {
  const entities = await loadEntityDeclarations();
  const artifacts = [
    ...renderEntityArtifacts(entities),
    ...renderFilterArtifacts(entities),
  ].map((artifact) => sealArtifact(root, artifact));
  return { entities, artifacts };
};

const main = async () => {
  const check = process.argv.slice(2).includes("--check");
  const unknownArguments = process.argv
    .slice(2)
    .filter((argument) => argument !== "--check");
  if (unknownArguments.length > 0) {
    throw new EntityDeclarationError(
      `Unknown arguments: ${unknownArguments.join(", ")}.`,
    );
  }
  if (check) {
    const entities = await loadEntityDeclarations();
    const artifacts = [
      ...renderEntityArtifacts(entities),
      ...renderFilterArtifacts(entities),
    ];
    const problems = await checkSealedEntityArtifacts(ROOT, artifacts);
    if (problems.length > 0) {
      throw new EntityDeclarationError(
        `Generated entity artifacts are out of date:\n${problems.join("\n")}`,
      );
    }
    const missingRoutes = missingBrowserRouteFiles(entities);
    if (missingRoutes.length > 0) {
      throw new EntityDeclarationError(
        `Generated browser routes are missing route modules:\n${missingRoutes.map((path) => `- ${path}`).join("\n")}`,
      );
    }
    return;
  }
  const { artifacts } = await generateEntityArtifacts();
  await writeEntityArtifacts(ROOT, artifacts);
};

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
