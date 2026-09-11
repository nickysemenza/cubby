import { parseEntityDeclarationMetadata } from "../../packages/schemas/src/entity-definitions/definition.ts";
import type {
  EntityDeclarationMetadata,
  EntityFieldModelMetadata,
  EntityStorageMetadata,
} from "../../packages/schemas/src/entity-definitions/definition.ts";
import {
  EntityDeclarationError,
  objectValue,
  required,
  stringValue,
  booleanValue,
} from "./declarations.ts";
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
export const compileEntity = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- imported declaration boundary
  value: unknown,
  index: number,
): CompiledEntity => {
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
