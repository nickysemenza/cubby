import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_DIRECTORY = resolve(
  ROOT,
  "scripts/entity-literals/entities",
);
const SPEC_PATH = SPEC_DIRECTORY;

type AstNode = { type: string; [key: string]: unknown };
type LiteralValue = string | number | boolean | null | LiteralObject | LiteralValue[];
interface LiteralObject {
  [key: string]: LiteralValue;
}

type SourceRef = Readonly<{ module: string; export: string }>;
type IdentifierRef = Readonly<{
  entity: string;
  kind: "id" | "shortcode";
}>;
type FilterDescriptor = Readonly<{
  columnId: string;
  field: string | null;
  urlKey: string;
  kind: "text" | "select" | "multiselect" | "presence" | "boolean" | "id" | "idMulti" | "range";
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
  lifecycle: Readonly<{ policy: SourceRef | null; runtime: SourceRef | null }>;
  relationMutation: Readonly<{ attach: SourceRef | null; detach: SourceRef | null }>;
}>;
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
  contract:
    | Readonly<{
        create: SourceRef;
        update: SourceRef;
        output: SourceRef;
        list: SourceRef;
        detail: SourceRef;
      }>
    | null;
  route: Readonly<{ basePath: string; detailParam?: string }> | null;
  filterAudit: boolean;
  filterUrlKeys: readonly string[];
  filterSchema: SourceRef | null;
  filterDescriptors: readonly FilterDescriptor[];
  ports: EntityPorts;
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

const isNode = (value: unknown): value is AstNode =>
  typeof value === "object" && value !== null && "type" in value;

const asNode = (value: unknown, context: string): AstNode => {
  if (!isNode(value)) {
    throw new LiteralSpecError(`${context} must be syntax.`);
  }
  return value;
};

const objectValue = (value: LiteralValue, context: string): LiteralObject => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
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
  if (typeof value !== "string" || value.length === 0) {
    throw new LiteralSpecError(`${context} must be a non-empty string.`);
  }
  return value;
};

const booleanValue = (value: LiteralValue, context: string): boolean => {
  if (typeof value !== "boolean") {
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

const sourceRef = (value: LiteralValue, context: string): SourceRef => {
  const object = objectValue(value, context);
  exactKeys(object, ["module", "export"], context);
  return {
    module: stringValue(required(object, "module", context), `${context}.module`),
    export: stringValue(required(object, "export", context), `${context}.export`),
  };
};

const identifierRef = (value: LiteralValue, context: string): IdentifierRef => {
  const object = objectValue(value, context);
  exactKeys(object, ["entity", "kind"], context);
  const kind = stringValue(required(object, "kind", context), `${context}.kind`);
  if (kind !== "id" && kind !== "shortcode") {
    throw new LiteralSpecError(`${context}.kind must be id or shortcode.`);
  }
  return {
    entity: stringValue(required(object, "entity", context), `${context}.entity`),
    kind,
  };
};

const nullableSourceRef = (value: LiteralValue, context: string): SourceRef | null =>
  value === null ? null : sourceRef(value, context);

const entityPorts = (value: LiteralValue | undefined, context: string): EntityPorts => {
  if (value === undefined) {
    return {
      repository: null,
      references: { label: null, resolver: null },
      filters: null,
      search: { projection: null, semanticText: null, dependentRefresh: null },
      lifecycle: { policy: null, runtime: null },
      relationMutation: { attach: null, detach: null },
    };
  }
  const ports = objectValue(value, context);
  exactKeys(
    ports,
    ["repository", "references", "filters", "search", "lifecycle", "relationMutation"],
    context,
  );
  const references = objectValue(required(ports, "references", context), `${context}.references`);
  exactKeys(references, ["label", "resolver"], `${context}.references`);
  const search = objectValue(required(ports, "search", context), `${context}.search`);
  exactKeys(search, ["projection", "semanticText", "dependentRefresh"], `${context}.search`);
  const lifecycle = objectValue(required(ports, "lifecycle", context), `${context}.lifecycle`);
  exactKeys(lifecycle, ["policy", "runtime"], `${context}.lifecycle`);
  const relationMutation = objectValue(
    required(ports, "relationMutation", context),
    `${context}.relationMutation`,
  );
  exactKeys(relationMutation, ["attach", "detach"], `${context}.relationMutation`);
  return {
    repository: nullableSourceRef(required(ports, "repository", context), `${context}.repository`),
    references: {
      label: nullableSourceRef(required(references, "label", `${context}.references`), `${context}.references.label`),
      resolver: nullableSourceRef(required(references, "resolver", `${context}.references`), `${context}.references.resolver`),
    },
    filters: nullableSourceRef(required(ports, "filters", context), `${context}.filters`),
    search: {
      projection: nullableSourceRef(required(search, "projection", `${context}.search`), `${context}.search.projection`),
      semanticText: nullableSourceRef(required(search, "semanticText", `${context}.search`), `${context}.search.semanticText`),
      dependentRefresh: nullableSourceRef(required(search, "dependentRefresh", `${context}.search`), `${context}.search.dependentRefresh`),
    },
    lifecycle: {
      policy: nullableSourceRef(required(lifecycle, "policy", `${context}.lifecycle`), `${context}.lifecycle.policy`),
      runtime: nullableSourceRef(required(lifecycle, "runtime", `${context}.lifecycle`), `${context}.lifecycle.runtime`),
    },
    relationMutation: {
      attach: nullableSourceRef(required(relationMutation, "attach", `${context}.relationMutation`), `${context}.relationMutation.attach`),
      detach: nullableSourceRef(required(relationMutation, "detach", `${context}.relationMutation`), `${context}.relationMutation.detach`),
    },
  };
};

const policies = ["restrict", "cascade", "setNull", "detach"] as const;
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
  const columnId = stringValue(required(object, "columnId", context), `${context}.columnId`);
  const kind = stringValue(required(object, "kind", context), `${context}.kind`);
  if (!(filterKinds as readonly string[]).includes(kind)) {
    throw new LiteralSpecError(`${context}.kind is unsupported.`);
  }
  const rawOptions = object.options;
  if (rawOptions !== undefined && rawOptions !== null && !Array.isArray(rawOptions)) {
    throw new LiteralSpecError(`${context}.options must be an array.`);
  }
  const options =
    rawOptions === undefined || rawOptions === null
      ? null
      : rawOptions.map((option, index) => {
          const optionContext = `${context}.options[${index}]`;
          const parsed = objectValue(option, optionContext);
          exactKeys(parsed, ["value", "label", "meta", "color"], optionContext);
          stringValue(required(parsed, "value", optionContext), `${optionContext}.value`);
          stringValue(required(parsed, "label", optionContext), `${optionContext}.label`);
          if (parsed.meta !== undefined) booleanValue(parsed.meta, `${optionContext}.meta`);
          if (parsed.color !== undefined) stringValue(parsed.color, `${optionContext}.color`);
          return parsed;
        });
  const optionsRef =
    object.optionsRef === undefined || object.optionsRef === null
      ? null
      : sourceRef(object.optionsRef, `${context}.optionsRef`);
  if (options !== null && optionsRef !== null) {
    throw new LiteralSpecError(`${context} cannot declare both options and optionsRef.`);
  }
  const nullable =
    object.nullable === undefined || object.nullable === null
      ? null
      : (() => {
          const nullableContext = `${context}.nullable`;
          const parsed = objectValue(object.nullable, nullableContext);
          exactKeys(parsed, ["field", "label"], nullableContext);
          return {
            field: stringValue(required(parsed, "field", nullableContext), `${nullableContext}.field`),
            label: stringValue(required(parsed, "label", nullableContext), `${nullableContext}.label`),
          };
        })();
  return {
    columnId,
    field: optionalString(object, "field", context),
    urlKey: optionalString(object, "urlKey", context) ?? columnId,
    kind: kind as FilterDescriptor["kind"],
    placeholder: stringValue(required(object, "placeholder", context), `${context}.placeholder`),
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

const legacyShape = (raw: LiteralObject, context: string): LiteralObject => {
  if (raw.descriptor !== undefined) {
    return {
      filters: { audit: false, descriptors: [] },
      inspector: {
        singular: required(raw, "key", context),
        plural: null,
        titleField: "name",
      },
      ...raw,
    };
  }
  exactKeys(raw, ["key", "names", "route", "table", "identifiers", "presentation", "fields", "filters", "relations", "search", "capabilities", "extensions"], context);
  const names = objectValue(required(raw, "names", context), `${context}.names`);
  exactKeys(names, ["singular", "plural"], `${context}.names`);
  const identifiers = objectValue(required(raw, "identifiers", context), `${context}.identifiers`);
  exactKeys(identifiers, ["brand", "shortcode", "legacy"], `${context}.identifiers`);
  const presentation = objectValue(required(raw, "presentation", context), `${context}.presentation`);
  exactKeys(presentation, ["titleField"], `${context}.presentation`);
  const search = objectValue(required(raw, "search", context), `${context}.search`);
  exactKeys(search, ["enabled"], `${context}.search`);
  const capabilities = objectValue(required(raw, "capabilities", context), `${context}.capabilities`);
  exactKeys(capabilities, ["auditable", "images", "countable", "softDelete", "delete", "merge", "mcp"], `${context}.capabilities`);
  const extensions = objectValue(required(raw, "extensions", context), `${context}.extensions`);
  exactKeys(extensions, ["countFilter", "relatednessSignals", "mcpNames", "ports"], `${context}.extensions`);
  const deleteCapability = required(capabilities, "delete", `${context}.capabilities`);
  if (deleteCapability !== null) {
    const deletion = objectValue(deleteCapability, `${context}.capabilities.delete`);
    exactKeys(deletion, ["mode", "bulk"], `${context}.capabilities.delete`);
    const mode = stringValue(required(deletion, "mode", `${context}.capabilities.delete`), `${context}.capabilities.delete.mode`);
    if (mode !== "soft" && mode !== "hard") throw new LiteralSpecError(`${context}.capabilities.delete.mode is invalid.`);
    booleanValue(required(deletion, "bulk", `${context}.capabilities.delete`), `${context}.capabilities.delete.bulk`);
  }
  booleanValue(required(capabilities, "merge", `${context}.capabilities`), `${context}.capabilities.merge`);
  const mcpActions = required(capabilities, "mcp", `${context}.capabilities`);
  if (!Array.isArray(mcpActions)) throw new LiteralSpecError(`${context}.capabilities.mcp must be an array.`);
  const supportedMcpActions = ["get", "list", "create", "update", "delete"];
  for (const [index, action] of mcpActions.entries()) {
    const name = stringValue(action, `${context}.capabilities.mcp[${index}]`);
    if (!supportedMcpActions.includes(name)) throw new LiteralSpecError(`${context}.capabilities.mcp[${index}] is unsupported.`);
  }
  const relations = required(raw, "relations", context);
  if (!Array.isArray(relations)) throw new LiteralSpecError(`${context}.relations must be an array.`);
  for (const [index, value] of relations.entries()) {
    const relation = objectValue(value, `${context}.relations[${index}]`);
    exactKeys(relation, ["key", "label", "target", "provenance", "deletionPolicy", "inverse"], `${context}.relations[${index}]`);
    const provenance = objectValue(required(relation, "provenance", `${context}.relations[${index}]`), `${context}.relations[${index}].provenance`);
    const policy =
      relation.deletionPolicy === undefined
        ? "restrict"
        : stringValue(
            relation.deletionPolicy,
            `${context}.relations[${index}].deletionPolicy`,
          );
    if (!(policies as readonly string[]).includes(policy)) throw new LiteralSpecError(`${context}.relations[${index}].deletionPolicy is invalid.`);
    relation.deletionPolicy = policy;
    if (provenance.kind === "local-path" && relation.inverse === undefined) throw new LiteralSpecError(`${context}.relations[${index}] local-path requires inverse.`);
  }
  const route = required(raw, "route", context);
  if (route !== null) {
    exactKeys(objectValue(route, `${context}.route`), ["basePath", "detailParam"], `${context}.route`);
  }
  return {
    key: required(raw, "key", context),
    route,
    inspector: {
      singular: required(names, "singular", `${context}.names`),
      plural: names.plural ?? null,
      titleField: required(presentation, "titleField", `${context}.presentation`),
    },
    descriptor: {
      dbTable: required(raw, "table", context), idBrand: required(identifiers, "brand", `${context}.identifiers`),
      ...(identifiers.shortcode === null ? {} : { shortcodePrefix: identifiers.shortcode }),
      ...(identifiers.legacy === null ? {} : { legacyShortcodePrefix: identifiers.legacy }),
      softDelete: required(capabilities, "softDelete", `${context}.capabilities`),
      ...(route === null ? { browserRoutes: false } : {}),
      auditable: required(capabilities, "auditable", `${context}.capabilities`), hasImages: required(capabilities, "images", `${context}.capabilities`),
      searchable: required(search, "enabled", `${context}.search`), countable: required(capabilities, "countable", `${context}.capabilities`), relationships: relations,
      lifecycle: { delete: required(capabilities, "delete", `${context}.capabilities`), merge: required(capabilities, "merge", `${context}.capabilities`) },
      mcp: required(capabilities, "mcp", `${context}.capabilities`),
      ...(extensions.countFilter === null ? {} : { countFilter: extensions.countFilter }),
      ...(extensions.mcpNames === null ? {} : { mcpNames: extensions.mcpNames }),
      ...(extensions.relatednessSignals === null ? {} : { relatednessSignals: extensions.relatednessSignals }),
    },
    contract: required(raw, "fields", context),
    filters: required(raw, "filters", context),
    ...(extensions.ports === undefined ? {} : { ports: extensions.ports }),
  };
};

const compileEntity = (value: LiteralValue, index: number): EntityLiteral => {
  const context = `ENTITY_LITERALS[${index}]`;
  const object = legacyShape(objectValue(value, context), context);
  exactKeys(
    object,
    ["key", "contract", "descriptor", "route", "filters", "inspector", "ports"],
    context,
  );

  const key = stringValue(required(object, "key", context), `${context}.key`);
  if (!/^[a-z][a-zA-Z-]*$/.test(key)) {
    throw new LiteralSpecError(`${context}.key must be lower-camel-case or kebab-case.`);
  }

  const descriptor = objectValue(required(object, "descriptor", context), `${context}.descriptor`);
  const inspectorObject = objectValue(
    required(object, "inspector", context),
    `${context}.inspector`,
  );
  exactKeys(
    inspectorObject,
    ["singular", "plural", "titleField"],
    `${context}.inspector`,
  );
  const inspector = {
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
  const filters = objectValue(required(object, "filters", context), `${context}.filters`);
  exactKeys(filters, ["audit", "schema", "descriptors"], `${context}.filters`);
  const filterAudit =
    filters.audit === undefined
      ? false
      : booleanValue(filters.audit, `${context}.filters.audit`);
  const filterSchema =
    filters.schema === undefined || filters.schema === null
      ? null
      : sourceRef(filters.schema, `${context}.filters.schema`);
  const rawFilterDescriptors = required(filters, "descriptors", `${context}.filters`);
  if (!Array.isArray(rawFilterDescriptors)) {
    throw new LiteralSpecError(`${context}.filters.descriptors must be an array.`);
  }
  const filterDescriptors = rawFilterDescriptors.map((value, index) =>
    filterDescriptor(value, `${context}.filters.descriptors[${index}]`),
  );
  const descriptorColumns = filterDescriptors.map(({ columnId }) => columnId);
  if (new Set(descriptorColumns).size !== descriptorColumns.length) {
    throw new LiteralSpecError(`${context}.filters.descriptors contains duplicate columnId values.`);
  }
  if (filterAudit && descriptorColumns.some((columnId) =>
    columnId === "createdAt" || columnId === "updatedAt"
  )) {
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
  const filterDescriptorsWithAudit = [...filterDescriptors, ...auditDescriptors];
  const descriptorUrlKeys = filterDescriptorsWithAudit.map(({ urlKey }) => urlKey);
  const filterUrlKeys = descriptorUrlKeys;
  if (new Set(descriptorUrlKeys).size !== descriptorUrlKeys.length) {
    throw new LiteralSpecError(`${context}.filters.descriptors contains duplicate URL keys.`);
  }
  const routeValue = object.route;
  const route = routeValue === undefined || routeValue === null ? null : (() => {
    const value = objectValue(routeValue, `${context}.route`);
    return { basePath: stringValue(required(value, "basePath", `${context}.route`), `${context}.route.basePath`), ...(value.detailParam === undefined ? {} : { detailParam: stringValue(value.detailParam, `${context}.route.detailParam`) }) };
  })();
  const shortcodeValue = descriptor.shortcodePrefix;
  const shortcode = shortcodeValue === undefined ? null : stringValue(shortcodeValue, `${context}.descriptor.shortcodePrefix`);
  if (shortcode !== null && !/^[A-Z]{3}-$/.test(shortcode)) {
    throw new LiteralSpecError(`${context}.descriptor.shortcodePrefix must be an XXX- prefix.`);
  }
  const legacyShortcodeValue = descriptor.legacyShortcodePrefix;
  const legacyShortcode =
    legacyShortcodeValue === undefined
      ? null
      : stringValue(
          legacyShortcodeValue,
          `${context}.descriptor.legacyShortcodePrefix`,
        );
  if (legacyShortcode !== null && !/^[A-Z]-$/.test(legacyShortcode)) {
    throw new LiteralSpecError(
      `${context}.descriptor.legacyShortcodePrefix must be an X- prefix.`,
    );
  }
  booleanValue(required(descriptor, "auditable", `${context}.descriptor`), `${context}.descriptor.auditable`);
  if (descriptor.browserRoutes !== undefined) booleanValue(descriptor.browserRoutes, `${context}.descriptor.browserRoutes`);
  booleanValue(required(descriptor, "searchable", `${context}.descriptor`), `${context}.descriptor.searchable`);

  const contractValue = required(object, "contract", context);
  const contract =
    contractValue === null
      ? null
      : (() => {
          const contractObject = objectValue(contractValue, `${context}.contract`);
          exactKeys(
            contractObject,
            ["create", "update", "output", "list", "detail"],
            `${context}.contract`,
          );
          const output = sourceRef(
            required(contractObject, "output", `${context}.contract`),
            `${context}.contract.output`,
          );
          return {
            create: sourceRef(
              required(contractObject, "create", `${context}.contract`),
              `${context}.contract.create`,
            ),
            update: sourceRef(
              required(contractObject, "update", `${context}.contract`),
              `${context}.contract.update`,
            ),
            output,
            list:
              contractObject.list === undefined
                ? output
                : sourceRef(contractObject.list, `${context}.contract.list`),
            detail:
              contractObject.detail === undefined
                ? output
                : sourceRef(
                    contractObject.detail,
                    `${context}.contract.detail`,
                  ),
          };
        })();

  if (shortcode === null && contract !== null) {
    throw new LiteralSpecError(`${context} cannot declare a contract without a shortcode.`);
  }
  const ports = entityPorts(object.ports, `${context}.ports`);
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
    ports,
  };
};

const unwrapTypeAssertion = (node: AstNode): AstNode => {
  if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression") {
    return unwrapTypeAssertion(asNode(node.expression, `${node.type}.expression`));
  }
  return node;
};

const literalFromNode = (node: AstNode, context: string): LiteralValue => {
  const expression = unwrapTypeAssertion(node);
  if (expression.type === "Literal") {
    const value = expression.value;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      return value;
    }
  }

  if (expression.type === "ArrayExpression") {
    const elements = expression.elements;
    if (!Array.isArray(elements)) {
      throw new LiteralSpecError(`${context} has an invalid array.`);
    }
    return elements.map((element, index) =>
      literalFromNode(asNode(element, `${context}[${index}]`), `${context}[${index}]`),
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
        throw new LiteralSpecError(`${context} only permits ordinary literal properties.`);
      }
      const keyNode = asNode(property.key, `${context}.key`);
      const key =
        keyNode.type === "Identifier"
          ? keyNode.name
          : keyNode.type === "Literal"
            ? keyNode.value
            : undefined;
      if (typeof key !== "string" || key.length === 0) {
        throw new LiteralSpecError(`${context} has an invalid property key.`);
      }
      if (key in result) {
        throw new LiteralSpecError(`${context}.${key} is declared more than once.`);
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

export const parseEntityLiterals = (source: string, filename = SPEC_PATH): EntityLiteral[] => {
  const parsed = parseSync(filename, source, { lang: "ts", range: true });
  const firstError = parsed.errors.at(0);
  if (firstError !== undefined) {
    throw new LiteralSpecError(`${filename}: ${firstError.message}`);
  }

  const declarations = (parsed.program.body as unknown[]).flatMap((statement) => {
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
    return isNode(identifier) && identifier.type === "Identifier" && identifier.name === "ENTITY_LITERALS";
  });

  if (matching.length !== 1) {
    throw new LiteralSpecError(
      `${filename} must export exactly one const named ENTITY_LITERALS.`,
    );
  }
  const declaration = asNode(matching[0], filename);
  const initialValue = declaration.init;
  if (!isNode(initialValue)) {
    throw new LiteralSpecError(`${filename}: ENTITY_LITERALS must have an initializer.`);
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

const parseEntityLiteralFile = (source: string, filename: string): EntityLiteral => {
  const parsed = parseSync(filename, source, { lang: "ts", range: true });
  const firstError = parsed.errors.at(0);
  if (firstError !== undefined) throw new LiteralSpecError(`${filename}: ${firstError.message}`);
  const declaration = (parsed.program.body as unknown[]).find((statement) => {
    const node = asNode(statement, filename);
    return node.type === "ExportDefaultDeclaration";
  });
  if (!declaration) throw new LiteralSpecError(`${filename} must default-export literalEntity({...}).`);
  const expression = unwrapTypeAssertion(asNode(declaration, filename).declaration as AstNode);
  if (expression.type !== "CallExpression") throw new LiteralSpecError(`${filename} must call literalEntity({...}).`);
  const callee = asNode(expression.callee, `${filename}.callee`);
  const arguments_ = expression.arguments;
  if (
    callee.type !== "Identifier" ||
    callee.name !== "literalEntity" ||
    !Array.isArray(arguments_) ||
    arguments_.length !== 1
  ) {
    throw new LiteralSpecError(`${filename} must default-export literalEntity({...}).`);
  }
  return compileEntity(
    literalFromNode(asNode(arguments_[0], `${filename}.argument`), "literalEntity"),
    0,
  );
};

export const parseEntityLiteralFiles = async (): Promise<EntityLiteral[]> => {
  const entries = (await readdir(SPEC_DIRECTORY, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".entity.ts"))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0) throw new LiteralSpecError(`${SPEC_DIRECTORY} has no *.entity.ts files.`);
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
      if (routes.has(route)) throw new LiteralSpecError(`Duplicate browser route ${route}.`);
      routes.add(route);
    }
  }
  return entities;
};

const generatedHeader =
  "// Generated by `pnpm entity:generate` from `scripts/entity-literals/entities/*.entity.ts`. Do not edit.\n\n";

const literal = (value: unknown, depth = 0): string => {
  const indent = "  ".repeat(depth);
  const nestedIndent = "  ".repeat(depth + 1);
  if (Array.isArray(value)) {
    return value.length === 0
      ? "[]"
      : `[\n${value.map((item) => `${nestedIndent}${literal(item, depth + 1)}`).join(",\n")}\n${indent}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    return entries.length === 0
      ? "{}"
      : `{\n${entries
          .map(([key, item]) => {
            const property = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
            return `${nestedIndent}${property}: ${literal(item, depth + 1)}`;
          })
          .join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
};

const compactLiteral = (value: unknown) =>
  JSON.stringify(value).replaceAll(
    /"([A-Za-z_$][\w$]*)":/g,
    (_, key: string) => `${key}:`,
  );

const browserRouteExtension: Readonly<
  Partial<Record<string, Readonly<{ basePath: string; detailParam?: string }>>>
> = {
  inventory: { basePath: "inventory" },
  "usda-food": { basePath: "usda", detailParam: "id" },
};

const browserBasePath = (entity: string): string =>
  browserRouteExtension[entity]?.basePath ??
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
  const detailParam = entity.route?.detailParam ?? browserRouteExtension[entity.key]?.detailParam ?? "shortcode";
  return {
    basePath,
    routes: { detail: `/${basePath}/$${detailParam}`, list: `/${basePath}` },
  };
};

export const renderEntityArtifacts = (entities: readonly EntityLiteral[]): EntityArtifacts[] => {
  const imports = new Map<string, Set<string>>();
  for (const { contract } of entities) {
    if (contract === null) continue;
    for (const ref of [contract.create, contract.update, contract.output]) {
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
  const bindings = entities
    .filter((entity) => entity.shortcode !== null)
    .map((entity) => {
      if (entity.contract === null) return `  ${JSON.stringify(entity.key)}: { crud: null },`;
      const { create, update, output } = entity.contract;
      return `  ${JSON.stringify(entity.key)}: {crud:crud(${JSON.stringify(entity.key)},{createInput:${create.export},updateInput:${update.export},output:${output.export}})},`;
    })
    .join("\n");
  const detailEntities = entities.filter(
    (entity): entity is EntityLiteral & { contract: NonNullable<EntityLiteral["contract"]> } =>
      entity.contract !== null,
  );
  const detailSchemas = detailEntities
    .map(
      ({ key, contract }) =>
        `  ${JSON.stringify(key)}: ${contract.detail.export},`,
    )
    .join("\n");
  const detailTypeImports = new Map<string, Set<string>>();
  for (const { contract } of detailEntities) {
    const exports = detailTypeImports.get(contract.detail.module) ?? new Set<string>();
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
    (entity): entity is EntityLiteral & {
      contract: NonNullable<EntityLiteral["contract"]>;
    } => entity.contract !== null,
  );
  const browserCrudEntities = browserCrudEntitySpecs.map(({ key }) => key);
  const listRuntimeOutputImports = browserCrudEntitySpecs
    .map(({ key, contract }) =>
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
        `z.object({entity:z.literal(${JSON.stringify(key)}),filters:${filterSchema === null ? 'z.record(z.string(),z.unknown())' : `${key}ListFiltersSchema`},sort:entityListSortsSchema.optional(),pagination:entityListPaginationSchema.optional(),groupBy:z.string().min(1).optional()})`,
    )
    .join(",\n  ");
  const listFilterSchemas = browserCrudEntitySpecs
    .map(({ key }) => `const ${key}ListFiltersSchema = z.object(${key}ListFilterFields);`)
    .join("\n");
  const listFilterTypes = browserCrudEntitySpecs
    .map(
      ({ key }) =>
        `  ${JSON.stringify(key)}: z.input<typeof ${key}ListFiltersSchema>;`,
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
      throw new LiteralSpecError("Browser CRUD entity is missing its contract.");
    const exports = mutationOutputImportEntries.get(contract.output.module) ?? new Set<string>();
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
      if (!contract) throw new LiteralSpecError("Browser CRUD entity is missing its contract.");
      return `  ${JSON.stringify(key)}: z.output<typeof ${contract.output.export}>;`;
    })
    .join("\n");
  const mutationOutputSchemas = browserCrudEntitySpecs
    .map(({ key, contract }) => {
      if (!contract) throw new LiteralSpecError("Browser CRUD entity is missing its contract.");
      return `  ${JSON.stringify(key)}: ${contract.output.export},`;
    })
    .join("\n");
  const commandVariants = (
    action: "create" | "update",
    schema: "create" | "update",
  ) =>
    entities
      .filter((entity) => entity.contract !== null)
      .map((entity) => {
        const schemaRef = entity.contract?.[schema];
        if (!schemaRef) throw new LiteralSpecError(`${entity.key}.${schema} is missing.`);
        const id =
          action === "update"
            ? ",id:shortcodeSchema(" + JSON.stringify(entity.key) + ")"
            : "";
        return `z.object({action:z.literal(${JSON.stringify(action)}),entity:z.literal(${JSON.stringify(entity.key)})${id},data:${schemaRef.export}})`;
      })
      .join(",\n  ");
  const mutationResultVariants = (action: "create" | "update") =>
    entities
      .filter((entity) => entity.contract !== null)
      .map((entity) => {
        const output = entity.contract?.output;
        if (!output) throw new LiteralSpecError(`${entity.key}.output is missing.`);
        return `z.object({action:z.literal(${JSON.stringify(action)}),entity:z.literal(${JSON.stringify(entity.key)}),item:${output.export},sideEffects:mutationSideEffectsSchema})`;
      })
      .join(",\n  ");
  const kernelEntities = entities
    .filter(({ contract, key }) => contract !== null || key === "image");
  const kernelEntityKeys = kernelEntities.map(({ key }) => key);
  const runtimeAdapterImports = new Map<string, Set<string>>();
  for (const entity of kernelEntities) {
    const adapter = entity.ports.repository;
    if (adapter === null) {
      throw new LiteralSpecError(
        `${entity.key}.ports.repository is required for a kernel entity.`,
      );
    }
    const exports = runtimeAdapterImports.get(adapter.module) ?? new Set<string>();
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
    .map(({ key, ports }) => `  ${JSON.stringify(key)}: ${ports.repository?.export},`)
    .join("\n");
  const filterFieldImports = new Map<string, Set<string>>();
  for (const { filterSchema } of entities) {
    if (filterSchema === null) continue;
    const exports = filterFieldImports.get(filterSchema.module) ?? new Set<string>();
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
      ...(entity.contract === null ? [] : ["create"]),
      "update",
      ...(lifecycle.delete === null ? [] : ["delete"]),
      ...(lifecycle.merge === true ? ["merge"] : []),
    ];
  };
  const kernelContractCases = Object.fromEntries(
    kernelEntities.map((entity) => {
      return [
        entity.key,
        { actions: kernelActionsFor(entity), filterUrlKeys: entity.filterUrlKeys },
      ];
    }),
  );
  const entitiesForAction = (action: string) =>
    Object.entries(kernelContractCases)
      .filter(([, contractCase]) => contractCase.actions.includes(action))
      .map(([key]) => key);
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
      const sourceRefs =
        entity.contract === null
          ? null
          : Object.fromEntries(
              Object.entries(entity.contract).map(([operation, ref]) => [
                operation,
                `${ref.module}#${ref.export}`,
              ]),
            );
      return [entity.key, {
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
        lifecycle: {
          softDelete: entity.descriptor.softDelete === true,
          delete: lifecycle.delete,
          merge: lifecycle.merge === true,
        },
        sourceRefs,
        ports: entity.ports,
        references: [
          ...new Set(
            ((entity.descriptor.relationships ?? []) as LiteralObject[]).map(
              (relationship) => relationship.target,
            ),
          ),
        ],
      }];
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
          ports.lifecycle.policy,
          ports.lifecycle.runtime,
          ports.relationMutation.attach,
          ports.relationMutation.detach,
          ...entity.filterDescriptors.flatMap((descriptor) => [
            descriptor.optionsRef,
            descriptor.expandRef,
          ]),
        ].filter((ref): ref is SourceRef => ref !== null);
        return refs.map((ref) => [`${ref.module}#${ref.export}`, ref] as const);
      }),
    ).values(),
  ].sort((left, right) =>
    `${left.module}#${left.export}`.localeCompare(`${right.module}#${right.export}`),
  );
  const portTypeModuleAliases = new Map(
    [...new Set(portExportChecks.map((ref) => ref.module))]
      .sort((left, right) => left.localeCompare(right))
      .map((module, index) => [module, `entityPortModule${index}`]),
  );
  const portTypeImports = [...portTypeModuleAliases.entries()]
    .map(([module, alias]) => `import type * as ${alias} from ${JSON.stringify(module)};`)
    .join("\n");
  return [
    {
      relativePath: "packages/shared/src/generated/shortcode-registry.gen.ts",
      source:
        generatedHeader +
        "// biome-ignore format: generated shortcode registry stays one entity per line.\n" +
        `export const SHORTCODE_PREFIX = ${compactLiteral(shortcodePrefixes)} as const;\n` +
        "export type ShortcodeType = keyof typeof SHORTCODE_PREFIX;\n\n" +
        "/** Inbound-only aliases; canonical generation never emits these prefixes. */\n" +
        "// biome-ignore format: generated legacy aliases stay compact.\n" +
        `export const LEGACY_SHORTCODE_PREFIX = ${compactLiteral(legacyShortcodePrefixes)} as const satisfies Record<string, ShortcodeType>;\n`,
    },
    {
      relativePath: "packages/schemas/src/generated/entity-manifest-data.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "../entity";\n' +
        'import type { EntityDescriptor } from "../entity-manifest";\n\n' +
        "// biome-ignore format: generated data stays one entity per line.\n" +
        `export const generatedEntityManifest = ${compactLiteral(
          Object.fromEntries(entities.map(({ key, descriptor }) => [key, descriptor])),
        )} as const satisfies Record<Entity, EntityDescriptor>;\n`,
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
        '  kernelActions: readonly ("get" | "list" | "search" | "create" | "update" | "delete" | "merge")[];\n' +
        "  filterUrlKeys: readonly string[];\n" +
        "  filterDescriptors: readonly EntityFilterDescriptorMetadata[];\n" +
        '  mcpOperations: readonly ("get" | "list" | "create" | "update" | "delete")[];\n' +
        '  lifecycle: { softDelete: boolean; delete: { mode: "soft" | "hard"; bulk: boolean } | null; merge: boolean };\n' +
        "  sourceRefs: { create: string; update: string; output: string; list: string; detail: string } | null;\n" +
        "  ports: EntityPortSourceRoster;\n" +
        "  references: readonly Entity[];\n" +
        "};\n\n" +
        "type EntityPortSourceRef = { module: string; export: string };\n" +
        "type EntityFilterDescriptorMetadata = {\n" +
        "  columnId: string; field: string | null; urlKey: string; kind: string; placeholder: string;\n" +
        "  options: readonly Record<string, unknown>[] | null; optionsRef: EntityPortSourceRef | null; optionsKey: string | null;\n" +
        '  label: string | null; brandRef: { entity: string; kind: "id" | "shortcode" } | null; expandRef: EntityPortSourceRef | null;\n' +
        "  urlOnly: boolean; nullable: { field: string; label: string } | null;\n" +
        "};\n" +
        "type EntityPortSourceRoster = {\n" +
        "  repository: EntityPortSourceRef | null;\n" +
        "  references: { label: EntityPortSourceRef | null; resolver: EntityPortSourceRef | null };\n" +
        "  filters: EntityPortSourceRef | null;\n" +
        "  search: { projection: EntityPortSourceRef | null; semanticText: EntityPortSourceRef | null; dependentRefresh: EntityPortSourceRef | null };\n" +
        "  lifecycle: { policy: EntityPortSourceRef | null; runtime: EntityPortSourceRef | null };\n" +
        "  relationMutation: { attach: EntityPortSourceRef | null; detach: EntityPortSourceRef | null };\n" +
        "};\n\n" +
        "// biome-ignore format: generated inspector metadata stays one entity per line.\n" +
        `export const entityInspectorMetadata = ${compactLiteral(inspectorMetadata)} as const satisfies Record<Entity, EntityInspectorMetadata>;\n`,
    },
    {
      relativePath: "apps/web/src/entities/generated/entity-details.gen.ts",
      source:
        generatedHeader +
        `${detailRuntimeImportSource}\n\n` +
        `const detailEntities = ${compactLiteral(detailEntities.map(({ key }) => key))} as const;\n` +
        "export type DetailEntity = (typeof detailEntities)[number];\n\n" +
        "export type EntityDetailByEntity = {\n" +
        `${detailOutputTypes}\n` +
        "};\n\n" +
        "export type EntityDetailInputByEntity = {\n" +
        `${detailInputTypes}\n` +
        "};\n\n" +
        "// biome-ignore format: one generated detail schema per entity.\n" +
        `const ENTITY_DETAIL_OUTPUT_SCHEMAS = {\n${detailSchemas}\n} as const;\n\n` +
        "// biome-ignore format: one generated detail input variant per entity.\n" +
        `export const entityDetailInputSchema = z.discriminatedUnion(\"entity\", [\n  ${detailInputVariants}\n]);\n\n` +
        "export function parseEntityDetailInput<E extends DetailEntity>(entity: E, value: unknown): EntityDetailInputByEntity[E];\n" +
        "export function parseEntityDetailInput(entity: DetailEntity, value: unknown): unknown {\n" +
        "  const parsed = entityDetailInputSchema.parse(value);\n" +
        "  if (parsed.entity !== entity) throw new Error(\"Entity detail input discriminator mismatch\");\n" +
        "  return parsed;\n" +
        "}\n\n" +
        "export function parseEntityDetailResult<E extends DetailEntity>(entity: E, value: unknown): EntityDetailByEntity[E];\n" +
        "export function parseEntityDetailResult(entity: DetailEntity, value: unknown): unknown {\n" +
        "  return getEntityDetailOutputSchema(entity).parse(value);\n" +
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
        "// biome-ignore assist/source/organizeImports: generated schema aliases are deterministic.\n" +
        `${listRuntimeOutputImports}\n${listFilterFieldImports}\n` +
        'import { MAX_PAGE_SIZE, MAX_SORTS } from "@cubby/schemas/pagination";\n' +
        'import { z } from "zod";\n\n' +
        `export const listEntities = ${compactLiteral(browserCrudEntities)} as const;\n` +
        "export type ListEntity = (typeof listEntities)[number];\n\n" +
        'const entityListSortSchema = z.object({ orderBy: z.string().min(1), direction: z.enum(["asc", "desc"]) });\n' +
        'const entityListSortsSchema = z.union([entityListSortSchema, z.array(entityListSortSchema).min(1).max(MAX_SORTS)]);\n' +
        'const entityListPaginationSchema = z.object({ pageIndex: z.number().int().min(0), pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE) });\n' +
        'const entityListMetaSchema = z.object({ pageIndex: z.number().int().min(0), pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE), totalCount: z.number().int().min(0), sums: z.record(z.string(), z.number()).optional() });\n\n' +
        `${listFilterSchemas}\n\n` +
        `export const entityListInputSchema = z.discriminatedUnion("entity", [\n  ${listInputVariants}\n]);\n\n` +
        'const ENTITY_LIST_OUTPUT_SCHEMAS = {\n' +
        `${listOutputSchemas}\n` +
        '} as const;\n\n' +
        "type EntityListFiltersByEntity = {\n" +
        `${listFilterTypes}\n` +
        "};\n" +
        'type EntityListSort = z.input<typeof entityListSortSchema>;\n' +
        "export type EntityListInputByEntity = {\n" +
        "  [E in ListEntity]: { entity: E; filters: EntityListFiltersByEntity[E]; sort?: EntityListSort | EntityListSort[]; pagination?: { pageIndex: number; pageSize: number }; groupBy?: string };\n" +
        "};\n\n" +
        "export type EntityListResultByEntity = {\n" +
        "  [E in ListEntity]: z.output<(typeof ENTITY_LIST_OUTPUT_SCHEMAS)[E]>;\n" +
        "};\n\n" +
        "export function parseEntityListInput<E extends ListEntity>(entity: E, value: unknown): EntityListInputByEntity[E];\n" +
        "export function parseEntityListInput(entity: ListEntity, value: unknown): unknown {\n" +
        "  const parsed = entityListInputSchema.parse(value);\n" +
        "  if (parsed.entity !== entity) throw new Error(\"Entity list input discriminator mismatch\");\n" +
        "  return parsed;\n" +
        "}\n\n" +
        "export function parseEntityListResult<E extends ListEntity>(entity: E, value: unknown): EntityListResultByEntity[E];\n" +
        "export function parseEntityListResult(entity: ListEntity, value: unknown): unknown {\n" +
        "  return getEntityListOutputSchema(entity).parse(value);\n" +
        "}\n\n" +
        "export function getEntityListOutputSchema<E extends ListEntity>(entity: E): z.ZodType<EntityListResultByEntity[E]>;\n" +
        "export function getEntityListOutputSchema(entity: ListEntity): z.ZodType {\n" +
        "  return ENTITY_LIST_OUTPUT_SCHEMAS[entity];\n" +
        "}\n",
    },
    {
      relativePath: "apps/web/src/entities/generated/entity-mutation-results.gen.ts",
      source:
        generatedHeader +
        `${mutationOutputImports}\n` +
        'import type { z } from "zod";\n\n' +
        `export const entityMutationOutputEntities = ${compactLiteral(browserCrudEntities)} as const;\n` +
        "export type EntityMutationOutputEntity = (typeof entityMutationOutputEntities)[number];\n\n" +
        "export type EntityMutationOutputByEntity = {\n" +
        `${mutationOutputTypes}\n` +
        "};\n\n" +
        "// biome-ignore format: one generated mutation output schema per entity.\n" +
        `const ENTITY_MUTATION_OUTPUT_SCHEMAS = {\n${mutationOutputSchemas}\n} as const;\n\n` +
        "export function parseEntityMutationOutput<E extends EntityMutationOutputEntity>(entity: E, value: unknown): EntityMutationOutputByEntity[E];\n" +
        "export function parseEntityMutationOutput(entity: EntityMutationOutputEntity, value: unknown): unknown {\n" +
        "  return ENTITY_MUTATION_OUTPUT_SCHEMAS[entity].parse(value);\n" +
        "}\n",
    },
    {
      relativePath: "apps/web/src/entities/generated/entity-filter-fields.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "@cubby/schemas/entity";\n' +
        `${filterFieldImportSource}\n\n` +
        "// biome-ignore format: generated filter field assembly stays one entity per line.\n" +
        `export const entityFilterFieldMaps: Partial<Record<Entity, Record<string, unknown>>> = {\n${filterFieldBindings}\n};\n`,
    },
    {
      relativePath: "apps/web/src/server/generated/entity-bindings.gen.ts",
      source:
        generatedHeader +
        'import { mutationSideEffectsSchema } from "@cubby/schemas/background-jobs";\n' +
        'import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";\n' +
        `${schemaImports}\n` +
        'import { type ZodSchema, z } from "zod";\n\n' +
        "type CrudBinding = {\n" +
        "  idSchema: ZodSchema;\n" +
        "  createInput: ZodSchema;\n" +
        "  updateInput: ZodSchema;\n" +
        "  output: ZodSchema;\n" +
        "};\n\n" +
        "type EntityBinding = { crud: CrudBinding | null };\n\n" +
        "const crud = <E extends ShortcodeEntity, S extends Omit<CrudBinding, \"idSchema\">>(\n" +
        "  entity: E,\n" +
        "  schemas: S,\n" +
        ") => ({ idSchema: shortcodeSchema(entity), ...schemas });\n\n" +
        "// biome-ignore format: generated bindings stay one entity per line.\n" +
        `export const ENTITY_BINDINGS = {\n${bindings}\n} satisfies Record<ShortcodeEntity, EntityBinding>;\n\n` +
        "// biome-ignore format: one generated variant per entity.\n" +
        `export const generatedEntityCreateCommandSchema = z.union([\n  ${commandVariants("create", "create")}\n]);\n\n` +
        "// biome-ignore format: one generated variant per entity.\n" +
        `export const generatedEntityUpdateCommandSchema = z.union([\n  ${commandVariants("update", "update")}\n]);\n` +
        "\n" +
        `export const generatedEntityMutationCreateResultSchema = z.discriminatedUnion("entity", [\n  ${mutationResultVariants("create")}\n]);\n\n` +
        `export const generatedEntityMutationUpdateResultSchema = z.discriminatedUnion("entity", [\n  ${mutationResultVariants("update")}\n]);\n`,
    },
    {
      relativePath: "apps/web/src/entities/generated/entity-routes.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "@cubby/schemas/entity";\n\n' +
        "// biome-ignore format: generated routes stay one entity per line.\n" +
        `export const generatedBrowserRoutes = ${compactLiteral(
          Object.fromEntries(browserEntities.map((entity) => [entity.key, browserRoutes(entity)])),
        )} as const satisfies Partial<Record<Entity, { basePath: string; routes: { detail: string; list: string } }>>;\n\n` +
        "// biome-ignore format: generated entity roster stays one line.\n" +
        `export const generatedBrowserCrudEntities = ${compactLiteral(browserCrudEntities)} as const;\n` +
        "export type GeneratedBrowserCrudEntity = (typeof generatedBrowserCrudEntities)[number];\n",
    },
    {
      relativePath: "apps/web/src/server/generated/entity-kernel-entities.gen.ts",
      source:
        generatedHeader +
        "// biome-ignore format: generated entity roster stays one line.\n" +
        `export const generatedEntityKernelEntities = ${compactLiteral(kernelEntityKeys)} as const;\n\n` +
        "// biome-ignore format: generated capabilities stay compact and reviewable.\n" +
        `export const generatedEntityKernelContractCases = ${compactLiteral(kernelContractCases)} as const;\n\n` +
        "// biome-ignore format: generated action rosters stay one line each.\n" +
        `export const generatedSearchEntityKernelEntities = ${compactLiteral(entitiesForAction("search"))} as const;\n` +
        `export const generatedMergeEntityKernelEntities = ${compactLiteral(entitiesForAction("merge"))} as const;\n`,
    },
    {
      relativePath: "apps/web/src/server/generated/entity-kernel-bindings.gen.ts",
      source:
        generatedHeader +
        "// biome-ignore assist/source/organizeImports: generated port aliases are deterministic.\n" +
        'import type { EntityKernelEntity } from "~/server/entity-kernel/contracts";\n\n' +
        `${portTypeImports}\n\n` +
        "/** Each literal module/export source reference is checked without a runtime import. */\n" +
        `type EntityPortExportChecks = readonly [${portExportChecks
          .map(
            (ref) =>
              `typeof ${portTypeModuleAliases.get(ref.module)}[${JSON.stringify(ref.export)}]`,
          )
          .join(", ")}];\n\n` +
        `${runtimeAdapterImportSource}\n\n` +
        "// biome-ignore format: generated runtime assembly stays one entity per line.\n" +
        `export const ENTITY_KERNEL_BINDINGS = {\n${runtimeBindings}\n} as const satisfies Record<EntityKernelEntity, unknown> & { readonly __portExportChecks?: EntityPortExportChecks };\n`,
    },
  ];
};

export const renderFilterArtifacts = (entities: readonly EntityLiteral[]): EntityArtifacts[] => {
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
    `${left.module}#${left.export}`.localeCompare(`${right.module}#${right.export}`),
  );
  const refAliases = new Map(
    filterRefs.map((ref, index) => [`${ref.module}#${ref.export}`, `filterRef${index}`]),
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
      ...(descriptor.field === null ? [] : [`field:${JSON.stringify(descriptor.field)}`]),
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
      ...(descriptor.label === null ? [] : [`label:${JSON.stringify(descriptor.label)}`]),
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
              ...(descriptor.optionsKey === null ? [] : [descriptor.optionsKey]),
              ...(descriptor.optionsRef === null
                ? []
                : [`${descriptor.optionsRef.module}#${descriptor.optionsRef.export}`]),
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
      relativePath: "apps/web/src/entities/generated/entity-filter-contracts.gen.ts",
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
        "// biome-ignore format: generated filter contract cases stay compact.\n" +
        `export const generatedEntityFilterContractCases = ${compactLiteral(filterContractCases)} as const satisfies Record<Entity, EntityFilterContractCase>;\n`,
    },
    {
      relativePath: "apps/web/src/entities/filter-search-fields.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "@cubby/schemas/entity";\n' +
        'import { urlStringParam } from "~/lib/search-params";\n\n' +
        "// biome-ignore format: generated data stays one entity per line.\n" +
        `const entityFilterUrlKeyRoster: Partial<Record<Entity, readonly string[]>> = ${compactLiteral(roster)};\n\n` +
        "/** The URL keys an entity accepts for its canonical filter assembly. */\n" +
        "export const entityFilterUrlKeys = (entity: Entity): readonly string[] =>\n" +
        "  entityFilterUrlKeyRoster[entity] ?? [];\n\n" +
        "export function entityFilterSearchFields(\n" +
        "  entity: Entity,\n" +
        "): Record<string, typeof urlStringParam> {\n" +
        "  const fields: Record<string, typeof urlStringParam> = {};\n" +
        "  for (const key of entityFilterUrlKeys(entity)) fields[key] = urlStringParam;\n" +
        "  return fields;\n" +
        "}\n",
    },
    {
      relativePath: "apps/web/src/entities/generated/entity-filter-bindings.gen.ts",
      source:
        generatedHeader +
        'import type { Entity } from "@cubby/schemas/entity";\n' +
        'import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";\n' +
        `${runtimeImports}\n` +
        'import type { FilterSpec } from "../filter-manifest";\n\n' +
        "// biome-ignore format: generated runtime filter assembly stays one entity per line.\n" +
        `export const generatedEntityFilters = {\n${runtimeRoster}\n} satisfies Record<Entity, readonly FilterSpec[]>;\n`,
    },
  ];
};

const formatSource = (root: string, artifact: EntityArtifacts): string => {
  const result = execFileSync(
    "pnpm",
    [
      "exec",
      "biome",
      "format",
      "--stdin-file-path",
      artifact.relativePath,
    ],
    { cwd: root, encoding: "utf8", input: artifact.source },
  );
  return result;
};

const ARTIFACT_HASH_PATTERN = /^\/\/ Entity artifact hashes: source=([a-f0-9]+) content=([a-f0-9]+)\n/m;
const artifactHash = (source: string) =>
  createHash("sha256").update(source).digest("hex").slice(0, 16);

const sealArtifact = (root: string, artifact: EntityArtifacts): EntityArtifacts => {
  const formatted = formatSource(root, artifact);
  const hashLine = `// Entity artifact hashes: source=${artifactHash(artifact.source)} content=${artifactHash(formatted)}\n`;
  return {
    ...artifact,
    source: formatted.replace(generatedHeader, generatedHeader + hashLine),
  };
};

const generatedName = /^(?:entity-literal-.+|entity-manifest-data|entity-inspector|entity-details|entity-lists|entity-filter-catalog|entity-filter-bindings|entity-filter-fields|entity-bindings|entity-routes|entity-kernel-bindings|entity-kernel-entities|entity-runtime-ports|filter-search-fields|shortcode-registry)\.gen\.ts$/;

const findExtraArtifacts = async (root: string, artifacts: readonly EntityArtifacts[]) => {
  const expected = new Set(artifacts.map(({ relativePath }) => relativePath));
  const directories = new Set(artifacts.map(({ relativePath }) => dirname(relativePath)));
  const extras: string[] = [];
  for (const directory of directories) {
    const absoluteDirectory = resolve(root, directory);
    try {
      const entries = await readdir(absoluteDirectory, { withFileTypes: true });
      for (const entry of entries) {
        const relativePath = `${directory}/${entry.name}`;
        if (entry.isFile() && generatedName.test(entry.name) && !expected.has(relativePath)) {
          extras.push(relativePath);
        }
      }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
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
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
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
      const current = await readFile(resolve(root, artifact.relativePath), "utf8");
      const hashes = current.match(ARTIFACT_HASH_PATTERN);
      const content = current.replace(ARTIFACT_HASH_PATTERN, "");
      if (
        hashes?.[1] !== artifactHash(artifact.source) ||
        hashes?.[2] !== artifactHash(content)
      ) {
        problems.push(`stale: ${artifact.relativePath}`);
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
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

const writeEntityArtifacts = async (root: string, artifacts: readonly EntityArtifacts[]) => {
  const problems = await checkEntityArtifacts(root, artifacts);
  const extras = problems.filter((problem) => problem.startsWith("extraneous:"));
  if (extras.length > 0) {
    throw new LiteralSpecError(`Refusing to overwrite with ${extras.join(", ")}.`);
  }
  for (const artifact of artifacts) {
    const artifactPath = resolve(root, artifact.relativePath);
    await stat(dirname(artifactPath)).catch(async (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        await mkdir(dirname(artifactPath), { recursive: true });
        return;
      }
      throw error;
    });
    await writeFile(artifactPath, artifact.source);
  }
};

const generateEntityArtifacts = async (
  root = ROOT,
  source?: string,
) => {
  const entities = source === undefined ? await parseEntityLiteralFiles() : parseEntityLiterals(source, SPEC_PATH);
  const artifacts = [
    ...renderEntityArtifacts(entities),
    ...renderFilterArtifacts(entities),
  ].map((artifact) => sealArtifact(root, artifact));
  return { entities, artifacts };
};

const main = async () => {
  const check = process.argv.slice(2).includes("--check");
  const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--check");
  if (unknownArguments.length > 0) {
    throw new LiteralSpecError(`Unknown arguments: ${unknownArguments.join(", ")}.`);
  }
  if (check) {
    const entities = await parseEntityLiteralFiles();
    const artifacts = [
      ...renderEntityArtifacts(entities),
      ...renderFilterArtifacts(entities),
    ];
    const problems = await checkSealedEntityArtifacts(ROOT, artifacts);
    if (problems.length > 0) {
      throw new LiteralSpecError(`Generated entity artifacts are out of date:\n${problems.join("\n")}`);
    }
    return;
  }
  const { artifacts } = await generateEntityArtifacts();
  await writeEntityArtifacts(ROOT, artifacts);
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
