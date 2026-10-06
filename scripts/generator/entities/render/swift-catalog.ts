import { assertManifestWire, renderManifestWire } from "./manifest-wire.ts";
import type { ManifestWire } from "../../../../packages/schemas/src/manifest-wire.ts";
import { capitalize } from "../../../../packages/shared/src/text-case.ts";
import {
  entityFieldControlKinds,
  entityFieldKinds,
  FILTER_KINDS,
  isSlotListView,
  LIST_PRESENTATION_CHOICES,
  WAYFINDING_DOMAINS,
} from "../../../../packages/schemas/src/entity-definitions/definition.ts";
import { connectedViews } from "../../../../packages/schemas/src/connected-view-definitions.ts";
import {
  COLLECTION_ACTION_SCOPES,
  COLLECTION_ACTIONS,
} from "../../../../packages/schemas/src/entity-definitions/collection-actions.ts";
import {
  type NativeCoverageEntry,
  type NativeHeroActionPlan,
  nativeCollectionActionPlans,
  nativeCoverage,
  nativeHeroActionPlans,
} from "../../../../packages/schemas/src/native-coverage.ts";
import { SECTION_ACTION_IDS } from "../../../../packages/schemas/src/entity-section-actions.ts";
import { generatedHeader } from "../../artifacts.ts";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";
import {
  entityPrefixLookup,
  valueSchemaForField,
} from "./structured-value-schemas.ts";
import type { EntityForPrefix } from "./value-schema.ts";

// Swift keywords that collide with values we mint case names from. The
// generated vocabulary only currently hits "enum" (an EntityFieldKind); a set so
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
        : capitalize(segment),
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

/** One generated `String` vocabulary enum: cases in declaration order, each
 * `case camelCased = "raw"`, with an optional `label` switch. */
type VocabularyEnum = Readonly<{
  name: string;
  doc?: string;
  cases: readonly Readonly<{ name: string; raw: string; label?: string }>[];
}>;

const vocabularyCases = (rawValues: readonly string[]) =>
  rawValues.map((raw) => ({ name: swiftCaseName(raw), raw }));

const renderVocabularyEnum = ({ name, doc, cases }: VocabularyEnum) => {
  const lines = [
    ...(doc === undefined ? [] : doc.split("\n").map((line) => `/// ${line}`)),
    `public enum ${name}: String, CaseIterable, Codable, Sendable {`,
    ...cases.map(
      (entry) => `    case ${entry.name} = ${swiftString(entry.raw)}`,
    ),
  ];
  if (cases.some((entry) => entry.label !== undefined)) {
    lines.push(
      "",
      "    public var label: String {",
      "        switch self {",
      ...cases.map(
        (entry) =>
          `        case .${entry.name.replaceAll("`", "")}: ${swiftString(entry.label ?? entry.raw)}`,
      ),
      "        }",
      "    }",
    );
  }
  return `${lines.join("\n")}\n}\n`;
};

/** The entity keys the catalog declares, for cross-references (relations,
 * filter brands, field references) that must land on a Swift `EntityKey` case. */
type EntityKeyLookup = (raw: string, context: string) => string;

// The manifest JSON is shaped as Swift's synthesized `Codable` encodes the
// shared manifest-wire description: property names as keys, `String` enums as
// their raw value, an enum case with associated values as
// `{"case": {"label": value}}` (`_0` for an unlabelled one), a payload-less
// case as `{"case": {}}`. Nullable fields use `null`; optional members can be absent.

const options = (
  values: readonly { value: string; label: string; color?: string }[] | null,
) =>
  values === null
    ? null
    : values.map(({ value, label, color }) => ({
        value,
        label,
        color,
      }));

const filterJSON = (
  filter: CompiledEntity["filterDescriptors"][number],
  entityKey: EntityKeyLookup,
  context: string,
) => ({
  columnId: filter.columnId,
  urlKey: filter.urlKey,
  kind: filter.kind,
  placeholder: filter.placeholder,
  label: filter.label ?? null,
  options: options(filter.options),
  // Filter metadata steers web-only rendering.
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

const fieldControlJSON = (control: Field["control"]) => ({
  controlKind: control?.kind ?? null,
  controlRenderer: control?.renderer ?? null,
  controlWidth: control?.width ?? null,
  controlOptions: options(control?.options ?? null),
});

const fieldControlInputJSON = (control: Field["control"]) => ({
  suggestion: control?.suggest ?? null,
  placeholder: control?.placeholder ?? null,
  initial: control?.initial === "today" ? "today" : null,
  initialValue:
    control?.initial != null && control.initial !== "today"
      ? control.initial.value
      : null,
  controlRequired: control?.required ?? null,
});

const fieldDisplayJSON = (display: Field["display"]) => ({
  showInList: display.list,
  showInDetail: display.detail,
  detailOrder: display.detailOrder ?? null,
  listOrder: display.listOrder ?? null,
  referencePreviewLimit: display.referencePreviewLimit ?? null,
  listHidden: display.listHidden,
  width: display.width ?? null,
  format: display.format ?? null,
  readPath: display.readPath ?? null,
  labelPath: display.labelPath ?? null,
  detailLabelPath: display.detailLabelPath ?? null,
  itemsPath: display.itemsPath ?? null,
  listRenderer: display.renderer?.list ?? null,
  detailRenderer: display.renderer?.detail ?? null,
  mobileSlot: display.mobile?.slot ?? null,
  mobilePriority: display.mobile?.priority ?? null,
  mobileInteractive: display.mobile?.interactive ?? false,
});

const fieldJSON = (
  field: Field,
  fieldModel: CompiledEntity["fieldModel"],
  entityKey: EntityKeyLookup,
  entityForPrefix: EntityForPrefix,
  context: string,
): ManifestWire<"FieldDescriptor"> => {
  const where = `${context}.fields.${field.key}`;
  return {
    key: field.key,
    columnId: field.display.columnId ?? null,
    readKey: field.readKey,
    valueOptions: field.display.valueOptions ?? null,
    label: field.label,
    kind: field.kind,
    nullable: field.nullable,
    reference: referenceJSON(field.reference, entityKey, where),
    explanation: explanationJSON(field.explanation),
    resolution: field.resolution,
    ...fieldControlJSON(field.control),
    ...fieldControlInputJSON(field.control),
    valueSchema: valueSchemaForField(context, field, where, entityForPrefix),
    inCreate: fieldModel.create.includes(field.key),
    // Required when the create schema rejects `undefined` (the same rule as
    // `requiredOnCreate` in `entity-field-model.gen.ts`).
    requiredOnCreate:
      field.validation.create !== null &&
      !field.validation.create.safeParse(undefined).success,
    inUpdate: fieldModel.update.includes(field.key),
    ...fieldDisplayJSON(field.display),
  };
};

type DetailSection = CompiledEntity["inspector"]["detail"]["sections"][number];

const detailSectionJSON = (entity: string, section: DetailSection) => {
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
                      direction: section.sort.direction,
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
            mode: section.mode,
          },
        };
      case "slot":
        return { slot: {} };
    }
  };
  return {
    id: section.kind === "slot" ? `${entity}.${section.id}` : section.id,
    title: section.title ?? null,
    placement: section.placement,
    collapsed: section.collapsed,
    overview: section.overview,
    explanationField:
      section.kind === "slot" ? (section.explanationField ?? null) : null,
    kind: kind(),
  };
};

type ListView = CompiledEntity["inspector"]["list"]["views"][number];

const listViewJSON = (
  entity: string,
  view: ListView,
): ManifestWire<"ListView"> => {
  if (isSlotListView(view))
    return {
      slot: {
        id: `${entity}.${view.id}`,
        label: view.label,
        searchKeys: [...view.searchKeys],
      },
    };
  switch (view) {
    case "table":
      return { table: {} };
    case "shelf":
      return { shelf: {} };
    case "timeline":
      return { timeline: {} };
  }
};

const presentationJSON = (
  entity: string,
  presentation: CompiledEntity["inspector"],
) => {
  const { detail, list, edit } = presentation;
  // SAFETY: entity is a compiled declaration key, and the exhaustive connected-view roster covers every declaration key.
  const entityConnectedViews =
    connectedViews[entity as keyof typeof connectedViews];
  return {
    detailVariant: detail.variant,
    heroChip: detail.hero.chip ?? null,
    heroStats: [...detail.hero.stats],
    heroBreadcrumb: detail.hero.breadcrumb ?? null,
    heroImages: detail.hero.images,
    heroActions: [...detail.hero.actions],
    detailSections: detail.sections.map((section) =>
      detailSectionJSON(entity, section),
    ),
    connectedViews: entityConnectedViews.map((view) => ({
      key: view.key,
      title: view.title,
      target: view.target,
    })),
    listViews: list.views.map((view) => listViewJSON(entity, view)),
    listTotals: list.totals.map((total) => ({
      id: total.id,
      label: total.label,
      keys: [...total.keys],
      format: total.format,
    })),
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
    editSections: edit.sections.map((section) => ({
      id: section.id,
      title: section.title,
      fields: [...section.fields],
      collapsed: section.collapsed,
    })),
    editDateRanges: presentation.spans.map(({ start, end }) => ({
      start,
      end,
    })),
    savedViews: list.savedViews.map((view) => ({
      id: view.id,
      label: view.label,
      description: view.description,
      filters: view.filters.map((filter) => ({
        id: filter.id,
        values: Array.isArray(filter.value)
          ? [...filter.value]
          : [filter.value],
        isList: Array.isArray(filter.value),
      })),
      sort: (view.sort ?? []).map(({ id, desc }) => ({ id, desc })),
      flow:
        view.flow === null
          ? null
          : { kind: view.flow.kind, label: view.flow.label },
      columnVisibility: { ...view.layout?.columnVisibility },
      problemKey: view.problem?.key ?? null,
    })),
  };
};

const entityJSON = (
  entity: CompiledEntity,
  entityKey: EntityKeyLookup,
  entityForPrefix: EntityForPrefix,
): ManifestWire<"EntityDescriptor"> => {
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
    domain: entity.inspector.domain,
    sfSymbol: entity.inspector.icons.sfSymbol,
    emoji: entity.inspector.icons.emoji,
    recordEmojiField: entity.inspector.recordEmojiField,
    searchable,
    primarySearch,
    timeline: entity.timeline,
    fields: entity.fieldModel.fields.map((field) =>
      fieldJSON(field, entity.fieldModel, entityKey, entityForPrefix, context),
    ),
    filters: entity.filterDescriptors.map((filter) =>
      filterJSON(filter, entityKey, context),
    ),
    relations: entity.relations.map((relation) => ({
      key: relation.key,
      label: relation.label,
      target: entityKey(
        relation.target,
        `${context}.relations.${relation.key}`,
      ),
      cardinality: relation.cardinality,
    })),
    presentation: presentationJSON(entity.key, entity.inspector),
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
 * the declaration's `presentation` block, decoded by descriptor types generated from
 * `packages/schemas/src/manifest-wire.ts`, and
 * `EntityVocabulary.swift`, the `String` enums those descriptors decode, minted
 * here from the TS vocabulary so the two cannot drift.
 */
export const renderSwiftEntityCatalog = (
  entities: readonly CompiledEntity[],
): EntityArtifacts[] => {
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
  // Each Swift id enum lists the ids the declarations use, and the same ids must be
  // classified in `packages/schemas/src/native-coverage.ts` (the generated native-coverage.json).
  const coverageVocabulary = {
    control: rendererIds("control"),
    list: rendererIds("list"),
    detail: rendererIds("detail"),
    heroAction: used(
      entities.flatMap((entity) => entity.inspector.detail.hero.actions),
    ),
    detailSlot: used(
      entities.flatMap((entity) =>
        entity.inspector.detail.sections.flatMap((section) =>
          section.kind === "slot" ? [`${entity.key}.${section.id}`] : [],
        ),
      ),
    ),
    listSlot: used(
      entities.flatMap((entity) =>
        entity.inspector.list.views.flatMap((view) =>
          isSlotListView(view) ? [`${entity.key}.${view.id}`] : [],
        ),
      ),
    ),
    sectionAction: used(SECTION_ACTION_IDS),
  } as const;
  const classified = (
    kind: keyof typeof nativeCoverage,
    ids: readonly string[],
  ) => {
    const declared: Readonly<Record<string, NativeCoverageEntry>> =
      nativeCoverage[kind];
    return Object.fromEntries(
      ids.map((id) => {
        const entry = declared[id];
        if (entry === undefined)
          throw new Error(
            `packages/schemas/src/native-coverage.ts does not classify ${kind} ${JSON.stringify(id)}.`,
          );
        return [id, entry];
      }),
    );
  };
  // An `implemented` hero verb runs through exactly one plan, and only on entities the plan
  // names; a plan for a verb that is not `implemented` would be dead configuration.
  const plans: Readonly<Record<string, NativeHeroActionPlan>> =
    nativeHeroActionPlans;
  for (const [verb, entry] of Object.entries(nativeCoverage.heroAction)) {
    if ((entry.status === "implemented") !== verb in plans)
      throw new Error(
        `native-coverage.ts: hero action ${JSON.stringify(verb)} must be implemented exactly when nativeHeroActionPlans has a plan for it`,
      );
  }
  for (const entity of entities) {
    for (const verb of entity.inspector.detail.hero.actions) {
      const plan = plans[verb];
      if (plan === undefined || plan.kind === "delete") continue;
      if (!plan.entities.some((allowed) => allowed === entity.key))
        throw new Error(
          `native-coverage.ts: hero action ${JSON.stringify(verb)} on ${entity.key} is not in its plan's entities`,
        );
    }
  }
  // A collection verb runs through exactly one plan, and only on entities the plan names.
  const collectionPlans: Readonly<Record<string, NativeHeroActionPlan>> =
    nativeCollectionActionPlans;
  for (const action of COLLECTION_ACTIONS)
    if (collectionPlans[action]?.kind !== "operation")
      throw new Error(
        `native-coverage.ts: collection action ${JSON.stringify(action)} needs an operation plan`,
      );
  const nativeCoverageJSON = {
    control: classified("control", coverageVocabulary.control),
    list: classified("list", coverageVocabulary.list),
    detail: classified("detail", coverageVocabulary.detail),
    heroAction: classified("heroAction", coverageVocabulary.heroAction),
    detailSlot: classified("detailSlot", coverageVocabulary.detailSlot),
    listSlot: classified("listSlot", coverageVocabulary.listSlot),
    sectionAction: classified(
      "sectionAction",
      coverageVocabulary.sectionAction,
    ),
    heroActionPlan: nativeHeroActionPlans,
    collectionActionPlan: nativeCollectionActionPlans,
    collectionActionScope: COLLECTION_ACTION_SCOPES,
  };
  checkCatalogKeys(entities);

  const declaredKeys = new Set(entities.map(({ key }) => key));
  const entityKey: EntityKeyLookup = (raw, context) => {
    if (!declaredKeys.has(raw))
      throw new Error(
        `${context} names ${raw}, which is not a declared entity key.`,
      );
    return raw;
  };
  const entityForPrefix = entityPrefixLookup(entities);
  const vocabularyEnums: readonly VocabularyEnum[] = [
    { name: "EntityAction", cases: vocabularyCases(ACTION_ORDER) },
    { name: "EntityFieldKind", cases: vocabularyCases(entityFieldKinds) },
    {
      name: "EntityControlKind",
      cases: vocabularyCases(entityFieldControlKinds),
    },
    { name: "EntityFilterKind", cases: vocabularyCases(FILTER_KINDS) },
    {
      name: "ControlRendererID",
      cases: vocabularyCases(coverageVocabulary.control),
    },
    { name: "ListRendererID", cases: vocabularyCases(coverageVocabulary.list) },
    {
      name: "DetailRendererID",
      cases: vocabularyCases(coverageVocabulary.detail),
    },
    {
      name: "EntityHeroActionID",
      cases: vocabularyCases(coverageVocabulary.heroAction),
    },
    {
      name: "EntityDetailSlotID",
      cases: vocabularyCases(coverageVocabulary.detailSlot),
    },
    {
      name: "CollectionActionID",
      doc: "The verbs a report `records` block offers; each has a plan in `native-coverage.json`'s\n`collectionActionPlan` that `HeroActionRunner` executes.",
      cases: vocabularyCases(COLLECTION_ACTIONS),
    },
    {
      name: "SectionActionID",
      doc: "Finance verbs a report's `records` block may offer; `packages/schemas/src/entity-section-actions.ts`.",
      cases: vocabularyCases(coverageVocabulary.sectionAction),
    },
    {
      name: "EntityListSlotID",
      cases: vocabularyCases(coverageVocabulary.listSlot),
    },
    {
      name: "WayfindingDomain",
      doc: "The wayfinding lines, from `WAYFINDING_DOMAINS` in the entity definitions.",
      cases: vocabularyCases(WAYFINDING_DOMAINS),
    },
    {
      name: "ListPresentationChoice",
      doc: "The shared List / Cards / Compact control. Compact keeps the Cards URL view.",
      cases: swiftPresentationChoices.map((choice) => ({
        name: swiftCaseName(choice.swiftCase),
        raw: choice.swiftCase,
        label: choice.label,
      })),
    },
  ];
  const descriptors = entities.map((entity) =>
    entityJSON(entity, entityKey, entityForPrefix),
  );
  for (const descriptor of descriptors)
    assertManifestWire("EntityDescriptor", descriptor);
  return [
    {
      relativePath:
        "apps/apple/CubbyKit/Sources/CubbyKit/Generated/EntityDescriptors.swift",
      source: renderManifestWire(),
    },
    {
      relativePath:
        "apps/apple/CubbyKit/Sources/CubbyAPISupport/Generated/EntityKey.swift",
      source:
        generatedHeader +
        "// swift-format-ignore-file\n\n" +
        renderVocabularyEnum({
          name: "EntityKey",
          doc: "Every declared entity, keyed as the manifest spells it. The generated client's\n`Entity` schema is this enum (`typeOverrides` in openapi-generator-config.yaml).",
          cases: vocabularyCases(entities.map(({ key }) => key)),
        }),
    },
    {
      relativePath:
        "apps/apple/CubbyKit/Sources/CubbyKit/Generated/EntityVocabulary.swift",
      source:
        generatedHeader +
        "// swift-format-ignore-file\n\n" +
        vocabularyEnums.map(renderVocabularyEnum).join("\n"),
    },
    {
      relativePath:
        "apps/apple/CubbyKit/Sources/CubbyKit/Generated/entity-manifest.json",
      source: `${JSON.stringify(descriptors, null, 2)}\n`,
    },
    {
      relativePath:
        "apps/apple/CubbyKit/Sources/CubbyKit/Generated/native-coverage.json",
      source: `${JSON.stringify(nativeCoverageJSON, null, 2)}\n`,
    },
  ];
};
