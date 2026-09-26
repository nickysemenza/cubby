import { readFileSync } from "node:fs";
import {
  entityFieldControlKinds,
  entityFieldKinds,
  FILTER_KINDS,
  isSlotListView,
  LIST_PRESENTATION_CHOICES,
  WAYFINDING_DOMAINS,
} from "../../../../packages/schemas/src/entity-definitions/definition.ts";
import { connectedViews } from "../../../../packages/schemas/src/connected-view-definitions.ts";
import { generatedHeader } from "../../artifacts.ts";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";

/** The hand-written Swift types the manifest JSON decodes into. */
const SWIFT_MANIFEST_TYPES =
  "apps/apple/CubbyKit/Sources/CubbyKit/Catalog/EntityManifest.swift";

// Swift keywords that collide with values we mint case names from. The
// checked vocabulary only currently hits "enum" (an EntityFieldKind); a set so
// a future kind named after another keyword is expected with the backticks
// Swift requires.
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
    .split(/[-.]/)
    .map((segment, index) =>
      index === 0
        ? segment.charAt(0).toLowerCase() + segment.slice(1)
        : segment.charAt(0).toUpperCase() + segment.slice(1),
    )
    .join("");

/** A Swift enum case name for a source identifier, backtick-escaped when the
 * camelCased identifier collides with a Swift keyword. */
const swiftCaseName = (raw: string): string => {
  const identifier = swiftIdentifier(raw);
  return SWIFT_RESERVED_WORDS.has(identifier)
    ? `\`${identifier}\``
    : identifier;
};

/** JS string literal syntax and Swift's overlap for every escape this
 * vocabulary produces, except `\uXXXX` (Swift requires `\u{XXXX}`). */
const swiftString = (value: string): string => {
  const json = JSON.stringify(value);
  if (json.includes("\\u")) {
    throw new Error(
      `swiftString: ${json} contains a \\u escape Swift cannot parse as written.`,
    );
  }
  return json;
};

/** Canonical `EntityAction` ordering; also the Swift enum's declaration order. */
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

type SwiftEnum = Readonly<{
  body: string;
  /** `case name = "raw"` declarations, in order. */
  cases: readonly Readonly<{ name: string; raw: string }>[];
}>;

/**
 * Every `enum` declared in a hand-written Swift file, by name, with its
 * brace-matched body and its `case name = "raw"` declarations. The vocabulary
 * enums spell every raw value explicitly so this stays a line match.
 */
const parseSwiftEnums = (source: string): Map<string, SwiftEnum> => {
  const enums = new Map<string, SwiftEnum>();
  for (const match of source.matchAll(
    /^[ \t]*(?:public[ \t]+)?enum[ \t]+(\w+)\b[^{\n]*\{/gmu,
  )) {
    const start = match.index + match[0].length;
    let depth = 1;
    let index = start;
    while (depth > 0 && index < source.length) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") depth -= 1;
      index += 1;
    }
    const body = source.slice(start, index - 1);
    enums.set(match[1]!, {
      body,
      cases: [
        ...body.matchAll(/^\s*case\s+(`?\w+`?)\s*=\s*"([^"\\]*)"\s*$/gmu),
      ].map((found) => ({ name: found[1]!, raw: found[2]! })),
    });
  }
  return enums;
};

/**
 * The hand-written Swift vocabulary, checked against the TS vocabulary it
 * mirrors. `exactly` fails generation unless the Swift enum declares these raw
 * values, in order, under the camelCased case names; `member` fails it when
 * the manifest would carry a value the Swift enum cannot decode.
 */
const swiftVocabulary = (source: string) => {
  const enums = parseSwiftEnums(source);
  const lookup = (name: string) => {
    const found = enums.get(name);
    if (found === undefined)
      throw new Error(`${SWIFT_MANIFEST_TYPES} declares no enum ${name}.`);
    return found;
  };
  const exactly = (name: string, rawValues: readonly string[]) => {
    const expected = rawValues.map(
      (raw) => `case ${swiftCaseName(raw)} = ${swiftString(raw)}`,
    );
    const actual = lookup(name).cases.map(
      ({ name: caseName, raw }) => `case ${caseName} = ${swiftString(raw)}`,
    );
    if (expected.join("\n") !== actual.join("\n"))
      throw new Error(
        `${SWIFT_MANIFEST_TYPES}: enum ${name} must declare exactly these cases, in this order, to match the TS vocabulary:\n${expected.map((line) => `    ${line}`).join("\n")}`,
      );
  };
  // The `label` switch arms (`case .list: "List"`) of an enum's `var label`.
  const labels = (name: string, expected: Readonly<Record<string, string>>) => {
    const labelSwitch = lookup(name).body.split("var label")[1] ?? "";
    const actual = Object.fromEntries(
      [...labelSwitch.matchAll(/case \.(\w+): "([^"\\]*)"/gu)].map((found) => [
        found[1]!,
        found[2]!,
      ]),
    );
    for (const [caseName, label] of Object.entries(expected))
      if (actual[caseName] !== label)
        throw new Error(
          `${SWIFT_MANIFEST_TYPES}: ${name}.${caseName} must be labelled ${swiftString(label)} to match LIST_PRESENTATION_CHOICES.`,
        );
  };
  const member = <Value extends string>(
    name: string,
    value: Value,
    context: string,
  ): Value => {
    if (!lookup(name).cases.some(({ raw }) => raw === value))
      throw new Error(
        `${context} is ${swiftString(value)}, which ${name} in ${SWIFT_MANIFEST_TYPES} does not declare.`,
      );
    return value;
  };
  return { exactly, labels, member };
};

type Vocabulary = ReturnType<typeof swiftVocabulary>;

/** The entity keys the catalog declares, for cross-references (relations,
 * filter brands, field references) that must land on a Swift `EntityKey` case. */
type EntityKeyLookup = (raw: string, context: string) => string;

// The manifest JSON is shaped as Swift's synthesized `Codable` encodes the
// types in `EntityManifest.swift`: property names as keys, `String` enums as
// their raw value, an enum case with associated values as
// `{"case": {"label": value}}` (`_0` for an unlabelled one), a payload-less
// case as `{"case": {}}`, and every optional present as `null` when absent.

const options = (values: readonly { value: string; label: string }[] | null) =>
  values === null ? null : values.map(({ value, label }) => ({ value, label }));

const filterJSON = (
  filter: CompiledEntity["filterDescriptors"][number],
  entityKey: EntityKeyLookup,
  vocabulary: Vocabulary,
  context: string,
) => ({
  columnId: filter.columnId,
  urlKey: filter.urlKey,
  kind: vocabulary.member(
    "EntityFilterKind",
    filter.kind,
    `${context}.filters.${filter.columnId}.kind`,
  ),
  placeholder: filter.placeholder,
  label: filter.label ?? null,
  options: options(filter.options),
  // `meta`/`color` steer web-only rendering, not the generic catalog surface.
  wire:
    filter.wire.kind === "param"
      ? { param: { name: filter.wire.name } }
      : {
          range: {
            from: filter.wire.from,
            to: filter.wire.to,
            presence: filter.wire.presence ?? null,
          },
        },
  targetEntity:
    filter.brandRef === null
      ? null
      : entityKey(
          filter.brandRef.entity,
          `${context}.filters.${filter.columnId}.brandRef`,
        ),
});

type Field = CompiledEntity["fieldModel"]["fields"][number];

const explanationJSON = (explanation: Field["explanation"]) =>
  explanation === null
    ? null
    : {
        ruleId: explanation.ruleId,
        version: explanation.version,
        description: explanation.description,
        readPath: explanation.readPath ?? null,
        resolver: explanation.resolver,
        projections: { ...explanation.projections },
        sourceDependencies: (explanation.sourceDependencies ?? []).map(
          ({ path, label }) => ({ path, label }),
        ),
        actions: [...(explanation.actions ?? [])],
      };

const optionalMember = <Value extends string>(
  vocabulary: Vocabulary,
  name: string,
  value: Value | null | undefined,
  context: string,
) =>
  value === null || value === undefined
    ? null
    : vocabulary.member(name, value, context);

const referenceJSON = (
  reference: Field["reference"],
  entityKey: EntityKeyLookup,
  where: string,
) =>
  reference === null
    ? null
    : {
        entity: entityKey(reference.entity, `${where}.reference`),
        multiple: reference.multiple,
        scope: reference.scope.map(({ sourceField, targetField }) => ({
          sourceField,
          targetField,
        })),
        filters: reference.filters.map(({ field, values }) => ({
          field,
          values: [...values],
        })),
      };

const fieldControlJSON = (
  control: Field["control"],
  vocabulary: Vocabulary,
  where: string,
) => ({
  controlKind: optionalMember(
    vocabulary,
    "EntityControlKind",
    control?.kind,
    `${where}.control.kind`,
  ),
  controlRenderer: optionalMember(
    vocabulary,
    "ControlRendererID",
    control?.renderer,
    `${where}.control.renderer`,
  ),
  controlSection: control?.section ?? null,
  controlWidth: control?.width ?? null,
  controlOptions: options(control?.options ?? null),
  placeholder: control?.placeholder ?? null,
  initial: control?.initial ?? null,
});

const fieldDisplayJSON = (
  display: Field["display"],
  vocabulary: Vocabulary,
  where: string,
) => ({
  showInList: display.list,
  showInDetail: display.detail,
  detailOrder: display.detailOrder ?? null,
  listOrder: display.listOrder ?? null,
  listHidden: display.listHidden,
  width: display.width ?? null,
  format: display.format ?? null,
  listRenderer: optionalMember(
    vocabulary,
    "ListRendererID",
    display.renderer?.list,
    `${where}.display.renderer.list`,
  ),
  detailRenderer: optionalMember(
    vocabulary,
    "DetailRendererID",
    display.renderer?.detail,
    `${where}.display.renderer.detail`,
  ),
  mobileSlot: display.mobile?.slot ?? null,
  mobilePriority: display.mobile?.priority ?? null,
  mobileInteractive: display.mobile?.interactive ?? false,
});

const fieldJSON = (
  field: Field,
  fieldModel: CompiledEntity["fieldModel"],
  entityKey: EntityKeyLookup,
  vocabulary: Vocabulary,
  context: string,
) => {
  const where = `${context}.fields.${field.key}`;
  return {
    key: field.key,
    columnId: field.display.columnId ?? null,
    label: field.label,
    kind: vocabulary.member("EntityFieldKind", field.kind, `${where}.kind`),
    nullable: field.nullable,
    reference: referenceJSON(field.reference, entityKey, where),
    explanation: explanationJSON(field.explanation),
    ...fieldControlJSON(field.control, vocabulary, where),
    inCreate: fieldModel.create.includes(field.key),
    // Required when the create schema rejects `undefined` (the same rule as
    // `requiredOnCreate` in `entity-field-model.gen.ts`).
    requiredOnCreate:
      field.validation.create !== null &&
      !field.validation.create.safeParse(undefined).success,
    inUpdate: fieldModel.update.includes(field.key),
    ...fieldDisplayJSON(field.display, vocabulary, where),
  };
};

type DetailSection = CompiledEntity["inspector"]["detail"]["sections"][number];

const detailSectionJSON = (
  entity: string,
  section: DetailSection,
  vocabulary: Vocabulary,
) => {
  const where = `${entity}.presentation.detail.sections.${section.id}`;
  const kind = () => {
    switch (section.kind) {
      case "fields":
        return { fields: { _0: [...section.fields] } };
      case "relation":
        return {
          relation: {
            _0: {
              relation: section.relation,
              filterDescriptor: section.filter.descriptor,
              prefill:
                section.prefill === null
                  ? null
                  : { field: section.prefill.field },
              columns: section.columns === null ? null : [...section.columns],
              sort:
                section.sort === null
                  ? null
                  : {
                      field: section.sort.field,
                      direction: vocabulary.member(
                        "Direction",
                        section.sort.direction,
                        `${where}.sort.direction`,
                      ),
                    },
              limit: section.limit ?? null,
              empty: section.empty ?? null,
              hideWhenEmpty: section.hideWhenEmpty,
              collapseWhenEmpty: section.collapseWhenEmpty,
            },
          },
        };
      case "timeline":
        return {
          timeline: {
            mode: vocabulary.member(
              "TimelineSectionMode",
              section.mode,
              `${where}.mode`,
            ),
          },
        };
      case "slot":
        return { slot: {} };
    }
  };
  return {
    id:
      section.kind === "slot"
        ? vocabulary.member(
            "EntityDetailSlotID",
            `${entity}.${section.id}`,
            `${where}.id`,
          )
        : section.id,
    title: section.title ?? null,
    placement: vocabulary.member(
      "SectionPlacement",
      section.placement,
      `${where}.placement`,
    ),
    collapsed: section.collapsed,
    explanationField:
      section.kind === "slot" ? (section.explanationField ?? null) : null,
    kind: kind(),
  };
};

type ListView = CompiledEntity["inspector"]["list"]["views"][number];

const listViewJSON = (
  entity: string,
  view: ListView,
  vocabulary: Vocabulary,
) =>
  isSlotListView(view)
    ? {
        slot: {
          id: vocabulary.member(
            "EntityListSlotID",
            `${entity}.${view.id}`,
            `${entity}.presentation.list.views.${view.id}`,
          ),
          label: view.label,
          searchKeys: [...view.searchKeys],
        },
      }
    : { [view]: {} };

const presentationJSON = (
  entity: string,
  presentation: CompiledEntity["inspector"],
  vocabulary: Vocabulary,
) => {
  const { detail, list, edit } = presentation;
  const where = `${entity}.presentation`;
  // SAFETY: entity is a compiled declaration key, and the exhaustive connected-view roster covers every declaration key.
  const entityConnectedViews =
    connectedViews[entity as keyof typeof connectedViews];
  return {
    detailVariant: vocabulary.member(
      "DetailVariant",
      detail.variant,
      `${where}.detail.variant`,
    ),
    heroChip: detail.hero.chip ?? null,
    heroStats: [...detail.hero.stats],
    heroBreadcrumb: detail.hero.breadcrumb ?? null,
    heroImages: detail.hero.images,
    heroActions: detail.hero.actions.map((action) =>
      vocabulary.member(
        "EntityHeroActionID",
        action,
        `${where}.detail.hero.actions`,
      ),
    ),
    detailSections: detail.sections.map((section) =>
      detailSectionJSON(entity, section, vocabulary),
    ),
    connectedViews: entityConnectedViews.map((view) => ({
      key: view.key,
      title: view.title,
      target: view.target,
    })),
    listViews: list.views.map((view) => listViewJSON(entity, view, vocabulary)),
    shelfSubtitle: [...(list.shelf?.subtitle ?? [])],
    listActions: [...list.actions],
    timelineFields: [...(list.timeline?.fields ?? [])],
    lifecycle:
      list.timeline?.lifecycle == null
        ? null
        : {
            start: [...list.timeline.lifecycle.start],
            milestones: [...list.timeline.lifecycle.milestones],
            end: list.timeline.lifecycle.end ?? null,
          },
    editSections:
      edit.sections === null
        ? null
        : edit.sections.map((section) => ({
            id: section.id,
            title: section.title,
            fields: [...section.fields],
            collapsed: section.collapsed,
          })),
    readOnlyOnUpdate: [...edit.readOnlyOnUpdate],
    readOnlyWhen: edit.readOnlyWhen.map((rule) => ({
      field: rule.field,
      equals:
        rule.equals === true || rule.equals === false
          ? { bool: { _0: rule.equals } }
          : { string: { _0: rule.equals } },
      fields: [...rule.fields],
    })),
  };
};

const entityJSON = (
  entity: CompiledEntity,
  entityKey: EntityKeyLookup,
  vocabulary: Vocabulary,
) => {
  if (entity.route === null) {
    throw new Error(
      `${entity.key} has no route; EntityCatalog needs a basePath.`,
    );
  }
  const context = entity.key;
  // `inspector.plural` is nullable in the TS model but every declared entity
  // sets one today; fall back to `singular` rather than widen the Swift
  // field to Optional for a case that has never occurred.
  const plural = entity.inspector.plural ?? entity.inspector.singular;
  const searchable = entity.descriptor.searchable === true;
  const primarySearch =
    entity.inspector.list.primarySearch === null
      ? entity.contract !== null && searchable
        ? {
            key: "searchQuery",
            placeholder: `Search ${plural.toLowerCase()} or shortcode`,
          }
        : null
      : {
          key: entity.inspector.list.primarySearch.key,
          placeholder: entity.inspector.list.primarySearch.placeholder,
        };
  return {
    key: entityKey(entity.key, context),
    singular: entity.inspector.singular,
    plural,
    basePath: entity.route.basePath,
    shortcodePrefix: entity.shortcode ?? null,
    titleField: entity.inspector.titleField,
    domain:
      entity.inspector.domain === null
        ? null
        : vocabulary.member(
            "WayfindingDomain",
            entity.inspector.domain,
            `${context}.presentation.domain`,
          ),
    sfSymbol: entity.inspector.icons.sfSymbol,
    emoji: entity.inspector.icons.emoji,
    searchable,
    primarySearch,
    timeline:
      entity.timeline === null
        ? null
        : vocabulary.member(
            "EntityTimelineMode",
            entity.timeline,
            `${context}.capabilities.timeline`,
          ),
    fields: entity.fieldModel.fields.map((field) =>
      fieldJSON(field, entity.fieldModel, entityKey, vocabulary, context),
    ),
    filters: entity.filterDescriptors.map((filter) =>
      filterJSON(filter, entityKey, vocabulary, context),
    ),
    relations: entity.relations.map((relation) => ({
      key: relation.key,
      label: relation.label,
      target: entityKey(
        relation.target,
        `${context}.relations.${relation.key}`,
      ),
      cardinality: vocabulary.member(
        "RelationCardinality",
        relation.cardinality,
        `${context}.relations.${relation.key}.cardinality`,
      ),
    })),
    presentation: presentationJSON(entity.key, entity.inspector, vocabulary),
  };
};

/** `EntityCatalog.descriptor(forShortcode:)` matches by prefix, so every
 * prefix must be distinct and end in its `-` separator; `basePath` keys the
 * native routes. */
const checkCatalogKeys = (entities: readonly CompiledEntity[]) => {
  const seen = new Map<string, string>();
  for (const entity of entities) {
    const claims = [
      `basePath ${entity.route?.basePath ?? ""}`,
      ...(entity.shortcode === null ? [] : [`shortcode ${entity.shortcode}`]),
    ];
    if (!entity.route?.basePath)
      throw new Error(`${entity.key} has an empty basePath.`);
    if (entity.shortcode !== null && !/^[A-Z]{2,5}-$/u.test(entity.shortcode))
      throw new Error(
        `${entity.key} shortcode prefix ${entity.shortcode} is not 2-5 capitals and a dash.`,
      );
    for (const claim of claims) {
      const owner = seen.get(claim);
      if (owner !== undefined)
        throw new Error(`${entity.key} and ${owner} share ${claim}.`);
      seen.set(claim, entity.key);
    }
  }
};

/**
 * Renders the native entity catalog: an enumerable `EntityKey` (into the
 * `CubbyAPISupport` target, where the generated client's `Entity` schema is
 * overridden to it so the wire enum and the catalog key are one type) and
 * `entity-manifest.json`, one `EntityDescriptor` per declared entity carrying
 * the declaration's `presentation` block, decoded by the hand-written types in
 * `EntityManifest.swift`. Those types' vocabulary enums are checked here
 * against the TS vocabulary, so the two cannot drift.
 */
export const renderSwiftEntityCatalog = (
  entities: readonly CompiledEntity[],
  swiftTypesSource: string = readFileSync(
    new URL(`../../../../${SWIFT_MANIFEST_TYPES}`, import.meta.url),
    "utf8",
  ),
): EntityArtifacts[] => {
  const vocabulary = swiftVocabulary(swiftTypesSource);
  const used = (values: readonly string[]) => [...new Set(values)].sort();
  const rendererIds = (surface: "control" | "list" | "detail") =>
    used(
      entities.flatMap((entity) =>
        entity.fieldModel.fields.flatMap((field) => {
          const renderer =
            surface === "control"
              ? field.control?.renderer
              : field.display.renderer?.[surface];
          return renderer === null || renderer === undefined ? [] : [renderer];
        }),
      ),
    );
  vocabulary.exactly("EntityAction", ACTION_ORDER);
  vocabulary.exactly("EntityFieldKind", entityFieldKinds);
  vocabulary.exactly("EntityControlKind", entityFieldControlKinds);
  vocabulary.exactly("EntityFilterKind", FILTER_KINDS);
  vocabulary.exactly("ControlRendererID", rendererIds("control"));
  vocabulary.exactly("ListRendererID", rendererIds("list"));
  vocabulary.exactly("DetailRendererID", rendererIds("detail"));
  vocabulary.exactly(
    "EntityHeroActionID",
    used(entities.flatMap((entity) => entity.inspector.detail.hero.actions)),
  );
  vocabulary.exactly(
    "EntityDetailSlotID",
    used(
      entities.flatMap((entity) =>
        entity.inspector.detail.sections.flatMap((section) =>
          section.kind === "slot" ? [`${entity.key}.${section.id}`] : [],
        ),
      ),
    ),
  );
  vocabulary.exactly(
    "EntityListSlotID",
    used(
      entities.flatMap((entity) =>
        entity.inspector.list.views.flatMap((view) =>
          isSlotListView(view) ? [`${entity.key}.${view.id}`] : [],
        ),
      ),
    ),
  );
  vocabulary.exactly("WayfindingDomain", WAYFINDING_DOMAINS);
  vocabulary.exactly(
    "ListPresentationChoice",
    swiftPresentationChoices.map((choice) => choice.swiftCase),
  );
  vocabulary.labels(
    "ListPresentationChoice",
    Object.fromEntries(
      swiftPresentationChoices.map((choice) => [
        choice.swiftCase,
        choice.label,
      ]),
    ),
  );
  vocabulary.labels("ListView", {
    table: presentationLabel("table"),
    shelf: presentationLabel("shelf"),
  });
  checkCatalogKeys(entities);

  const declaredKeys = new Set(entities.map(({ key }) => key));
  const entityKey: EntityKeyLookup = (raw, context) => {
    if (!declaredKeys.has(raw))
      throw new Error(
        `${context} names ${raw}, which is not a declared entity key.`,
      );
    return raw;
  };
  const entityKeyCases = entities
    .map(({ key }) => `  case ${swiftCaseName(key)} = ${swiftString(key)}`)
    .join("\n");
  return [
    {
      relativePath:
        "apps/apple/CubbyKit/Sources/CubbyAPISupport/Generated/EntityKey.swift",
      source:
        generatedHeader +
        "// swift-format-ignore-file\n\n" +
        "/// Every declared entity, keyed as the manifest spells it. The generated client's\n" +
        "/// `Entity` schema is this enum (`typeOverrides` in openapi-generator-config.yaml).\n" +
        `public enum EntityKey: String, CaseIterable, Codable, Sendable {\n${entityKeyCases}\n}\n`,
    },
    {
      relativePath:
        "apps/apple/CubbyKit/Sources/CubbyKit/Generated/entity-manifest.json",
      source: `${JSON.stringify(
        entities.map((entity) => entityJSON(entity, entityKey, vocabulary)),
        null,
        2,
      )}\n`,
    },
  ];
};
