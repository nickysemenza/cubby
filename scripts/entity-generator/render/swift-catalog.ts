import { generatedHeader } from "../artifacts.ts";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";
import {
  entityFieldControlKinds,
  entityFieldKinds,
} from "../../../packages/schemas/src/entity-definitions/definition.ts";
import { filterKinds } from "../compile.ts";

/** Per-entity kernel action roster, as built for `entity-kernel-*` artifacts. */
export type SwiftKernelContractCases = Readonly<
  Record<string, { actions: readonly string[] }>
>;

// Swift keywords that collide with values we mint case/identifier names from.
// The entity vocabulary only currently hits "enum" (an EntityFieldKind), but
// this stays a set (not a single check) so a future field/action/filter kind
// named after another keyword fails loudly instead of emitting invalid Swift.
const SWIFT_RESERVED_WORDS = new Set([
  "associatedtype",
  "class",
  "deinit",
  "enum",
  "extension",
  "fileprivate",
  "func",
  "import",
  "init",
  "inout",
  "internal",
  "let",
  "open",
  "operator",
  "private",
  "protocol",
  "public",
  "rethrows",
  "static",
  "struct",
  "subscript",
  "typealias",
  "var",
  "break",
  "case",
  "continue",
  "default",
  "defer",
  "do",
  "else",
  "fallthrough",
  "for",
  "guard",
  "if",
  "in",
  "repeat",
  "return",
  "switch",
  "where",
  "while",
  "as",
  "Any",
  "catch",
  "false",
  "is",
  "nil",
  "self",
  "Self",
  "super",
  "throw",
  "throws",
  "true",
  "try",
]);

/** Kebab/camel source identifier -> Swift camelCase (`usda-food` -> `usdaFood`). */
const swiftIdentifier = (raw: string): string =>
  raw
    .split("-")
    .map((segment, index) =>
      index === 0
        ? segment.charAt(0).toLowerCase() + segment.slice(1)
        : segment.charAt(0).toUpperCase() + segment.slice(1),
    )
    .join("");

/** A Swift enum case/member name for a source identifier, backtick-escaped
 * when the camelCased identifier collides with a Swift keyword. */
const swiftCaseName = (raw: string): string => {
  const identifier = swiftIdentifier(raw);
  return SWIFT_RESERVED_WORDS.has(identifier)
    ? `\`${identifier}\``
    : identifier;
};

/** JS string literal syntax and Swift's overlap for every escape this
 * vocabulary produces, except `\uXXXX` (Swift requires `\u{XXXX}`). Throw
 * rather than emit a Swift file that fails to compile. */
const swiftString = (value: string): string => {
  const json = JSON.stringify(value);
  if (json.includes("\\u")) {
    throw new Error(
      `swiftString: ${json} contains a \\u escape Swift cannot parse as written.`,
    );
  }
  return json;
};

const swiftOptionalString = (value: string | null): string =>
  value === null ? "nil" : swiftString(value);

const swiftOptionalInt = (value: number | null): string =>
  value === null ? "nil" : String(value);

/** Canonical `EntityAction` ordering; also the enum's declaration order, so
 * a `Set<EntityAction>` literal built from this order matches case order. */
const ACTION_ORDER = [
  "get",
  "list",
  "search",
  "create",
  "update",
  "bulkUpdate",
  "delete",
  "merge",
] as const;

const renderStringEnum = (
  name: string,
  rawValues: readonly string[],
): string => {
  const cases = rawValues
    .map((raw) => `  case ${swiftCaseName(raw)} = ${swiftString(raw)}`)
    .join("\n");
  return `public enum ${name}: String, CaseIterable, Codable, Sendable {\n${cases}\n}\n`;
};

const renderFilterOptionLiteral = (option: {
  value: string;
  label: string;
}): string =>
  `FilterOption(value: ${swiftString(option.value)}, label: ${swiftString(option.label)})`;

const renderFilterDescriptorLiteral = (
  filter: CompiledEntity["filterDescriptors"][number],
): string => {
  // Drop `meta`/`color`: those steer web-only rendering (badge coloring,
  // metadata-only rows), not the generic catalog surface.
  const options =
    filter.options === null
      ? "nil"
      : `[${filter.options.map(renderFilterOptionLiteral).join(", ")}]`;
  return (
    "FilterDescriptor(" +
    `columnId: ${swiftString(filter.columnId)}, ` +
    `urlKey: ${swiftString(filter.urlKey)}, ` +
    `kind: .${swiftCaseName(filter.kind)}, ` +
    `placeholder: ${swiftString(filter.placeholder)}, ` +
    `label: ${swiftOptionalString(filter.label)}, ` +
    `options: ${options})`
  );
};

const renderFieldDescriptorLiteral = (
  field: CompiledEntity["fieldModel"]["fields"][number],
): string => {
  const controlKind =
    field.control === null ? "nil" : `.${swiftCaseName(field.control.kind)}`;
  return (
    "FieldDescriptor(" +
    `key: ${swiftString(field.key)}, ` +
    `label: ${swiftString(field.label)}, ` +
    `kind: .${swiftCaseName(field.kind)}, ` +
    `controlKind: ${controlKind}, ` +
    `section: ${swiftOptionalString(field.display.detailSection)}, ` +
    `showInList: ${field.display.list ? "true" : "false"}, ` +
    `showInDetail: ${field.display.detail ? "true" : "false"}, ` +
    `detailOrder: ${swiftOptionalInt(field.display.detailOrder)})`
  );
};

const renderEntityDescriptorLiteral = (
  entity: CompiledEntity,
  kernelContractCases: SwiftKernelContractCases,
): string => {
  if (entity.route === null) {
    throw new Error(
      `${entity.key} has no route; EntityCatalog needs a basePath.`,
    );
  }
  // Not every declared entity is kernel-backed (cookbook, usda-food); those
  // carry no repository-driven actions, matching the TS kernel contract map.
  const actions = kernelContractCases[entity.key]?.actions ?? [];
  const orderedActions = ACTION_ORDER.filter((action) =>
    actions.includes(action),
  );
  const fields = entity.fieldModel.fields
    .map(renderFieldDescriptorLiteral)
    .join(",\n      ");
  const filters = entity.filterDescriptors
    .map(renderFilterDescriptorLiteral)
    .join(",\n      ");
  // `inspector.plural` is nullable in the TS model but every declared entity
  // sets one today; fall back to `singular` rather than widen the Swift
  // field to Optional for a case that has never occurred.
  const plural = entity.inspector.plural ?? entity.inspector.singular;
  return (
    `  EntityDescriptor(\n` +
    `    key: .${swiftCaseName(entity.key)},\n` +
    `    singular: ${swiftString(entity.inspector.singular)},\n` +
    `    plural: ${swiftString(plural)},\n` +
    `    basePath: ${swiftString(entity.route.basePath)},\n` +
    `    shortcodePrefix: ${swiftOptionalString(entity.shortcode)},\n` +
    `    titleField: ${swiftString(entity.inspector.titleField)},\n` +
    `    fields: [\n      ${fields}\n    ],\n` +
    `    filters: [\n      ${filters}\n    ],\n` +
    `    actions: [${orderedActions.map((action) => `.${swiftCaseName(action)}`).join(", ")}]\n` +
    `  )`
  );
};

/**
 * Renders the read-only Swift entity catalog consumed by CubbyKit: an
 * enumerable `EntityKey`, the field/filter/action vocabulary as Swift enums
 * (case names camelCased from the TS source, raw values kept verbatim), and
 * one `EntityDescriptor` per declared entity. Pure string emission, so the
 * artifact hash in `sealArtifact` can catch a hand edit deterministically.
 */
export const renderSwiftEntityCatalog = (
  entities: readonly CompiledEntity[],
  kernelContractCases: SwiftKernelContractCases,
): EntityArtifacts => {
  const entityKeyEnum = renderStringEnum(
    "EntityKey",
    entities.map(({ key }) => key),
  );
  const entityActionEnum = renderStringEnum("EntityAction", ACTION_ORDER);
  const entityFieldKindEnum = renderStringEnum(
    "EntityFieldKind",
    entityFieldKinds,
  );
  const entityControlKindEnum = renderStringEnum(
    "EntityControlKind",
    entityFieldControlKinds,
  );
  const entityFilterKindEnum = renderStringEnum(
    "EntityFilterKind",
    filterKinds,
  );
  // One static per entity rather than a single ~900-line array literal:
  // Release/WMO spent ~650 s inside the SIL optimizer's COWArrayOpt pass
  // (ColdBlockInfo::analyze) on the one-time initializer of `all` when the
  // whole catalog was one function; nineteen small initializers cost ~17 s.
  const descriptorName = (entity: CompiledEntity) =>
    `${swiftCaseName(entity.key)}Descriptor`;
  const descriptors = entities
    .map(
      (entity) =>
        `  private static let ${descriptorName(entity)}: EntityDescriptor =\n` +
        renderEntityDescriptorLiteral(entity, kernelContractCases),
    )
    .join("\n\n");
  const allEntries = entities
    .map((entity) => `    ${descriptorName(entity)},`)
    .join("\n");
  const source =
    generatedHeader +
    "// swift-format-ignore-file\n\n" +
    entityKeyEnum +
    "\n" +
    entityActionEnum +
    "\n" +
    entityFieldKindEnum +
    "\n" +
    entityControlKindEnum +
    "\n" +
    entityFilterKindEnum +
    "\n" +
    "public struct FilterOption: Codable, Sendable, Hashable {\n" +
    "  public let value: String\n" +
    "  public let label: String\n" +
    "}\n\n" +
    "public struct FieldDescriptor: Codable, Sendable {\n" +
    "  public let key: String\n" +
    "  public let label: String\n" +
    "  public let kind: EntityFieldKind\n" +
    "  public let controlKind: EntityControlKind?\n" +
    "  public let section: String?\n" +
    "  public let showInList: Bool\n" +
    "  public let showInDetail: Bool\n" +
    "  public let detailOrder: Int?\n" +
    "}\n\n" +
    "public struct FilterDescriptor: Codable, Sendable {\n" +
    "  public let columnId: String\n" +
    "  public let urlKey: String\n" +
    "  public let kind: EntityFilterKind\n" +
    "  public let placeholder: String\n" +
    "  public let label: String?\n" +
    "  public let options: [FilterOption]?\n" +
    "}\n\n" +
    "public struct EntityDescriptor: Codable, Sendable {\n" +
    "  public let key: EntityKey\n" +
    "  public let singular: String\n" +
    "  public let plural: String\n" +
    "  public let basePath: String\n" +
    "  public let shortcodePrefix: String?\n" +
    "  public let titleField: String\n" +
    "  public let fields: [FieldDescriptor]\n" +
    "  public let filters: [FilterDescriptor]\n" +
    "  public let actions: Set<EntityAction>\n" +
    "}\n\n" +
    "public enum EntityCatalog {\n" +
    `${descriptors}\n\n` +
    `  public static let all: [EntityDescriptor] = [\n${allEntries}\n  ]\n\n` +
    "  private static let byKey: [EntityKey: EntityDescriptor] = Dictionary(\n" +
    "    uniqueKeysWithValues: all.map { ($0.key, $0) }\n" +
    "  )\n\n" +
    "  // Total by construction: `all` has one entry per `EntityKey` case\n" +
    "  // because both are generated from the same declared entity roster.\n" +
    "  public static subscript(key: EntityKey) -> EntityDescriptor {\n" +
    "    byKey[key]!\n" +
    "  }\n" +
    "}\n";
  return {
    relativePath:
      "apps/apple/CubbyKit/Sources/CubbyKit/Generated/EntityCatalog.swift",
    source,
  };
};
