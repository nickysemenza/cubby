import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_DIRECTORY = resolve(ROOT, "scripts/entity-literals/entities");
const SPEC_PATH = SPEC_DIRECTORY;

type AstValue = string | number | boolean | null | AstNode | AstValue[];
type AstNode = { type: string; [key: string]: AstValue | undefined };
type LiteralValue =
  | string
  | number
  | boolean
  | null
  | LiteralObject
  | LiteralValue[];
interface LiteralObject {
  [key: string]: LiteralValue;
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
  options: readonly LiteralObject[] | null;
  optionsRef: SourceRef | null;
  optionsKey: string | null;
  label: string | null;
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
export type EntityLiteral = Readonly<{
  key: string;
  shortcode: string | null;
  legacyShortcode: string | null;
  inspector: Readonly<{
    singular: string;
    plural: string | null;
    titleField: string;
  }>;
  descriptor: LiteralObject;
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
  relationMutations: readonly RelationMutation[];
  operationOwners: Readonly<{
    delete: OperationOwner;
    merge: OperationOwner;
  }>;
}>;

export type EntityArtifacts = Readonly<{
  relativePath: string;
  source: string;
}>;

class LiteralSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiteralSpecError";
  }
}

const isNode = <T>(value: T): value is T & AstNode =>
  typeof value === "object" && value !== null && "type" in value;

const asNode = <T>(value: T, context: string): AstNode => {
  if (!isNode(value)) {
    throw new LiteralSpecError(`${context} must be syntax.`);
  }
  return value;
};

const isLiteralObject = (value: LiteralValue): value is LiteralObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: LiteralValue): value is string =>
  typeof value === "string" && value.length > 0;

const isBoolean = (value: LiteralValue): value is boolean =>
  typeof value === "boolean";

const objectValue = (value: LiteralValue, context: string): LiteralObject => {
  if (!isLiteralObject(value)) {
    throw new LiteralSpecError(`${context} must be an object.`);
  }
  return value;
};

const required = (object: LiteralObject, key: string, context: string) => {
  if (!(key in object)) {
    throw new LiteralSpecError(`${context}.${key} is required.`);
  }
  const value = object[key];
  if (value === undefined) {
    throw new LiteralSpecError(`${context}.${key} must not be undefined.`);
  }
  return value;
};

const stringValue = (value: LiteralValue, context: string): string => {
  if (!isNonEmptyString(value)) {
    throw new LiteralSpecError(`${context} must be a non-empty string.`);
  }
  return value;
};

const booleanValue = (value: LiteralValue, context: string): boolean => {
  if (!isBoolean(value)) {
    throw new LiteralSpecError(`${context} must be a boolean.`);
  }
  return value;
};

const exactKeys = (
  object: LiteralObject,
  allowed: readonly string[],
  context: string,
) => {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw new LiteralSpecError(`${context}.${key} is not allowed.`);
    }
  }
};

const literalObjectArray = (
  value: LiteralValue,
  context: string,
): LiteralObject[] => {
  if (!Array.isArray(value)) {
    throw new LiteralSpecError(`${context} must be an array.`);
  }
  return value.map((item, index) => objectValue(item, `${context}[${index}]`));
};

const sourceRef = (value: LiteralValue, context: string): SourceRef => {
  const object = objectValue(value, context);
  exactKeys(object, ["module", "export"], context);
  return {
    module: stringValue(
      required(object, "module", context),
      `${context}.module`,
    ),
    export: stringValue(
      required(object, "export", context),
      `${context}.export`,
    ),
  };
};

const identifierRef = (value: LiteralValue, context: string): IdentifierRef => {
  const object = objectValue(value, context);
  exactKeys(object, ["entity", "kind"], context);
  const kind = stringValue(
    required(object, "kind", context),
    `${context}.kind`,
  );
  if (kind !== "id" && kind !== "shortcode") {
    throw new LiteralSpecError(`${context}.kind must be id or shortcode.`);
  }
  return {
    entity: stringValue(
      required(object, "entity", context),
      `${context}.entity`,
    ),
    kind,
  };
};

const nullableSourceRef = (
  value: LiteralValue,
  context: string,
): SourceRef | null => (value === null ? null : sourceRef(value, context));

const entityPorts = (
  value: LiteralValue | undefined,
  context: string,
): EntityPorts => {
  if (value === undefined) {
    return {
      repository: null,
      references: { label: null, resolver: null },
      filters: null,
      search: { projection: null, semanticText: null, dependentRefresh: null },
    };
  }
  const ports = objectValue(value, context);
  exactKeys(ports, ["repository", "references", "filters", "search"], context);
  const references = objectValue(
    required(ports, "references", context),
    `${context}.references`,
  );
  exactKeys(references, ["label", "resolver"], `${context}.references`);
  const search = objectValue(
    required(ports, "search", context),
    `${context}.search`,
  );
  exactKeys(
    search,
    ["projection", "semanticText", "dependentRefresh"],
    `${context}.search`,
  );
  return {
    repository: nullableSourceRef(
      required(ports, "repository", context),
      `${context}.repository`,
    ),
    references: {
      label: nullableSourceRef(
        required(references, "label", `${context}.references`),
        `${context}.references.label`,
      ),
      resolver: nullableSourceRef(
        required(references, "resolver", `${context}.references`),
        `${context}.references.resolver`,
      ),
    },
    filters: nullableSourceRef(
      required(ports, "filters", context),
      `${context}.filters`,
    ),
    search: {
      projection: nullableSourceRef(
        required(search, "projection", `${context}.search`),
        `${context}.search.projection`,
      ),
      semanticText: nullableSourceRef(
        required(search, "semanticText", `${context}.search`),
        `${context}.search.semanticText`,
      ),
      dependentRefresh: nullableSourceRef(
        required(search, "dependentRefresh", `${context}.search`),
        `${context}.search.dependentRefresh`,
      ),
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

const optionalString = (
  object: LiteralObject,
  key: string,
  context: string,
): string | null =>
  object[key] === undefined || object[key] === null
    ? null
    : stringValue(object[key], `${context}.${key}`);

const filterDescriptor = (
  value: LiteralValue,
  context: string,
): FilterDescriptor => {
  const object = objectValue(value, context);
  exactKeys(
    object,
    [
      "columnId",
      "field",
      "urlKey",
      "kind",
      "placeholder",
      "options",
      "optionsRef",
      "optionsKey",
      "label",
      "brandRef",
      "expandRef",
      "urlOnly",
      "nullable",
    ],
    context,
  );
  const columnId = stringValue(
    required(object, "columnId", context),
    `${context}.columnId`,
  );
  const kind = stringValue(
    required(object, "kind", context),
    `${context}.kind`,
  );
  const parsedKind = filterKinds.find((candidate) => candidate === kind);
  if (parsedKind === undefined) {
    throw new LiteralSpecError(`${context}.kind is unsupported.`);
  }
  const rawOptions = object.options;
  if (
    rawOptions !== undefined &&
    rawOptions !== null &&
    !Array.isArray(rawOptions)
  ) {
    throw new LiteralSpecError(`${context}.options must be an array.`);
  }
  const options =
    rawOptions === undefined || rawOptions === null
      ? null
      : rawOptions.map((option, index) => {
          const optionContext = `${context}.options[${index}]`;
          const parsed = objectValue(option, optionContext);
          exactKeys(parsed, ["value", "label", "meta", "color"], optionContext);
          stringValue(
            required(parsed, "value", optionContext),
            `${optionContext}.value`,
          );
          stringValue(
            required(parsed, "label", optionContext),
            `${optionContext}.label`,
          );
          if (parsed.meta !== undefined)
            booleanValue(parsed.meta, `${optionContext}.meta`);
          if (parsed.color !== undefined)
            stringValue(parsed.color, `${optionContext}.color`);
          return parsed;
        });
  const optionsRef =
    object.optionsRef === undefined || object.optionsRef === null
      ? null
      : sourceRef(object.optionsRef, `${context}.optionsRef`);
  if (options !== null && optionsRef !== null) {
    throw new LiteralSpecError(
      `${context} cannot declare both options and optionsRef.`,
    );
  }
  const nullable =
    object.nullable === undefined || object.nullable === null
      ? null
      : (() => {
          const nullableContext = `${context}.nullable`;
          const parsed = objectValue(object.nullable, nullableContext);
          exactKeys(parsed, ["field", "label"], nullableContext);
          return {
            field: stringValue(
              required(parsed, "field", nullableContext),
              `${nullableContext}.field`,
            ),
            label: stringValue(
              required(parsed, "label", nullableContext),
              `${nullableContext}.label`,
            ),
          };
        })();
  return {
    columnId,
    field: optionalString(object, "field", context),
    urlKey: optionalString(object, "urlKey", context) ?? columnId,
    kind: parsedKind,
    placeholder: stringValue(
      required(object, "placeholder", context),
      `${context}.placeholder`,
    ),
    options,
    optionsRef,
    optionsKey: optionalString(object, "optionsKey", context),
    label: optionalString(object, "label", context),
    brandRef:
      object.brandRef === undefined || object.brandRef === null
        ? null
        : identifierRef(object.brandRef, `${context}.brandRef`),
    expandRef:
      object.expandRef === undefined || object.expandRef === null
        ? null
        : sourceRef(object.expandRef, `${context}.expandRef`),
    urlOnly:
      object.urlOnly === undefined
        ? false
        : booleanValue(object.urlOnly, `${context}.urlOnly`),
    nullable,
  };
};

const normalizedEntitySource = (
  raw: LiteralObject,
  context: string,
): LiteralObject => {
  if (raw.descriptor !== undefined) {
    const rawDescriptor = objectValue(raw.descriptor, `${context}.descriptor`);
    const lifecycle =
      rawDescriptor.lifecycle === undefined
        ? null
        : objectValue(
            rawDescriptor.lifecycle,
            `${context}.descriptor.lifecycle`,
          );
    const hasRepository = raw.ports !== undefined;
    return {
      filters: { audit: false, descriptors: [] },
      inspector: {
        singular: required(raw, "key", context),
        plural: null,
        titleField: "name",
      },
      operationOwners: raw.operationOwners ?? {
        delete:
          lifecycle === null || lifecycle.delete === null
            ? null
            : hasRepository
              ? "kernel"
              : "workflow",
        merge:
          lifecycle?.merge === true
            ? hasRepository
              ? "kernel"
              : "workflow"
            : null,
      },
      ...raw,
    };
  }
  exactKeys(
    raw,
    [
      "key",
      "names",
      "route",
      "table",
      "identifiers",
      "presentation",
      "fields",
      "filters",
      "relations",
      "search",
      "capabilities",
      "extensions",
    ],
    context,
  );
  const names = objectValue(
    required(raw, "names", context),
    `${context}.names`,
  );
  exactKeys(names, ["singular", "plural"], `${context}.names`);
  const identifiers = objectValue(
    required(raw, "identifiers", context),
    `${context}.identifiers`,
  );
  exactKeys(
    identifiers,
    ["brand", "shortcode", "legacy"],
    `${context}.identifiers`,
  );
  const presentation = objectValue(
    required(raw, "presentation", context),
    `${context}.presentation`,
  );
  exactKeys(presentation, ["titleField"], `${context}.presentation`);
  const search = objectValue(
    required(raw, "search", context),
    `${context}.search`,
  );
  exactKeys(search, ["enabled"], `${context}.search`);
  const capabilities = objectValue(
    required(raw, "capabilities", context),
    `${context}.capabilities`,
  );
  exactKeys(
    capabilities,
    [
      "auditable",
      "images",
      "countable",
      "softDelete",
      "delete",
      "bulkUpdate",
      "merge",
      "operationOwners",
      "mcp",
    ],
    `${context}.capabilities`,
  );
  const extensions = objectValue(
    required(raw, "extensions", context),
    `${context}.extensions`,
  );
  exactKeys(
    extensions,
    ["countFilter", "relatednessSignals", "mcpNames", "ports"],
    `${context}.extensions`,
  );
  validateLegacyCapabilities(raw, capabilities, context);
  const relations = normalizedLegacyRelations(raw, context);
  const route = normalizedLegacyRoute(raw, context);
  const descriptor = legacyDescriptor(
    raw,
    identifiers,
    capabilities,
    search,
    relations,
    route,
    extensions,
    context,
  );
  return normalizedLegacyEntity(
    raw,
    names,
    presentation,
    descriptor,
    route,
    capabilities,
    extensions,
    context,
  );
};

const validateLegacyCapabilities = (
  raw: LiteralObject,
  capabilities: LiteralObject,
  context: string,
): void => {
  const owners = objectValue(
    required(capabilities, "operationOwners", `${context}.capabilities`),
    `${context}.capabilities.operationOwners`,
  );
  exactKeys(
    owners,
    ["delete", "merge"],
    `${context}.capabilities.operationOwners`,
  );
  const validateOwner = (operation: "delete" | "merge") => {
    const owner = required(
      owners,
      operation,
      `${context}.capabilities.operationOwners`,
    );
    if (owner !== null && owner !== "kernel" && owner !== "workflow") {
      throw new LiteralSpecError(
        `${context}.capabilities.operationOwners.${operation} must be kernel, workflow, or null.`,
      );
    }
    return owner;
  };
  const deleteOwner = validateOwner("delete");
  const mergeOwner = validateOwner("merge");
  const deleteCapability = required(
    capabilities,
    "delete",
    `${context}.capabilities`,
  );
  if (deleteCapability !== null) {
    if (deleteOwner === null) {
      throw new LiteralSpecError(
        `${context}.capabilities.operationOwners.delete is required for delete.`,
      );
    }
    const deletion = objectValue(
      deleteCapability,
      `${context}.capabilities.delete`,
    );
    exactKeys(deletion, ["mode", "bulk"], `${context}.capabilities.delete`);
    const mode = stringValue(
      required(deletion, "mode", `${context}.capabilities.delete`),
      `${context}.capabilities.delete.mode`,
    );
    if (mode !== "soft" && mode !== "hard")
      throw new LiteralSpecError(
        `${context}.capabilities.delete.mode is invalid.`,
      );
    booleanValue(
      required(deletion, "bulk", `${context}.capabilities.delete`),
      `${context}.capabilities.delete.bulk`,
    );
  }
  if (deleteCapability === null && deleteOwner !== null) {
    throw new LiteralSpecError(
      `${context}.capabilities.operationOwners.delete must be null without delete.`,
    );
  }
  const mergeCapability = booleanValue(
    required(capabilities, "merge", `${context}.capabilities`),
    `${context}.capabilities.merge`,
  );
  if (mergeCapability !== (mergeOwner !== null)) {
    throw new LiteralSpecError(
      `${context}.capabilities.operationOwners.merge must match merge capability.`,
    );
  }
  const bulkUpdateCapability = required(
    capabilities,
    "bulkUpdate",
    `${context}.capabilities`,
  );
  if (bulkUpdateCapability !== null) {
    const bulkUpdate = objectValue(
      bulkUpdateCapability,
      `${context}.capabilities.bulkUpdate`,
    );
    exactKeys(bulkUpdate, ["fields"], `${context}.capabilities.bulkUpdate`);
    const fields = required(
      bulkUpdate,
      "fields",
      `${context}.capabilities.bulkUpdate`,
    );
    if (!Array.isArray(fields) || fields.length === 0) {
      throw new LiteralSpecError(
        `${context}.capabilities.bulkUpdate.fields must be a non-empty array.`,
      );
    }
    // The generator never imports the update schema (it reads specs as AST), so
    // field names are checked structurally here and by TYPE in the artifact: the
    // emitted `.pick({...})` fails typecheck on a field the schema does not have.
    const names = fields.map((field, index) =>
      stringValue(field, `${context}.capabilities.bulkUpdate.fields[${index}]`),
    );
    if (new Set(names).size !== names.length) {
      throw new LiteralSpecError(
        `${context}.capabilities.bulkUpdate.fields contains duplicates.`,
      );
    }
    if (required(raw, "fields", context) === null) {
      throw new LiteralSpecError(
        `${context}.capabilities.bulkUpdate requires an update schema.`,
      );
    }
  }
  booleanValue(
    required(capabilities, "merge", `${context}.capabilities`),
    `${context}.capabilities.merge`,
  );
  const mcpActions = required(capabilities, "mcp", `${context}.capabilities`);
  if (!Array.isArray(mcpActions))
    throw new LiteralSpecError(`${context}.capabilities.mcp must be an array.`);
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
  for (const [index, action] of mcpActions.entries()) {
    const name = stringValue(action, `${context}.capabilities.mcp[${index}]`);
    if (!supportedMcpActions.includes(name))
      throw new LiteralSpecError(
        `${context}.capabilities.mcp[${index}] is unsupported.`,
      );
  }
};

// Keep relation normalization in one diagnostic context: every rejected field
// must identify the same literal relation path, including nested sources.
// oxlint-disable-next-line eslint/complexity
const normalizedLegacyRelations = (
  raw: LiteralObject,
  context: string,
): LiteralValue[] => {
  const relations = required(raw, "relations", context);
  if (!Array.isArray(relations))
    throw new LiteralSpecError(`${context}.relations must be an array.`);
  for (const [index, value] of relations.entries()) {
    const relation = objectValue(value, `${context}.relations[${index}]`);
    exactKeys(
      relation,
      [
        "key",
        "label",
        "target",
        "cardinality",
        "sourceKey",
        "provenance",
        "inverse",
        "sources",
        "mutation",
      ],
      `${context}.relations[${index}]`,
    );
    const relationKey = stringValue(
      required(relation, "key", `${context}.relations[${index}]`),
      `${context}.relations[${index}].key`,
    );
    const cardinality = stringValue(
      required(relation, "cardinality", `${context}.relations[${index}]`),
      `${context}.relations[${index}].cardinality`,
    );
    if (cardinality !== "one" && cardinality !== "many") {
      throw new LiteralSpecError(
        `${context}.relations[${index}].cardinality must be one or many.`,
      );
    }
    const sourceKey =
      relation.sourceKey === undefined
        ? relationKey
        : stringValue(
            relation.sourceKey,
            `${context}.relations[${index}].sourceKey`,
          );
    relation.sourceKey = sourceKey;
    const provenance = objectValue(
      required(relation, "provenance", `${context}.relations[${index}]`),
      `${context}.relations[${index}].provenance`,
    );
    if (provenance.kind === "local-path" && relation.inverse === undefined)
      throw new LiteralSpecError(
        `${context}.relations[${index}] local-path requires inverse.`,
      );
    const sources =
      relation.sources === undefined
        ? []
        : literalObjectArray(
            relation.sources,
            `${context}.relations[${index}].sources`,
          );
    const sourceKeys = [sourceKey];
    for (const [sourceIndex, source] of sources.entries()) {
      exactKeys(
        source,
        ["key", "label", "provenance", "inverse"],
        `${context}.relations[${index}].sources[${sourceIndex}]`,
      );
      const key = stringValue(
        required(
          source,
          "key",
          `${context}.relations[${index}].sources[${sourceIndex}]`,
        ),
        `${context}.relations[${index}].sources[${sourceIndex}].key`,
      );
      sourceKeys.push(key);
      const sourceProvenance = objectValue(
        required(
          source,
          "provenance",
          `${context}.relations[${index}].sources[${sourceIndex}]`,
        ),
        `${context}.relations[${index}].sources[${sourceIndex}].provenance`,
      );
      if (
        sourceProvenance.kind === "local-path" &&
        source.inverse === undefined
      ) {
        throw new LiteralSpecError(
          `${context}.relations[${index}].sources[${sourceIndex}] local-path requires inverse.`,
        );
      }
    }
    if (new Set(sourceKeys).size !== sourceKeys.length) {
      throw new LiteralSpecError(
        `${context}.relations[${index}] contains duplicate source keys.`,
      );
    }
    relation.sources = sources;
    if (relation.mutation !== undefined) {
      const mutation = objectValue(
        relation.mutation,
        `${context}.relations[${index}].mutation`,
      );
      exactKeys(
        mutation,
        ["source", "itemSchema", "adapter", "audiences"],
        `${context}.relations[${index}].mutation`,
      );
      const mutationSource = stringValue(
        required(mutation, "source", `${context}.relations[${index}].mutation`),
        `${context}.relations[${index}].mutation.source`,
      );
      if (!sourceKeys.includes(mutationSource)) {
        throw new LiteralSpecError(
          `${context}.relations[${index}].mutation.source must name a declared source.`,
        );
      }
      mutation.itemSchema = sourceRef(
        required(
          mutation,
          "itemSchema",
          `${context}.relations[${index}].mutation`,
        ),
        `${context}.relations[${index}].mutation.itemSchema`,
      );
      mutation.adapter = sourceRef(
        required(
          mutation,
          "adapter",
          `${context}.relations[${index}].mutation`,
        ),
        `${context}.relations[${index}].mutation.adapter`,
      );
      const audiences = required(
        mutation,
        "audiences",
        `${context}.relations[${index}].mutation`,
      );
      if (!Array.isArray(audiences) || audiences.length === 0) {
        throw new LiteralSpecError(
          `${context}.relations[${index}].mutation.audiences must be a non-empty array.`,
        );
      }
      for (const [audienceIndex, audience] of audiences.entries()) {
        const name = stringValue(
          audience,
          `${context}.relations[${index}].mutation.audiences[${audienceIndex}]`,
        );
        if (name !== "browser" && name !== "mcp") {
          throw new LiteralSpecError(
            `${context}.relations[${index}].mutation.audiences[${audienceIndex}] is unsupported.`,
          );
        }
      }
      if (new Set(audiences).size !== audiences.length) {
        throw new LiteralSpecError(
          `${context}.relations[${index}].mutation.audiences contains duplicates.`,
        );
      }
    }
  }
  return relations;
};

const normalizedLegacyRoute = (
  raw: LiteralObject,
  context: string,
): LiteralValue => {
  const route = required(raw, "route", context);
  if (route !== null) {
    exactKeys(
      objectValue(route, `${context}.route`),
      ["basePath", "detailParam"],
      `${context}.route`,
    );
  }
  return route;
};

const legacyDescriptor = (
  raw: LiteralObject,
  identifiers: LiteralObject,
  capabilities: LiteralObject,
  search: LiteralObject,
  relations: LiteralValue[],
  route: LiteralValue,
  extensions: LiteralObject,
  context: string,
): LiteralObject => {
  const descriptor: LiteralObject = {
    dbTable: required(raw, "table", context),
    idBrand: required(identifiers, "brand", `${context}.identifiers`),
  };
  if (identifiers.shortcode !== null && identifiers.shortcode !== undefined) {
    descriptor.shortcodePrefix = identifiers.shortcode;
  }
  if (identifiers.legacy !== null && identifiers.legacy !== undefined) {
    descriptor.legacyShortcodePrefix = identifiers.legacy;
  }
  descriptor.softDelete = required(
    capabilities,
    "softDelete",
    `${context}.capabilities`,
  );
  if (route === null) descriptor.browserRoutes = false;
  descriptor.auditable = required(
    capabilities,
    "auditable",
    `${context}.capabilities`,
  );
  descriptor.hasImages = required(
    capabilities,
    "images",
    `${context}.capabilities`,
  );
  descriptor.searchable = required(search, "enabled", `${context}.search`);
  descriptor.countable = required(
    capabilities,
    "countable",
    `${context}.capabilities`,
  );
  descriptor.relationships = relations;
  descriptor.lifecycle = {
    delete: required(capabilities, "delete", `${context}.capabilities`),
    merge: required(capabilities, "merge", `${context}.capabilities`),
  };
  descriptor.mcp = required(capabilities, "mcp", `${context}.capabilities`);
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

const normalizedLegacyEntity = (
  raw: LiteralObject,
  names: LiteralObject,
  presentation: LiteralObject,
  descriptor: LiteralObject,
  route: LiteralValue,
  capabilities: LiteralObject,
  extensions: LiteralObject,
  context: string,
): LiteralObject => {
  const normalized: LiteralObject = {
    key: required(raw, "key", context),
    route,
    inspector: {
      singular: required(names, "singular", `${context}.names`),
      plural: names.plural ?? null,
      titleField: required(
        presentation,
        "titleField",
        `${context}.presentation`,
      ),
    },
    descriptor,
    contract: required(raw, "fields", context),
    filters: required(raw, "filters", context),
    bulkUpdate: required(capabilities, "bulkUpdate", `${context}.capabilities`),
    operationOwners: required(
      capabilities,
      "operationOwners",
      `${context}.capabilities`,
    ),
  };
  if (extensions.ports !== undefined) {
    normalized.ports = extensions.ports;
  }
  return normalized;
};

const compiledInspector = (object: LiteralObject, context: string) => {
  const inspectorObject = objectValue(
    required(object, "inspector", context),
    `${context}.inspector`,
  );
  exactKeys(
    inspectorObject,
    ["singular", "plural", "titleField"],
    `${context}.inspector`,
  );
  return {
    singular: stringValue(
      required(inspectorObject, "singular", `${context}.inspector`),
      `${context}.inspector.singular`,
    ),
    plural:
      inspectorObject.plural === null
        ? null
        : stringValue(
            required(inspectorObject, "plural", `${context}.inspector`),
            `${context}.inspector.plural`,
          ),
    titleField: stringValue(
      required(inspectorObject, "titleField", `${context}.inspector`),
      `${context}.inspector.titleField`,
    ),
  };
};

const compiledRoute = (
  value: LiteralValue | undefined,
  context: string,
): ParsedEntityRoute | null => {
  if (value === undefined || value === null) return null;
  const route = objectValue(value, `${context}.route`);
  const parsed: ParsedEntityRoute = {
    basePath: stringValue(
      required(route, "basePath", `${context}.route`),
      `${context}.route.basePath`,
    ),
  };
  if (route.detailParam !== undefined)
    parsed.detailParam = stringValue(
      route.detailParam,
      `${context}.route.detailParam`,
    );
  return parsed;
};

const compiledShortcode = (
  descriptor: LiteralObject,
  key: "shortcodePrefix" | "legacyShortcodePrefix",
  expression: RegExp,
  label: string,
  context: string,
): string | null => {
  const value = descriptor[key];
  if (value === undefined) return null;
  const shortcode = stringValue(value, `${context}.descriptor.${key}`);
  if (!expression.test(shortcode))
    throw new LiteralSpecError(
      `${context}.descriptor.${key} must be an ${label} prefix.`,
    );
  return shortcode;
};

// One compiler pass keeps cross-field capability errors attached to the exact
// entity literal rather than losing context across partial validators.
// oxlint-disable-next-line eslint/complexity
const compileEntity = (value: LiteralValue, index: number): EntityLiteral => {
  const context = `ENTITY_LITERALS[${index}]`;
  const object = normalizedEntitySource(objectValue(value, context), context);
  exactKeys(
    object,
    [
      "key",
      "contract",
      "descriptor",
      "route",
      "filters",
      "inspector",
      "bulkUpdate",
      "operationOwners",
      "ports",
    ],
    context,
  );

  const key = stringValue(required(object, "key", context), `${context}.key`);
  if (!/^[a-z][a-zA-Z-]*$/.test(key)) {
    throw new LiteralSpecError(
      `${context}.key must be lower-camel-case or kebab-case.`,
    );
  }

  const descriptor = objectValue(
    required(object, "descriptor", context),
    `${context}.descriptor`,
  );
  descriptor.relationships ??= [];
  const operationOwnersObject = objectValue(
    required(object, "operationOwners", context),
    `${context}.operationOwners`,
  );
  exactKeys(
    operationOwnersObject,
    ["delete", "merge"],
    `${context}.operationOwners`,
  );
  const operationOwner = (operation: "delete" | "merge"): OperationOwner => {
    const value = required(
      operationOwnersObject,
      operation,
      `${context}.operationOwners`,
    );
    if (value === null || value === "kernel" || value === "workflow") {
      return value;
    }
    throw new LiteralSpecError(
      `${context}.operationOwners.${operation} must be kernel, workflow, or null.`,
    );
  };
  const operationOwners = {
    delete: operationOwner("delete"),
    merge: operationOwner("merge"),
  };
  const inspector = compiledInspector(object, context);
  const filters = objectValue(
    required(object, "filters", context),
    `${context}.filters`,
  );
  exactKeys(filters, ["audit", "schema", "descriptors"], `${context}.filters`);
  const filterAudit =
    filters.audit === undefined
      ? false
      : booleanValue(filters.audit, `${context}.filters.audit`);
  const filterSchema =
    filters.schema === undefined || filters.schema === null
      ? null
      : sourceRef(filters.schema, `${context}.filters.schema`);
  const rawFilterDescriptors = required(
    filters,
    "descriptors",
    `${context}.filters`,
  );
  if (!Array.isArray(rawFilterDescriptors)) {
    throw new LiteralSpecError(
      `${context}.filters.descriptors must be an array.`,
    );
  }
  const filterDescriptors = rawFilterDescriptors.map((value, index) =>
    filterDescriptor(value, `${context}.filters.descriptors[${index}]`),
  );
  const descriptorColumns = filterDescriptors.map(({ columnId }) => columnId);
  if (new Set(descriptorColumns).size !== descriptorColumns.length) {
    throw new LiteralSpecError(
      `${context}.filters.descriptors contains duplicate columnId values.`,
    );
  }
  if (
    filterAudit &&
    descriptorColumns.some(
      (columnId) => columnId === "createdAt" || columnId === "updatedAt",
    )
  ) {
    throw new LiteralSpecError(
      `${context}.filters.audit duplicates an explicit createdAt or updatedAt descriptor.`,
    );
  }
  if (filterAudit && descriptor.auditable !== true) {
    throw new LiteralSpecError(
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
    throw new LiteralSpecError(
      `${context}.filters.descriptors contains duplicate URL keys.`,
    );
  }
  const route = compiledRoute(object.route, context);
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

  const contractValue = required(object, "contract", context);
  const contract =
    contractValue === null
      ? null
      : (() => {
          const contractObject = objectValue(
            contractValue,
            `${context}.contract`,
          );
          exactKeys(
            contractObject,
            [
              "create",
              "update",
              "output",
              "list",
              "detail",
              "mcpOutput",
              "mcpList",
              "mcpDetail",
            ],
            `${context}.contract`,
          );
          const output = sourceRef(
            required(contractObject, "output", `${context}.contract`),
            `${context}.contract.output`,
          );
          const list =
            contractObject.list === undefined
              ? output
              : sourceRef(contractObject.list, `${context}.contract.list`);
          const detail =
            contractObject.detail === undefined
              ? output
              : sourceRef(contractObject.detail, `${context}.contract.detail`);
          return {
            create: nullableSourceRef(
              required(contractObject, "create", `${context}.contract`),
              `${context}.contract.create`,
            ),
            update: nullableSourceRef(
              required(contractObject, "update", `${context}.contract`),
              `${context}.contract.update`,
            ),
            output,
            list,
            detail,
            mcpOutput:
              contractObject.mcpOutput === undefined
                ? output
                : sourceRef(
                    contractObject.mcpOutput,
                    `${context}.contract.mcpOutput`,
                  ),
            mcpList:
              contractObject.mcpList === undefined
                ? list
                : sourceRef(
                    contractObject.mcpList,
                    `${context}.contract.mcpList`,
                  ),
            mcpDetail:
              contractObject.mcpDetail === undefined
                ? contractObject.mcpOutput === undefined
                  ? detail
                  : sourceRef(
                      contractObject.mcpOutput,
                      `${context}.contract.mcpOutput`,
                    )
                : sourceRef(
                    contractObject.mcpDetail,
                    `${context}.contract.mcpDetail`,
                  ),
          };
        })();

  if (shortcode === null && contract !== null) {
    throw new LiteralSpecError(
      `${context} cannot declare a contract without a shortcode.`,
    );
  }
  const ports = entityPorts(object.ports, `${context}.ports`);
  const relationships = literalObjectArray(
    required(descriptor, "relationships", `${context}.descriptor`),
    `${context}.descriptor.relationships`,
  );
  const relationshipKeys = relationships.map((relationship, relationIndex) =>
    stringValue(
      required(
        relationship,
        "key",
        `${context}.descriptor.relationships[${relationIndex}]`,
      ),
      `${context}.descriptor.relationships[${relationIndex}].key`,
    ),
  );
  if (new Set(relationshipKeys).size !== relationshipKeys.length) {
    throw new LiteralSpecError(
      `${context}.descriptor.relationships contains duplicate keys.`,
    );
  }
  const relationMutations = relationships.flatMap(
    (relationship, relationIndex): RelationMutation[] => {
      if (relationship.mutation === undefined) return [];
      const relationContext = `${context}.descriptor.relationships[${relationIndex}]`;
      const mutation = objectValue(
        relationship.mutation,
        `${relationContext}.mutation`,
      );
      const audiences = required(
        mutation,
        "audiences",
        `${relationContext}.mutation`,
      );
      if (!Array.isArray(audiences)) {
        throw new LiteralSpecError(
          `${relationContext}.mutation.audiences must be an array.`,
        );
      }
      return [
        {
          entity: key,
          relation: stringValue(
            required(relationship, "key", relationContext),
            `${relationContext}.key`,
          ),
          target: stringValue(
            required(relationship, "target", relationContext),
            `${relationContext}.target`,
          ),
          source: stringValue(
            required(mutation, "source", `${relationContext}.mutation`),
            `${relationContext}.mutation.source`,
          ),
          itemSchema: sourceRef(
            required(mutation, "itemSchema", `${relationContext}.mutation`),
            `${relationContext}.mutation.itemSchema`,
          ),
          adapter: sourceRef(
            required(mutation, "adapter", `${relationContext}.mutation`),
            `${relationContext}.mutation.adapter`,
          ),
          audiences: audiences.map((audience, audienceIndex) => {
            const value = stringValue(
              audience,
              `${relationContext}.mutation.audiences[${audienceIndex}]`,
            );
            if (value !== "browser" && value !== "mcp") {
              throw new LiteralSpecError(
                `${relationContext}.mutation.audiences[${audienceIndex}] is unsupported.`,
              );
            }
            return value;
          }),
        },
      ];
    },
  );
  const bulkUpdateValue = object.bulkUpdate;
  const bulkUpdateFields =
    bulkUpdateValue === undefined || bulkUpdateValue === null
      ? null
      : (() => {
          const bulkUpdate = objectValue(
            bulkUpdateValue,
            `${context}.bulkUpdate`,
          );
          const fields = required(
            bulkUpdate,
            "fields",
            `${context}.bulkUpdate`,
          );
          if (!Array.isArray(fields)) {
            throw new LiteralSpecError(
              `${context}.bulkUpdate.fields must be an array.`,
            );
          }
          return fields.map((field, index) =>
            stringValue(field, `${context}.bulkUpdate.fields[${index}]`),
          );
        })();
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
    relationMutations,
    operationOwners,
  };
};

const unwrapTypeAssertion = (node: AstNode): AstNode => {
  if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression") {
    return unwrapTypeAssertion(
      asNode(node.expression, `${node.type}.expression`),
    );
  }
  return node;
};

const isLiteralPrimitive = (
  value: AstValue | undefined,
): value is string | number | boolean | null =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

const isNonEmptyAstString = (value: AstValue | undefined): value is string =>
  typeof value === "string" && value.length > 0;

const literalFromNode = (node: AstNode, context: string): LiteralValue => {
  const expression = unwrapTypeAssertion(node);
  if (expression.type === "Literal") {
    const value = expression.value;
    if (isLiteralPrimitive(value)) {
      return value;
    }
  }

  if (expression.type === "ArrayExpression") {
    const elements = expression.elements;
    if (!Array.isArray(elements)) {
      throw new LiteralSpecError(`${context} has an invalid array.`);
    }
    return elements.map((element, index) =>
      literalFromNode(
        asNode(element, `${context}[${index}]`),
        `${context}[${index}]`,
      ),
    );
  }

  if (expression.type === "ObjectExpression") {
    const properties = expression.properties;
    if (!Array.isArray(properties)) {
      throw new LiteralSpecError(`${context} has an invalid object.`);
    }
    const result: LiteralObject = {};
    for (const propertyValue of properties) {
      const property = asNode(propertyValue, context);
      if (
        property.type !== "Property" ||
        property.kind !== "init" ||
        property.method === true ||
        property.shorthand === true ||
        property.computed === true
      ) {
        throw new LiteralSpecError(
          `${context} only permits ordinary literal properties.`,
        );
      }
      const keyNode = asNode(property.key, `${context}.key`);
      const key =
        keyNode.type === "Identifier"
          ? keyNode.name
          : keyNode.type === "Literal"
            ? keyNode.value
            : undefined;
      if (!isNonEmptyAstString(key)) {
        throw new LiteralSpecError(`${context} has an invalid property key.`);
      }
      if (key in result) {
        throw new LiteralSpecError(
          `${context}.${key} is declared more than once.`,
        );
      }
      result[key] = literalFromNode(
        asNode(property.value, `${context}.${key}`),
        `${context}.${key}`,
      );
    }
    return result;
  }

  throw new LiteralSpecError(
    `${context} must be a literal object, array, string, number, boolean, or null; found ${expression.type}.`,
  );
};

const validateEntityIdentities = (entities: readonly EntityLiteral[]) => {
  const keys = new Set<string>();
  const prefixes = new Map<string, string>();
  for (const entity of entities) {
    if (keys.has(entity.key)) {
      throw new LiteralSpecError(`Duplicate entity key ${entity.key}.`);
    }
    keys.add(entity.key);
    if (entity.shortcode !== null) {
      const owner = prefixes.get(entity.shortcode);
      if (owner !== undefined) {
        throw new LiteralSpecError(
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
      throw new LiteralSpecError(
        `Legacy shortcode prefix ${entity.legacyShortcode} for ${entity.key} conflicts with ${owner}.`,
      );
    }
    prefixes.set(entity.legacyShortcode, `${entity.key} legacy prefix`);
  }
};

export const parseEntityLiterals = (
  source: string,
  filename = SPEC_PATH,
): EntityLiteral[] => {
  const parsed = parseSync(filename, source, { lang: "ts", range: true });
  const firstError = parsed.errors.at(0);
  if (firstError !== undefined) {
    throw new LiteralSpecError(`${filename}: ${firstError.message}`);
  }

  const declarations = parsed.program.body.flatMap((statement) => {
    const node = asNode(statement, filename);
    if (node.type !== "ExportNamedDeclaration") {
      return [];
    }
    const declaration = node.declaration;
    if (!isNode(declaration) || declaration.type !== "VariableDeclaration") {
      return [];
    }
    const declarators = declaration.declarations;
    return Array.isArray(declarators) ? declarators : [];
  });
  const matching = declarations.filter((declaration) => {
    if (!isNode(declaration) || declaration.type !== "VariableDeclarator") {
      return false;
    }
    const identifier = declaration.id;
    return (
      isNode(identifier) &&
      identifier.type === "Identifier" &&
      identifier.name === "ENTITY_LITERALS"
    );
  });

  if (matching.length !== 1) {
    throw new LiteralSpecError(
      `${filename} must export exactly one const named ENTITY_LITERALS.`,
    );
  }
  const declaration = asNode(matching[0], filename);
  const initialValue = declaration.init;
  if (!isNode(initialValue)) {
    throw new LiteralSpecError(
      `${filename}: ENTITY_LITERALS must have an initializer.`,
    );
  }
  const literal = literalFromNode(initialValue, "ENTITY_LITERALS");
  if (!Array.isArray(literal)) {
    throw new LiteralSpecError("ENTITY_LITERALS must be an array.");
  }

  const entities = literal.map(compileEntity);
  if (entities.length === 0) {
    throw new LiteralSpecError("ENTITY_LITERALS must not be empty.");
  }
  validateEntityIdentities(entities);
  return entities;
};

const parseEntityLiteralFile = (
  source: string,
  filename: string,
): EntityLiteral => {
  const parsed = parseSync(filename, source, { lang: "ts", range: true });
  const firstError = parsed.errors.at(0);
  if (firstError !== undefined)
    throw new LiteralSpecError(`${filename}: ${firstError.message}`);
  const declaration = parsed.program.body.find((statement) => {
    const node = asNode(statement, filename);
    return node.type === "ExportDefaultDeclaration";
  });
  if (!declaration)
    throw new LiteralSpecError(
      `${filename} must default-export literalEntity({...}).`,
    );
  const expression = unwrapTypeAssertion(
    asNode(
      asNode(declaration, filename).declaration,
      `${filename}.declaration`,
    ),
  );
  if (expression.type !== "CallExpression")
    throw new LiteralSpecError(`${filename} must call literalEntity({...}).`);
  const callee = asNode(expression.callee, `${filename}.callee`);
  const arguments_ = expression.arguments;
  if (
    callee.type !== "Identifier" ||
    callee.name !== "literalEntity" ||
    !Array.isArray(arguments_) ||
    arguments_.length !== 1
  ) {
    throw new LiteralSpecError(
      `${filename} must default-export literalEntity({...}).`,
    );
  }
  return compileEntity(
    literalFromNode(
      asNode(arguments_[0], `${filename}.argument`),
      "literalEntity",
    ),
    0,
  );
};

export const parseEntityLiteralFiles = async (): Promise<EntityLiteral[]> => {
  const entries = (await readdir(SPEC_DIRECTORY, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".entity.ts"))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0)
    throw new LiteralSpecError(`${SPEC_DIRECTORY} has no *.entity.ts files.`);
  const entities = await Promise.all(
    entries.map(async (entry) =>
      parseEntityLiteralFile(
        await readFile(resolve(SPEC_DIRECTORY, entry.name), "utf8"),
        resolve(SPEC_DIRECTORY, entry.name),
      ),
    ),
  );
  const routes = new Set<string>();
  validateEntityIdentities(entities);
  for (const entity of entities) {
    if (entity.descriptor.browserRoutes === false) continue;
    for (const route of Object.values(browserRoutes(entity).routes)) {
      if (routes.has(route))
        throw new LiteralSpecError(`Duplicate browser route ${route}.`);
      routes.add(route);
    }
  }
  return entities;
};

const generatedHeader =
  "// Generated by `pnpm entity:generate` from `scripts/entity-literals/entities/*.entity.ts`. Do not edit.\n\n";

const compactLiteral = <T>(value: T) =>
  JSON.stringify(value).replaceAll(
    /"([A-Za-z_$][\w$]*)":/g,
    (_, key: string) => `${key}:`,
  );

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

const browserRoutes = (entity: EntityLiteral) => {
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
  entities: readonly EntityLiteral[],
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
  entities: readonly EntityLiteral[],
  exists: (path: string) => boolean = existsSync,
): readonly string[] =>
  expectedBrowserRouteFiles(entities).filter(
    (relativePath) => !exists(resolve(ROOT, relativePath)),
  );

// One render pass preserves deterministic cross-artifact ordering and hashes.
// oxlint-disable-next-line eslint/complexity
export const renderEntityArtifacts = (
  entities: readonly EntityLiteral[],
): EntityArtifacts[] => {
  const relationMutations = entities.flatMap(
    (entity) => entity.relationMutations,
  );
  const relationMutationKeys = relationMutations.map(
    ({ entity, relation }) => `${entity}:${relation}`,
  );
  if (new Set(relationMutationKeys).size !== relationMutationKeys.length) {
    throw new LiteralSpecError("Relation mutation keys must be unique.");
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
  const schemaEntitySpecs = entities.filter(
    (
      entity,
    ): entity is EntityLiteral & {
      contract: NonNullable<EntityLiteral["contract"]>;
    } => entity.contract !== null,
  );
  const schemaBindings = schemaEntitySpecs
    .map((entity) => {
      const { contract, filterSchema } = entity;
      if (entity.bulkUpdateFields !== null && contract.update === null) {
        throw new LiteralSpecError(
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
  const detailEntities = entities.filter(
    (
      entity,
    ): entity is EntityLiteral & {
      contract: NonNullable<EntityLiteral["contract"]>;
    } =>
      entity.contract !== null &&
      entity.contract.create !== null &&
      entity.contract.update !== null,
  );
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
  const detailSchemaImports = detailEntities
    .map(({ key }) => `${key}Shortcode`)
    .sort();
  const detailRuntimeImportSource = [
    ...[...detailTypeImports.entries()].map(([module, exports]) => ({
      module,
      source: `import { ${[...exports].sort().join(", ")} } from ${JSON.stringify(module)};`,
    })),
    {
      module: "@cubby/schemas/identifiers",
      source: 'import { shortcodeSchema } from "@cubby/schemas/identifiers";',
    },
    {
      module: "@cubby/shared",
      source: `import type { ${detailSchemaImports.join(", ")} } from "@cubby/shared";`,
    },
    { module: "zod", source: 'import { z } from "zod";' },
  ]
    .sort((left, right) => left.module.localeCompare(right.module))
    .map(({ source }) => source)
    .join("\n");
  const detailOutputTypes = detailEntities
    .map(
      ({ key, contract }) =>
        `  ${JSON.stringify(key)}: z.output<typeof ${contract.detail.export}>;`,
    )
    .join("\n");
  const detailInputTypes = detailEntities
    .map(
      ({ key }) =>
        `  ${JSON.stringify(key)}: { entity: ${JSON.stringify(key)}; shortcode: z.input<typeof ${key}Shortcode> };`,
    )
    .join("\n");
  const detailParsedInputTypes = detailEntities
    .map(
      ({ key }) =>
        `  ${JSON.stringify(key)}: { entity: ${JSON.stringify(key)}; shortcode: z.output<typeof ${key}Shortcode> };`,
    )
    .join("\n");
  const detailInputVariants = detailEntities
    .map(
      ({ key }) =>
        `z.object({entity:z.literal(${JSON.stringify(key)}),shortcode:shortcodeSchema(${JSON.stringify(key)})})`,
    )
    .join(",\n  ");

  const browserEntities = entities.filter(
    ({ descriptor }) => descriptor.browserRoutes !== false,
  );
  const browserCrudEntitySpecs = browserEntities.filter(
    (
      entity,
    ): entity is EntityLiteral & {
      contract: NonNullable<EntityLiteral["contract"]>;
    } =>
      entity.contract !== null &&
      entity.contract.create !== null &&
      entity.contract.update !== null,
  );
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
    .map(
      ({ key }) =>
        `const ${key}ListFiltersSchema = z.object(${key}ListFilterFields);`,
    )
    .join("\n");
  const listInputFilterTypes = browserCrudEntitySpecs
    .map(
      ({ key }) =>
        `  ${JSON.stringify(key)}: z.input<typeof ${key}ListFiltersSchema>;`,
    )
    .join("\n");
  const listParsedFilterTypes = browserCrudEntitySpecs
    .map(
      ({ key }) =>
        `  ${JSON.stringify(key)}: z.output<typeof ${key}ListFiltersSchema>;`,
    )
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
      throw new LiteralSpecError(
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
        throw new LiteralSpecError(
          "Browser CRUD entity is missing its contract.",
        );
      return `  ${JSON.stringify(key)}: z.output<typeof ${contract.output.export}>;`;
    })
    .join("\n");
  const mutationOutputSchemas = browserCrudEntitySpecs
    .map(({ key, contract }) => {
      if (!contract)
        throw new LiteralSpecError(
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
          throw new LiteralSpecError(`${entity.key}.${schema} is missing.`);
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
          throw new LiteralSpecError(`${entity.key}.output is missing.`);
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
          throw new LiteralSpecError(`${entity.key}.mcpOutput is missing.`);
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
    entitySpecs: readonly EntityLiteral[],
  ) =>
    entitySpecs
      .map((entity) => {
        const schemaRef = entity.contract?.update;
        if (!schemaRef)
          throw new LiteralSpecError(`${entity.key}.update is missing.`);
        const mask = (entity.bulkUpdateFields ?? [])
          .map((field) => `${JSON.stringify(field)}:true`)
          .join(",");
        return `z.object({action:z.literal("bulkUpdate"),entity:z.literal(${JSON.stringify(entity.key)}),ids,data:${schemaRef.export}.pick({${mask}}).strict()})`;
      })
      .join(",\n  ");
  // No declaration anywhere means the command exists but matches nothing,
  // rather than an empty `z.union([])` that fails far from its cause.
  const bulkUpdateCommandFactoryFor = (
    entitySpecs: readonly EntityLiteral[],
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
    ({ contract, key }) => contract !== null || key === "image",
  );
  const kernelEntityKeys = kernelEntities.map(({ key }) => key);
  const runtimeAdapterImports = new Map<string, Set<string>>();
  for (const entity of kernelEntities) {
    const adapter = entity.ports.repository;
    if (adapter === null) {
      throw new LiteralSpecError(
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
  const lifecycleFor = (entity: EntityLiteral) =>
    objectValue(
      required(entity.descriptor, "lifecycle", `${entity.key}.descriptor`),
      `${entity.key}.descriptor.lifecycle`,
    );
  const kernelActionsFor = (entity: EntityLiteral) => {
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
  const mcpActionsFor = (entity: EntityLiteral): string[] =>
    Array.isArray(entity.descriptor.mcp)
      ? entity.descriptor.mcp.map((action) => String(action))
      : [];
  const mcpKernelContractCases = Object.fromEntries(
    kernelEntities.map((entity) => {
      const declared = mcpActionsFor(entity);
      const executable = kernelActionsFor(entity);
      const unsupported = declared.filter(
        (action) => !executable.includes(action),
      );
      if (unsupported.length > 0) {
        throw new LiteralSpecError(
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
        throw new LiteralSpecError(`${entity.key}.merge output is missing.`);
      }
      return `z.object({action:z.literal("merge"),entity:z.literal(${JSON.stringify(entity.key)}),item:${entity.contract.output.export},mergeSummary:z.json(),sideEffects:mutationSideEffectsSchema})`;
    })
    .join(",\n  ");
  const mcpMergeResultVariants = kernelEntities
    .filter((entity) => mcpActionsFor(entity).includes("merge"))
    .map((entity) => {
      if (entity.contract === null) {
        throw new LiteralSpecError(`${entity.key}.merge output is missing.`);
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
            ...new Set(
              (entity.descriptor.relationships === undefined
                ? []
                : literalObjectArray(
                    entity.descriptor.relationships,
                    `${entity.key}.descriptor.relationships`,
                  )
              ).map((relationship) => relationship.target),
            ),
          ],
        },
      ];
    }),
  );
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
        " * `names` block in `scripts/entity-literals/entities/*.entity.ts`). It is\n" +
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
        '  label: string | null; brandRef: { entity: string; kind: "id" | "shortcode" } | null; expandRef: EntityPortSourceRef | null;\n' +
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
        "export type EntityDetailByEntity = {\n" +
        `${detailOutputTypes}\n` +
        "};\n\n" +
        "export type EntityDetailInputByEntity = {\n" +
        `${detailInputTypes}\n` +
        "};\n\n" +
        "export type ParsedEntityDetailInputByEntity = {\n" +
        `${detailParsedInputTypes}\n` +
        "};\n\n" +
        'export function entityDetailInputFor<E extends DetailEntity>(entity: E, shortcode: EntityDetailInputByEntity[E]["shortcode"]): EntityDetailInputByEntity[E];\n' +
        'export function entityDetailInputFor(entity: DetailEntity, shortcode: EntityDetailInputByEntity[DetailEntity]["shortcode"]) {\n' +
        "  return { entity, shortcode };\n" +
        "}\n\n" +
        "// One generated detail schema per entity.\n// oxfmt-ignore\n" +
        `const ENTITY_DETAIL_OUTPUT_SCHEMAS = {\n${detailSchemas}\n} as const;\n\n` +
        "// One generated detail input variant per entity.\n// oxfmt-ignore\n" +
        `export const entityDetailInputSchema = z.discriminatedUnion("entity", [\n  ${detailInputVariants}\n]);\n\n` +
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
        `export const entityListInputSchema = z.discriminatedUnion("entity", [\n  ${listInputVariants}\n]);\n\n` +
        "const ENTITY_LIST_OUTPUT_SCHEMAS = {\n" +
        `${listOutputSchemas}\n` +
        "} as const;\n\n" +
        "type EntityListInputFiltersByEntity = {\n" +
        `${listInputFilterTypes}\n` +
        "};\n" +
        "type EntityListParsedFiltersByEntity = {\n" +
        `${listParsedFilterTypes}\n` +
        "};\n" +
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
            browserEntities.map((entity) => [
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
  entities: readonly EntityLiteral[],
): EntityArtifacts[] => {
  const roster = Object.fromEntries(
    entities.map(({ key, filterUrlKeys }) => [key, filterUrlKeys]),
  );
  const filterRefs = [
    ...new Map(
      entities.flatMap(({ filterDescriptors }) =>
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
  const runtimeRoster = entities
    .map(
      ({ key, filterDescriptors }) =>
        `${JSON.stringify(key)}:[${filterDescriptors.map(runtimeDescriptor).join(",")}],`,
    )
    .join("\n");
  const filterContractCases = Object.fromEntries(
    entities.map(({ key, filterAudit, filterSchema, filterDescriptors }) => [
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
    ]),
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
  /^(?:entity-literal-.+|entity-manifest-data|entity-inspector|entity-details|entity-lists|entity-filter-catalog|entity-filter-bindings|entity-filter-fields|entity-bindings|entity-routes|entity-kernel-bindings|entity-kernel-entities|entity-runtime-ports|filter-search-fields|shortcode-registry|shortcode-tables)\.gen\.ts$/;

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
    throw new LiteralSpecError(
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

const generateEntityArtifacts = async (root = ROOT, source?: string) => {
  const entities =
    source === undefined
      ? await parseEntityLiteralFiles()
      : parseEntityLiterals(source, SPEC_PATH);
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
    throw new LiteralSpecError(
      `Unknown arguments: ${unknownArguments.join(", ")}.`,
    );
  }
  if (check) {
    const entities = await parseEntityLiteralFiles();
    const artifacts = [
      ...renderEntityArtifacts(entities),
      ...renderFilterArtifacts(entities),
    ];
    const problems = await checkSealedEntityArtifacts(ROOT, artifacts);
    if (problems.length > 0) {
      throw new LiteralSpecError(
        `Generated entity artifacts are out of date:\n${problems.join("\n")}`,
      );
    }
    const missingRoutes = missingBrowserRouteFiles(entities);
    if (missingRoutes.length > 0) {
      throw new LiteralSpecError(
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
