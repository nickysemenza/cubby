import {
  FILTER_KINDS,
  isSlotListView,
  LIST_PRESENTATION_CHOICES,
  WAYFINDING_DOMAINS,
} from "../../../../packages/schemas/src/entity-definitions/definition.ts";
import { generatedHeader } from "../../artifacts.ts";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";
import {
  entityFieldControlKinds,
  entityFieldKinds,
} from "../../../../packages/schemas/src/entity-definitions/definition.ts";

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

const swiftPresentationChoices = LIST_PRESENTATION_CHOICES.map((choice) => ({
  ...choice,
  swiftCase:
    choice.id === "table"
      ? "list"
      : choice.id === "shelf"
        ? "cards"
        : choice.id,
}));
const presentationLabel = (
  id: (typeof LIST_PRESENTATION_CHOICES)[number]["id"],
) => LIST_PRESENTATION_CHOICES.find((choice) => choice.id === id)!.label;

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

const swiftOptionalString = (value: string | null | undefined): string =>
  value === null || value === undefined ? "nil" : swiftString(value);

const swiftOptionalInt = (value: number | null | undefined): string =>
  value === null || value === undefined ? "nil" : String(value);

const swiftBool = (value: boolean): string => (value ? "true" : "false");

const swiftStringArray = (values: readonly string[]): string =>
  `[${values.map(swiftString).join(", ")}]`;

const swiftOptionalStringArray = (values: readonly string[] | null): string =>
  values === null ? "nil" : swiftStringArray(values);

const swiftOptionalRenderer = (value: string | null): string =>
  value === null ? "nil" : `.${swiftCaseName(value)}`;

/** Canonical `EntityAction` ordering; also the enum's declaration order, so
 * a `Set<EntityAction>` literal built from this order matches case order. */
const ACTION_ORDER = [
  "get",
  "list",
  "timeline",
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

const renderOptionLiteral = (option: {
  value: string;
  label: string;
}): string =>
  `LabeledOption(value: ${swiftString(option.value)}, label: ${swiftString(option.label)})`;

const renderOptionsLiteral = (
  options: readonly { value: string; label: string }[] | null,
): string =>
  options === null ? "nil" : `[${options.map(renderOptionLiteral).join(", ")}]`;

/** The entity keys the catalog declares, for cross-references (relations,
 * filter brands, field references) that must land on a Swift `EntityKey` case. */
type EntityKeyLookup = (raw: string, context: string) => string;

const renderFilterDescriptorLiteral = (
  filter: CompiledEntity["filterDescriptors"][number],
  entityKey: EntityKeyLookup,
  context: string,
): string => {
  // Drop `meta`/`color`: those steer web-only rendering (badge coloring,
  // metadata-only rows), not the generic catalog surface.
  const wire =
    filter.wire.kind === "param"
      ? `.param(name: ${swiftString(filter.wire.name)})`
      : `.range(from: ${swiftString(filter.wire.from)}, to: ${swiftString(filter.wire.to)}, presence: ${swiftOptionalString(filter.wire.presence)})`;
  const targetEntity =
    filter.brandRef === null
      ? "nil"
      : `.${entityKey(filter.brandRef.entity, `${context}.filters.${filter.columnId}.brandRef`)}`;
  return (
    "FilterDescriptor(" +
    `columnId: ${swiftString(filter.columnId)}, ` +
    `urlKey: ${swiftString(filter.urlKey)}, ` +
    `kind: .${swiftCaseName(filter.kind)}, ` +
    `placeholder: ${swiftString(filter.placeholder)}, ` +
    `label: ${swiftOptionalString(filter.label)}, ` +
    `options: ${renderOptionsLiteral(filter.options)}, ` +
    `wire: ${wire}, ` +
    `targetEntity: ${targetEntity})`
  );
};

const fieldRendererMetadata = (
  field: CompiledEntity["fieldModel"]["fields"][number],
) => ({
  control: field.control?.renderer ?? null,
  list: field.display.renderer?.list ?? null,
  detail: field.display.renderer?.detail ?? null,
  mobileInteractive: field.display.mobile?.interactive ?? false,
});

const renderFieldExplanationLiteral = (
  explanation: CompiledEntity["fieldModel"]["fields"][number]["explanation"],
): string => {
  if (explanation === null) return "nil";
  const projections = Object.entries(explanation.projections ?? {});
  const projectionLiteral = projections.length
    ? `[${projections
        .map(([key, value]) => `${swiftString(key)}: ${swiftString(value)}`)
        .join(", ")}]`
    : "[:]";
  const dependencies = (explanation.sourceDependencies ?? [])
    .map(
      (source) =>
        `FieldExplanationDependency(path: ${swiftString(source.path)}, label: ${swiftString(source.label)})`,
    )
    .join(", ");
  const actions = (explanation.actions ?? []).map(swiftString).join(", ");
  return `FieldExplanation(ruleId: ${swiftString(explanation.ruleId)}, version: ${explanation.version}, description: ${swiftString(explanation.description)}, readPath: ${swiftOptionalString(explanation.readPath)}, resolver: ${swiftString(explanation.resolver)}, projections: ${projectionLiteral}, sourceDependencies: [${dependencies}], actions: [${actions}])`;
};

const renderFieldDescriptorLiteral = (
  field: CompiledEntity["fieldModel"]["fields"][number],
  fieldModel: CompiledEntity["fieldModel"],
  entityKey: EntityKeyLookup,
  context: string,
): string => {
  const rendererMetadata = fieldRendererMetadata(field);
  const controlKind =
    field.control === null ? "nil" : `.${swiftCaseName(field.control.kind)}`;
  const reference =
    field.reference === null
      ? "nil"
      : `FieldReference(entity: .${entityKey(field.reference.entity, `${context}.fields.${field.key}.reference`)}, multiple: ${swiftBool(field.reference.multiple)}, scope: [${field.reference.scope.map((binding) => `FieldReferenceScope(sourceField: ${swiftString(binding.sourceField)}, targetField: ${swiftString(binding.targetField)})`).join(", ")}], filters: [${field.reference.filters.map((filter) => `FieldReferenceFilter(field: ${swiftString(filter.field)}, values: ${swiftStringArray(filter.values)})`).join(", ")}])`;
  return (
    "FieldDescriptor(" +
    `key: ${swiftString(field.key)}, ` +
    `columnId: ${swiftOptionalString(field.display.columnId)}, ` +
    `label: ${swiftString(field.label)}, ` +
    `kind: .${swiftCaseName(field.kind)}, ` +
    `nullable: ${swiftBool(field.nullable)}, ` +
    `reference: ${reference}, ` +
    `explanation: ${renderFieldExplanationLiteral(field.explanation)}, ` +
    `controlKind: ${controlKind}, ` +
    `controlRenderer: ${swiftOptionalRenderer(rendererMetadata.control)}, ` +
    `controlSection: ${swiftOptionalString(field.control?.section ?? null)}, ` +
    `controlWidth: ${swiftOptionalString(field.control?.width ?? null)}, ` +
    `controlOptions: ${renderOptionsLiteral(field.control?.options ?? null)}, ` +
    `placeholder: ${swiftOptionalString(field.control?.placeholder ?? null)}, ` +
    `initial: ${swiftOptionalString(field.control?.initial ?? null)}, ` +
    `inCreate: ${swiftBool(fieldModel.create.includes(field.key))}, ` +
    // Required when the create schema rejects `undefined` (the same rule as
    // `requiredOnCreate` in `entity-field-model.gen.ts`).
    `requiredOnCreate: ${swiftBool(
      field.validation.create !== null &&
        !field.validation.create.safeParse(undefined).success,
    )}, ` +
    `inUpdate: ${swiftBool(fieldModel.update.includes(field.key))}, ` +
    `showInList: ${swiftBool(field.display.list)}, ` +
    `showInDetail: ${swiftBool(field.display.detail)}, ` +
    `detailOrder: ${swiftOptionalInt(field.display.detailOrder)}, ` +
    `listOrder: ${swiftOptionalInt(field.display.listOrder)}, ` +
    `listHidden: ${swiftBool(field.display.listHidden)}, ` +
    `width: ${swiftOptionalString(field.display.width)}, ` +
    `format: ${swiftOptionalString(field.display.format)}, ` +
    `listRenderer: ${swiftOptionalRenderer(rendererMetadata.list)}, ` +
    `detailRenderer: ${swiftOptionalRenderer(rendererMetadata.detail)}, ` +
    `mobileSlot: ${swiftOptionalString(field.display.mobile?.slot ?? null)}, ` +
    `mobilePriority: ${swiftOptionalInt(field.display.mobile?.priority ?? null)}, ` +
    `mobileInteractive: ${swiftBool(rendererMetadata.mobileInteractive)})`
  );
};

type DetailSection = CompiledEntity["inspector"]["detail"]["sections"][number];

const renderDetailSectionLiteral = (
  entity: string,
  section: DetailSection,
): string => {
  const id = section.kind === "slot" ? `${entity}.${section.id}` : section.id;
  const common =
    `id: ${swiftString(id)}, ` +
    `title: ${swiftOptionalString(section.title)}, ` +
    `placement: .${section.placement}, ` +
    `collapsed: ${swiftBool(section.collapsed)}, ` +
    `explanationField: ${swiftOptionalString(section.kind === "slot" ? section.explanationField : null)}`;
  switch (section.kind) {
    case "fields":
      return `DetailSection(${common}, kind: .fields(${swiftStringArray(section.fields)}))`;
    case "relation": {
      const sort =
        section.sort === null
          ? "nil"
          : `SectionSort(field: ${swiftString(section.sort.field)}, direction: .${section.sort.direction})`;
      return (
        `DetailSection(${common}, kind: .relation(RelationSectionSpec(` +
        `relation: ${swiftString(section.relation)}, ` +
        `filterDescriptor: ${swiftString(section.filter.descriptor)}, ` +
        `prefill: ${section.prefill === null ? "nil" : `RelationSectionPrefill(field: ${swiftString(section.prefill.field)})`}, ` +
        `columns: ${swiftOptionalStringArray(section.columns)}, ` +
        `sort: ${sort}, ` +
        `limit: ${swiftOptionalInt(section.limit)}, ` +
        `hideWhenEmpty: ${swiftBool(section.hideWhenEmpty)})))`
      );
    }
    case "timeline":
      return `DetailSection(${common}, kind: .timeline(mode: .${section.mode}))`;
    case "slot":
      return `DetailSection(${common}, kind: .slot)`;
  }
};

type ListView = CompiledEntity["inspector"]["list"]["views"][number];

const renderListViewLiteral = (entity: string, view: ListView): string =>
  isSlotListView(view)
    ? `.slot(id: ${swiftString(`${entity}.${view.id}`)}, label: ${swiftString(view.label)}, searchKeys: ${swiftStringArray(view.searchKeys)})`
    : `.${view}`;

const renderReadOnlyMatch = (value: string | boolean): string =>
  value === true || value === false
    ? `.bool(${swiftBool(value)})`
    : `.string(${swiftString(value)})`;

const renderPresentationLiteral = (
  entity: string,
  presentation: CompiledEntity["inspector"],
  indent: string,
): string => {
  const { detail, list, edit } = presentation;
  const inner = `${indent}  `;
  const sections =
    detail.sections.length === 0
      ? "[]"
      : `[\n${detail.sections.map((section) => `${inner}  ${renderDetailSectionLiteral(entity, section)}`).join(",\n")}\n${inner}]`;
  const lifecycle =
    list.timeline?.lifecycle == null
      ? "nil"
      : `TimelineLifecycle(start: ${swiftStringArray(list.timeline.lifecycle.start)}, milestones: ${swiftStringArray(list.timeline.lifecycle.milestones)}, end: ${swiftOptionalString(list.timeline.lifecycle.end)})`;
  const editSections =
    edit.sections === null
      ? "nil"
      : `[${edit.sections.map((section) => `EditSection(id: ${swiftString(section.id)}, title: ${swiftString(section.title)}, fields: ${swiftStringArray(section.fields)}, collapsed: ${swiftBool(section.collapsed)})`).join(", ")}]`;
  const readOnlyWhen =
    edit.readOnlyWhen.length === 0
      ? "[]"
      : `[${edit.readOnlyWhen.map((rule) => `ReadOnlyRule(field: ${swiftString(rule.field)}, equals: ${renderReadOnlyMatch(rule.equals)}, fields: ${swiftStringArray(rule.fields)})`).join(", ")}]`;
  return (
    `EntityPresentation(\n` +
    `${inner}detailVariant: .${detail.variant},\n` +
    `${inner}heroChip: ${swiftOptionalString(detail.hero.chip)},\n` +
    `${inner}heroStats: ${swiftStringArray(detail.hero.stats)},\n` +
    `${inner}heroBreadcrumb: ${swiftOptionalString(detail.hero.breadcrumb)},\n` +
    `${inner}heroImages: ${swiftBool(detail.hero.images)},\n` +
    `${inner}heroActions: ${swiftStringArray(detail.hero.actions)},\n` +
    `${inner}detailSections: ${sections},\n` +
    `${inner}listViews: [${list.views.map((view) => renderListViewLiteral(entity, view)).join(", ")}],\n` +
    `${inner}shelfSubtitle: ${swiftStringArray(list.shelf?.subtitle ?? [])},\n` +
    `${inner}listActions: ${swiftStringArray(list.actions)},\n` +
    `${inner}timelineFields: ${swiftStringArray(list.timeline?.fields ?? [])},\n` +
    `${inner}lifecycle: ${lifecycle},\n` +
    `${inner}editSections: ${editSections},\n` +
    `${inner}readOnlyOnUpdate: ${swiftStringArray(edit.readOnlyOnUpdate)},\n` +
    `${inner}readOnlyWhen: ${readOnlyWhen}\n` +
    `${indent})`
  );
};

const renderRelationLiteral = (
  relation: CompiledEntity["relations"][number],
  entityKey: EntityKeyLookup,
  context: string,
): string =>
  "RelationDescriptor(" +
  `key: ${swiftString(relation.key)}, ` +
  `label: ${swiftString(relation.label)}, ` +
  `target: .${entityKey(relation.target, `${context}.relations.${relation.key}`)}, ` +
  `cardinality: .${relation.cardinality})`;

const renderEntityDescriptorLiteral = (
  entity: CompiledEntity,
  entityKey: EntityKeyLookup,
): string => {
  if (entity.route === null) {
    throw new Error(
      `${entity.key} has no route; EntityCatalog needs a basePath.`,
    );
  }
  const context = entity.key;
  const fields = entity.fieldModel.fields
    .map((field) =>
      renderFieldDescriptorLiteral(
        field,
        entity.fieldModel,
        entityKey,
        context,
      ),
    )
    .join(",\n      ");
  const filters = entity.filterDescriptors
    .map((filter) => renderFilterDescriptorLiteral(filter, entityKey, context))
    .join(",\n      ");
  const relations = entity.relations
    .map((relation) => renderRelationLiteral(relation, entityKey, context))
    .join(",\n      ");
  // `inspector.plural` is nullable in the TS model but every declared entity
  // sets one today; fall back to `singular` rather than widen the Swift
  // field to Optional for a case that has never occurred.
  const plural = entity.inspector.plural ?? entity.inspector.singular;
  const searchable = entity.descriptor.searchable === true;
  const primarySearch =
    entity.inspector.list.primarySearch === null
      ? entity.contract !== null && searchable
        ? `PrimarySearchDescriptor(key: "searchQuery", placeholder: ${swiftString(`Search ${plural.toLowerCase()} or shortcode`)})`
        : "nil"
      : `PrimarySearchDescriptor(key: ${swiftString(entity.inspector.list.primarySearch.key)}, placeholder: ${swiftString(entity.inspector.list.primarySearch.placeholder)})`;
  const timeline = entity.timeline === null ? "nil" : `.${entity.timeline}`;
  return (
    `  EntityDescriptor(\n` +
    `    key: .${swiftCaseName(entity.key)},\n` +
    `    singular: ${swiftString(entity.inspector.singular)},\n` +
    `    plural: ${swiftString(plural)},\n` +
    `    basePath: ${swiftString(entity.route.basePath)},\n` +
    `    shortcodePrefix: ${swiftOptionalString(entity.shortcode)},\n` +
    `    titleField: ${swiftString(entity.inspector.titleField)},\n` +
    `    domain: ${entity.inspector.domain === null ? "nil" : `.${entity.inspector.domain}`},\n` +
    `    sfSymbol: ${swiftString(entity.inspector.icons.sfSymbol)},\n` +
    `    emoji: ${swiftString(entity.inspector.icons.emoji)},\n` +
    `    searchable: ${swiftBool(searchable)},\n` +
    `    primarySearch: ${primarySearch},\n` +
    `    timeline: ${timeline},\n` +
    `    fields: ${fields.length === 0 ? "[]" : `[\n      ${fields}\n    ]`},\n` +
    `    filters: ${filters.length === 0 ? "[]" : `[\n      ${filters}\n    ]`},\n` +
    `    relations: ${relations.length === 0 ? "[]" : `[\n      ${relations}\n    ]`},\n` +
    `    presentation: ${renderPresentationLiteral(entity.key, entity.inspector, "    ")}\n` +
    `  )`
  );
};

/**
 * Renders the read-only Swift entity catalog consumed by CubbyKit: an
 * enumerable `EntityKey` (into the `CubbyAPISupport` target, where the
 * generated client's `Entity` schema is overridden to it so the wire enum
 * and the catalog key are one type), the field/filter/action vocabulary as
 * Swift enums (case names camelCased from the TS source, raw values kept
 * verbatim), and one `EntityDescriptor` per declared entity carrying the
 * declaration's `presentation` block verbatim. Pure string emission,
 * compared byte for byte by `generate:check`.
 */
export const renderSwiftEntityCatalog = (
  entities: readonly CompiledEntity[],
  // Kept in the signature because `render/index.ts` builds and passes it;
  // the catalog's verbs come from the HTTP document (`EntityOperations.swift`).
  _kernelContractCases: SwiftKernelContractCases,
): EntityArtifacts[] => {
  const declaredKeys = new Set(entities.map(({ key }) => key));
  const entityKey: EntityKeyLookup = (raw, context) => {
    if (!declaredKeys.has(raw))
      throw new Error(
        `${context} names ${raw}, which is not a declared entity key.`,
      );
    return swiftCaseName(raw);
  };
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
    FILTER_KINDS,
  );
  const rendererIds = (surface: "control" | "list" | "detail") =>
    [
      ...new Set(
        entities.flatMap((entity) =>
          entity.fieldModel.fields.flatMap((field) => {
            const renderer =
              surface === "control"
                ? field.control?.renderer
                : field.display.renderer?.[surface];
            return renderer === null || renderer === undefined
              ? []
              : [renderer];
          }),
        ),
      ),
    ].sort();
  const controlRendererEnum = renderStringEnum(
    "ControlRendererID",
    rendererIds("control"),
  );
  const listRendererEnum = renderStringEnum(
    "ListRendererID",
    rendererIds("list"),
  );
  const detailRendererEnum = renderStringEnum(
    "DetailRendererID",
    rendererIds("detail"),
  );
  // One static per entity rather than a single ~900-line array literal:
  // Release/WMO spent ~650 s inside the SIL optimizer's COWArrayOpt pass
  // (ColdBlockInfo::analyze) on the one-time initializer of `all` when the
  // whole catalog was one function; per-entity initializers cost ~17 s. The
  // nested section/presentation literals stay inside each entity's static.
  const descriptorName = (entity: CompiledEntity) =>
    `${swiftCaseName(entity.key)}Descriptor`;
  const descriptors = entities
    .map(
      (entity) =>
        `  private static let ${descriptorName(entity)}: EntityDescriptor =\n` +
        renderEntityDescriptorLiteral(entity, entityKey),
    )
    .join("\n\n");
  const allEntries = entities
    .map((entity) => `    ${descriptorName(entity)},`)
    .join("\n");
  const source =
    generatedHeader +
    "// swift-format-ignore-file\n\n" +
    "import CubbyAPISupport\nimport Foundation\n\n" +
    entityActionEnum +
    "\n" +
    entityFieldKindEnum +
    "\n" +
    entityControlKindEnum +
    "\n" +
    entityFilterKindEnum +
    "\n" +
    controlRendererEnum +
    "\n" +
    listRendererEnum +
    "\n" +
    detailRendererEnum +
    "\n" +
    "/// A `{value, label}` choice: a filter's options or a select control's options.\n" +
    "public struct LabeledOption: Codable, Sendable, Hashable {\n" +
    "  public let value: String\n" +
    "  public let label: String\n" +
    "}\n\n" +
    "/// The entity a reference field points at; `multiple` for an id-array field.\n" +
    "public struct FieldReference: Codable, Sendable, Hashable {\n" +
    "  public let entity: EntityKey\n" +
    "  public let multiple: Bool\n" +
    "  public let scope: [FieldReferenceScope]\n" +
    "  public let filters: [FieldReferenceFilter]\n" +
    "}\n\n" +
    "public struct FieldReferenceScope: Codable, Sendable, Hashable {\n" +
    "  public let sourceField: String\n" +
    "  public let targetField: String\n" +
    "}\n\n" +
    "public struct FieldReferenceFilter: Codable, Sendable, Hashable {\n" +
    "  public let field: String\n" +
    "  public let values: [String]\n" +
    "}\n\n" +
    "public struct FieldExplanationDependency: Codable, Sendable, Hashable {\n" +
    "  public let path: String\n" +
    "  public let label: String\n" +
    "}\n\n" +
    "public struct FieldExplanation: Codable, Sendable {\n" +
    "  public let ruleId: String\n" +
    "  public let version: Int\n" +
    "  public let description: String\n" +
    "  public let readPath: String?\n" +
    "  public let resolver: String\n" +
    "  public let projections: [String: String]\n" +
    "  public let sourceDependencies: [FieldExplanationDependency]\n" +
    "  public let actions: [String]\n" +
    "}\n\n" +
    "public struct FieldDescriptor: Codable, Sendable {\n" +
    "  public let key: String\n" +
    "  /// The list/relation column id this source field supplies, when renamed.\n" +
    "  public let columnId: String?\n" +
    "  public let label: String\n" +
    "  public let kind: EntityFieldKind\n" +
    "  /// Whether the server accepts `null` for this field; only a nullable key may be cleared.\n" +
    "  public let nullable: Bool\n" +
    "  public let reference: FieldReference?\n" +
    "  public let explanation: FieldExplanation?\n" +
    "  public let controlKind: EntityControlKind?\n" +
    "  /// Semantic specialized-control id; the platform registry owns its implementation.\n" +
    "  public let controlRenderer: ControlRendererID?\n" +
    "  /// The editor section the field groups under when `presentation.editSections` is nil.\n" +
    "  public let controlSection: String?\n" +
    '  /// `"half"` pairs with the next consecutive half-width field on one row.\n' +
    "  public let controlWidth: String?\n" +
    "  /// A select control's choices; nil for every other control.\n" +
    "  public let controlOptions: [LabeledOption]?\n" +
    "  public let placeholder: String?\n" +
    "  /// `today` seeds a date control on create.\n" +
    "  public let initial: String?\n" +
    "  /// Membership in the create / update payloads (the editor's visible field rosters).\n" +
    "  public let inCreate: Bool\n" +
    "  /// The create payload rejects this key absent: the editor must fill it before saving.\n" +
    "  public let requiredOnCreate: Bool\n" +
    "  public let inUpdate: Bool\n" +
    "  public let showInList: Bool\n" +
    "  public let showInDetail: Bool\n" +
    "  public let detailOrder: Int?\n" +
    "  public let listOrder: Int?\n" +
    "  public let listHidden: Bool\n" +
    "  public let width: String?\n" +
    "  /// Cell formatter (`currency`, `signedCurrency`, `plainDate`, `timestamp`, `external-link`, `amount`).\n" +
    "  public let format: String?\n" +
    "  public let listRenderer: ListRendererID?\n" +
    "  public let detailRenderer: DetailRendererID?\n" +
    "  /// Mobile card placement of the list column, when declared.\n" +
    "  public let mobileSlot: String?\n" +
    "  public let mobilePriority: Int?\n" +
    "  public let mobileInteractive: Bool\n" +
    "}\n\n" +
    "/// The list-route query parameter(s) a filter binds to; the request is keyed by these names.\n" +
    "public enum FilterWire: Codable, Sendable, Hashable {\n" +
    "  case param(name: String)\n" +
    "  case range(from: String, to: String, presence: String?)\n\n" +
    "  public var names: [String] {\n" +
    "    switch self {\n" +
    "    case .param(let name): [name]\n" +
    "    case .range(let from, let to, let presence): [from, to] + (presence.map { [$0] } ?? [])\n" +
    "    }\n" +
    "  }\n" +
    "}\n\n" +
    "public struct FilterDescriptor: Codable, Sendable {\n" +
    "  public let columnId: String\n" +
    "  public let urlKey: String\n" +
    "  public let kind: EntityFilterKind\n" +
    "  public let placeholder: String\n" +
    "  public let label: String?\n" +
    "  /// Declared choices; nil when the server supplies them (`EntityDescriptor.filterValues(for:)`).\n" +
    "  public let options: [LabeledOption]?\n" +
    "  public let wire: FilterWire\n" +
    "  /// For an `id`/`idMulti` filter, the entity the ids name.\n" +
    "  public let targetEntity: EntityKey?\n" +
    "}\n\n" +
    "/// The five wayfinding lines, from `WAYFINDING_DOMAINS` in the entity definitions.\n" +
    "public enum WayfindingDomain: String, Codable, Sendable, CaseIterable {\n" +
    `${WAYFINDING_DOMAINS.map((domain) => `  case ${domain}`).join("\n")}\n` +
    "}\n\n" +
    "public enum SectionPlacement: String, Codable, Sendable, Hashable {\n" +
    "  case primary, supporting, full\n" +
    "}\n\n" +
    "public struct SectionSort: Codable, Sendable, Hashable {\n" +
    "  public enum Direction: String, Codable, Sendable, Hashable { case asc, desc }\n" +
    "  public let field: String\n" +
    "  public let direction: Direction\n" +
    "}\n\n" +
    "/// A relation section renders the target entity's list filtered by `filterDescriptor`\n" +
    "/// (a descriptor on the target whose wire name receives this record's id).\n" +
    "public struct RelationSectionSpec: Codable, Sendable, Hashable {\n" +
    "  public let relation: String\n" +
    "  public let filterDescriptor: String\n" +
    "  public let prefill: RelationSectionPrefill?\n" +
    "  public let columns: [String]?\n" +
    "  public let sort: SectionSort?\n" +
    "  public let limit: Int?\n" +
    "  /// Skip the whole section, on both platforms, when its first page is empty.\n" +
    "  public let hideWhenEmpty: Bool\n" +
    "}\n\n" +
    "public struct RelationSectionPrefill: Codable, Sendable, Hashable {\n" +
    "  public let field: String\n" +
    "}\n\n" +
    "public enum TimelineSectionMode: String, Codable, Sendable, Hashable {\n" +
    "  case events, lifecycles\n" +
    "}\n\n" +
    "/// One declared detail section. `history`, `relationships` and `images` are never declared;\n" +
    "/// the renderer derives them from capabilities.\n" +
    "public struct DetailSection: Codable, Sendable, Hashable, Identifiable {\n" +
    "  public enum Kind: Codable, Sendable, Hashable {\n" +
    "    case fields([String])\n" +
    "    case relation(RelationSectionSpec)\n" +
    "    case timeline(mode: TimelineSectionMode)\n" +
    "    /// Hand-written per platform; rendered only where a registry provides it.\n" +
    "    case slot\n" +
    "  }\n\n" +
    "  public let id: String\n" +
    "  public let title: String?\n" +
    "  public let placement: SectionPlacement\n" +
    "  public let collapsed: Bool\n" +
    "  public let explanationField: String?\n" +
    "  public let kind: Kind\n" +
    "}\n\n" +
    "public enum DetailVariant: String, Codable, Sendable, Hashable {\n" +
    "  case standard\n" +
    "  /// The first (relation) section renders before the supporting fields with a create button\n" +
    "  /// prefilled from its filter.\n" +
    "  case journal\n" +
    "}\n\n" +
    "/// The shared List / Cards / Compact control. Compact keeps the Cards URL view.\n" +
    "public enum ListPresentationChoice: String, Codable, Sendable, Hashable, CaseIterable {\n" +
    swiftPresentationChoices
      .map((choice) => `  case ${choice.swiftCase}`)
      .join("\n") +
    "\n\n  public var label: String {\n    switch self {\n" +
    swiftPresentationChoices
      .map(
        (choice) =>
          `    case .${choice.swiftCase}: ${swiftString(choice.label)}`,
      )
      .join("\n") +
    "\n    }\n  }\n}\n\n" +
    "/// A manifest view; the first declared one is the default.\n" +
    "public enum ListView: Codable, Sendable, Hashable, Identifiable {\n" +
    "  case table\n" +
    "  case shelf\n" +
    "  case timeline\n" +
    "  case slot(id: String, label: String, searchKeys: [String])\n\n" +
    "  public var id: String {\n" +
    "    switch self {\n" +
    '    case .table: "table"\n' +
    '    case .shelf: "shelf"\n' +
    '    case .timeline: "timeline"\n' +
    "    case .slot(let id, _, _): id\n" +
    "    }\n" +
    "  }\n\n" +
    "  public var label: String {\n" +
    "    switch self {\n" +
    `    case .table: ${swiftString(presentationLabel("table"))}\n` +
    `    case .shelf: ${swiftString(presentationLabel("shelf"))}\n` +
    '    case .timeline: "Timeline"\n' +
    "    case .slot(_, let label, _): label\n" +
    "    }\n" +
    "  }\n" +
    "}\n\n" +
    "/// The date keys the lifecycle timeline reads: one interval per record from `start` to `end`,\n" +
    "/// with `milestones` as markers. `start` is an ordered fallback — the first key with a\n" +
    "/// non-null value on a record starts its interval.\n" +
    "public struct TimelineLifecycle: Codable, Sendable, Hashable {\n" +
    "  public let start: [String]\n" +
    "  public let milestones: [String]\n" +
    "  public let end: String?\n" +
    "}\n\n" +
    "public struct EditSection: Codable, Sendable, Hashable, Identifiable {\n" +
    "  public let id: String\n" +
    "  public let title: String\n" +
    "  public let fields: [String]\n" +
    "  /// Render the section's body behind a disclosure that starts closed.\n" +
    "  public let collapsed: Bool\n" +
    "}\n\n" +
    "public enum ReadOnlyMatch: Codable, Sendable, Hashable {\n" +
    "  case string(String)\n" +
    "  case bool(Bool)\n" +
    "}\n\n" +
    "/// `fields` are read-only on update while the record's `field` equals `equals`.\n" +
    "public struct ReadOnlyRule: Codable, Sendable, Hashable {\n" +
    "  public let field: String\n" +
    "  public let equals: ReadOnlyMatch\n" +
    "  public let fields: [String]\n" +
    "}\n\n" +
    "/// The declaration's `presentation` block with its defaults resolved: what the generic\n" +
    "/// list, detail and editor screens render. Field keys are `FieldDescriptor.key`s; action keys\n" +
    "/// are the web verb vocabulary and render natively only where a slot registry provides them.\n" +
    "public struct EntityPresentation: Codable, Sendable, Hashable {\n" +
    "  public let detailVariant: DetailVariant\n" +
    "  public let heroChip: String?\n" +
    "  public let heroStats: [String]\n" +
    "  public let heroBreadcrumb: String?\n" +
    "  public let heroImages: Bool\n" +
    "  public let heroActions: [String]\n" +
    "  public let detailSections: [DetailSection]\n" +
    "  public let listViews: [ListView]\n" +
    "  /// Shelf card subtitle fields, in order; empty when there is no shelf view.\n" +
    "  public let shelfSubtitle: [String]\n" +
    "  public let listActions: [String]\n" +
    "  /// Date fields the default timeline emits events for.\n" +
    "  public let timelineFields: [String]\n" +
    "  public let lifecycle: TimelineLifecycle?\n" +
    "  /// Editor sections; nil derives them from `FieldDescriptor.controlSection`.\n" +
    "  public let editSections: [EditSection]?\n" +
    "  public let readOnlyOnUpdate: [String]\n" +
    "  public let readOnlyWhen: [ReadOnlyRule]\n" +
    "}\n\n" +
    "public enum RelationCardinality: String, Codable, Sendable, Hashable {\n" +
    "  case one, many\n" +
    "}\n\n" +
    "public struct RelationDescriptor: Codable, Sendable, Hashable {\n" +
    "  public let key: String\n" +
    "  public let label: String\n" +
    "  public let target: EntityKey\n" +
    "  public let cardinality: RelationCardinality\n" +
    "}\n\n" +
    "/// How `resources.<entity>.timeline` is served: the audit log plus declared date fields, or\n" +
    "/// the entity's own implementation.\n" +
    "public enum EntityTimelineMode: String, Codable, Sendable, Hashable {\n" +
    "  case `default`, custom\n" +
    "}\n\n" +
    "/// The one broad lexical search control a server-backed list exposes.\n" +
    "public struct PrimarySearchDescriptor: Codable, Sendable, Hashable {\n" +
    "  public let key: String\n" +
    "  public let placeholder: String\n" +
    "}\n\n" +
    "public struct EntityDescriptor: Codable, Sendable {\n" +
    "  public let key: EntityKey\n" +
    "  public let singular: String\n" +
    "  public let plural: String\n" +
    "  public let basePath: String\n" +
    "  public let shortcodePrefix: String?\n" +
    "  public let titleField: String\n" +
    "  /// The wayfinding line this entity's records live on; nil for one on no line (image).\n" +
    "  public let domain: WayfindingDomain?\n" +
    "  /// SF Symbol name from the declaration's `presentation.icons.sfSymbol`.\n" +
    "  public let sfSymbol: String\n" +
    "  /// Text fallback from `presentation.icons.emoji` where an SF Symbol can't render: CLI output, notifications, share text.\n" +
    "  public let emoji: String\n" +
    "  /// Indexed by `search.find`; the intent surface is `searchable` ∧ `nativeActions.contains(.get)`.\n" +
    "  public let searchable: Bool\n" +
    "  /// Search transport metadata; nil for lists without a text-search parameter.\n" +
    "  public let primarySearch: PrimarySearchDescriptor?\n" +
    "  /// Non-nil exactly when the HTTP document exposes `resources.<key>.timeline`.\n" +
    "  public let timeline: EntityTimelineMode?\n" +
    "  public let fields: [FieldDescriptor]\n" +
    "  public let filters: [FilterDescriptor]\n" +
    "  public let relations: [RelationDescriptor]\n" +
    "  public let presentation: EntityPresentation\n\n" +
    "  public func field(_ key: String) -> FieldDescriptor? {\n" +
    "    fields.first { $0.key == key }\n" +
    "  }\n\n" +
    "  public func filter(_ columnId: String) -> FilterDescriptor? {\n" +
    "    filters.first { $0.columnId == columnId }\n" +
    "  }\n\n" +
    "  public func relation(_ key: String) -> RelationDescriptor? {\n" +
    "    relations.first { $0.key == key }\n" +
    "  }\n" +
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
    "  }\n\n" +
    "  /// The descriptor whose canonical shortcode prefix a code carries (`PRD-…` → product).\n" +
    "  /// Prefix match only: the server resolves legacy `P-`/`L-` labels and validates the body.\n" +
    "  public static func descriptor(forShortcode code: String) -> EntityDescriptor? {\n" +
    "    let normalized = code.trimmingCharacters(in: .whitespaces).uppercased()\n" +
    "    return all.first { descriptor in\n" +
    "      descriptor.shortcodePrefix.map { normalized.hasPrefix($0) } ?? false\n" +
    "    }\n" +
    "  }\n" +
    "}\n";
  return [
    {
      relativePath:
        "apps/apple/CubbyKit/Sources/CubbyAPISupport/Generated/EntityKey.swift",
      source:
        generatedHeader +
        "// swift-format-ignore-file\n\n" +
        "/// Every declared entity, keyed as the manifest spells it. The generated client's\n" +
        "/// `Entity` schema is this enum (`typeOverrides` in openapi-generator-config.yaml).\n" +
        entityKeyEnum,
    },
    {
      relativePath:
        "apps/apple/CubbyKit/Sources/CubbyKit/Generated/EntityCatalog.swift",
      source,
    },
  ];
};
