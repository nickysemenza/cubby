/** The native manifest wire contract drives JSON validation and generated Swift Codable.
 * `?` allows omission; `~` carries null. Neither supplies a decode default. Initializer defaults
 * are separate. Keep catalog data bundled as JSON to avoid the Release/WMO COWArrayOpt stall.
 */
export const structuredTextFormats = [
  "uri",
  "date",
  "uuid",
  "email",
  "opaque",
] as const;

const codable = ["Codable", "Sendable"] as const;
const hashable = [...codable, "Hashable"] as const;
const identifiable = [...hashable, "Identifiable"] as const;
type RecordOptions = {
  conformances?: readonly string[];
  defaults?: Readonly<Record<string, string>>;
  wireOnly?: Readonly<Record<string, string>>;
};
const record = <const F extends Readonly<Record<string, string>>>(
  fields: F,
  options: RecordOptions = {},
) => ({
  kind: "struct" as const,
  fields,
  conformances: options.conformances ?? hashable,
  defaults: options.defaults,
  wireOnly: options.wireOnly,
});
const raw = <const C extends Readonly<Record<string, string>>>(
  cases: C,
  conformances: readonly string[] = hashable,
) => ({ kind: "raw" as const, cases, conformances });
const tagged = <
  const C extends Readonly<Record<string, Readonly<Record<string, string>>>>,
>(
  cases: C,
  conformances: readonly string[] = hashable,
  indirect = false,
) => ({ kind: "enum" as const, cases, conformances, indirect });

export const manifestWire = {
  CollectionActionScope: raw({ section: "section", row: "row" }, codable),
  LabeledOption: record(
    { value: "string", label: "string", color: "string?" },
    { defaults: { color: "nil" } },
  ),
  FieldReference: record({
    entity: "EntityKey",
    multiple: "boolean",
    scope: "[FieldReferenceScope]",
    filters: "[FieldReferenceFilter]",
  }),
  FieldReferenceScope: record({ sourceField: "string", targetField: "string" }),
  FieldReferenceFilter: record({ field: "string", values: "[string]" }),
  FieldExplanationDependency: record({ path: "string", label: "string" }),
  FieldExplanation: record(
    {
      ruleId: "string",
      version: "integer",
      description: "string",
      readPath: "string~",
      resolver: "string",
      projections: "[string:string]",
      sourceDependencies: "[FieldExplanationDependency]",
      actions: "[string]",
    },
    { conformances: codable },
  ),
  FieldSuggestionDescriptor: record(
    {
      reviewRequired: "boolean~",
      basis: "[string]",
      backedBy: "Json?",
      mode: "string~",
      rules: "[string]?",
    },
    { conformances: codable },
  ),
  FieldResolutionDescriptor: record(
    { reset: "[string:Json]", none: "[string:Json]~", redundancy: "string" },
    { conformances: codable },
  ),
  FieldDescriptor: record(
    {
      key: "string",
      columnId: "string~",
      readKey: "string~",
      valueOptions: "[LabeledOption]~",
      label: "string",
      kind: "EntityFieldKind",
      nullable: "boolean",
      reference: "FieldReference~",
      explanation: "FieldExplanation~",
      resolution: "FieldResolutionDescriptor~",
      controlKind: "EntityControlKind~",
      controlRenderer: "ControlRendererID~",
      controlWidth: "string~",
      controlOptions: "[LabeledOption]~",
      suggestion: "FieldSuggestionDescriptor~",
      placeholder: "string~",
      initial: "string~",
      initialValue: "Json~",
      controlRequired: "boolean~",
      valueSchema: "ValueSchema~",
      inCreate: "boolean",
      requiredOnCreate: "boolean",
      inUpdate: "boolean",
      showInList: "boolean",
      showInDetail: "boolean",
      detailOrder: "integer~",
      listOrder: "integer~",
      referencePreviewLimit: "integer~",
      listHidden: "boolean",
      width: "string~",
      format: "string~",
      readPath: "string~",
      labelPath: "string~",
      detailLabelPath: "string~",
      itemsPath: "string~",
      listRenderer: "ListRendererID~",
      detailRenderer: "DetailRendererID~",
      mobileSlot: "string~",
      mobilePriority: "integer~",
      mobileInteractive: "boolean",
    },
    { conformances: codable },
  ),
  FilterWire: tagged({
    param: { name: "string" },
    range: { from: "string", to: "string", presence: "string~" },
  }),
  FilterDescriptor: record(
    {
      columnId: "string",
      urlKey: "string",
      kind: "EntityFilterKind",
      placeholder: "string",
      label: "string~",
      options: "[LabeledOption]~",
      wire: "FilterWire",
      targetEntity: "EntityKey~",
    },
    { conformances: codable },
  ),
  SectionPlacement: raw({
    primary: "primary",
    supporting: "supporting",
    full: "full",
  }),
  SectionSort: record({ field: "string", direction: "SectionSort.Direction" }),
  "SectionSort.Direction": raw({ asc: "asc", desc: "desc" }),
  RelationSectionSpec: record({
    relation: "string",
    filterDescriptor: "string",
    prefill: "RelationSectionPrefill~",
    columns: "[string]~",
    sort: "SectionSort~",
    limit: "integer~",
    empty: "string~",
    hideWhenEmpty: "boolean",
    collapseWhenEmpty: "boolean",
  }),
  RelationSectionPrefill: record({ field: "string" }),
  TimelineSectionMode: raw({ events: "events", lifecycles: "lifecycles" }),
  DetailSection: record(
    {
      id: "string",
      title: "string~",
      placement: "SectionPlacement",
      collapsed: "boolean",
      explanationField: "string~",
      overview: "boolean",
      kind: "DetailSection.Kind",
    },
    { conformances: identifiable },
  ),
  "DetailSection.Kind": tagged({
    fields: { _0: "[string]" },
    relation: { _0: "RelationSectionSpec" },
    timeline: { mode: "TimelineSectionMode" },
    slot: {},
  }),
  DetailVariant: raw({ standard: "standard", journal: "journal" }),
  ListView: tagged(
    {
      table: {},
      shelf: {},
      timeline: {},
      slot: { id: "string", label: "string", searchKeys: "[string]" },
    },
    identifiable,
  ),
  TimelineLifecycle: record({
    start: "[string]",
    milestones: "[string]",
    end: "string~",
  }),
  EditSection: record(
    {
      id: "string",
      title: "string~",
      fields: "[string]",
      collapsed: "boolean",
    },
    { conformances: identifiable },
  ),
  ConnectedViewSpec: record(
    { key: "string", title: "string", target: "EntityKey" },
    { conformances: identifiable },
  ),
  EntityPresentation: record({
    detailVariant: "DetailVariant",
    heroChip: "string~",
    heroStats: "[string]",
    heroBreadcrumb: "string~",
    heroImages: "boolean",
    heroActions: "[EntityHeroActionID]",
    detailSections: "[DetailSection]",
    connectedViews: "[ConnectedViewSpec]",
    listViews: "[ListView]",
    listTotals: "[ListTotalDescriptor]",
    shelfSubtitle: "[string]",
    listActions: "[string]",
    timelineFields: "[string]",
    lifecycle: "TimelineLifecycle~",
    editSections: "[EditSection]",
    editDateRanges: "[EditDateRange]",
    savedViews: "[SavedView]",
  }),
  EditDateRange: record({ start: "string", end: "string" }),
  SavedViewFilter: record({
    id: "string",
    values: "[string]",
    isList: "boolean",
  }),
  SavedViewSort: record({ id: "string", desc: "boolean" }),
  SavedViewFlow: record({ kind: "string", label: "string" }),
  SavedView: record(
    {
      id: "string",
      label: "string",
      description: "string",
      filters: "[SavedViewFilter]",
      sort: "[SavedViewSort]",
      flow: "SavedViewFlow~",
      columnVisibility: "[string:boolean]",
      problemKey: "string~",
    },
    { conformances: identifiable },
  ),
  ListTotalFormat: raw({
    currency: "currency",
    currencyRange: "currencyRange",
    integer: "integer",
  }),
  ListTotalDescriptor: record(
    {
      id: "string",
      label: "string",
      keys: "[string]",
      format: "ListTotalFormat",
    },
    { conformances: identifiable, defaults: {} },
  ),
  RelationCardinality: raw({ one: "one", many: "many" }),
  RelationDescriptor: record({
    key: "string",
    label: "string",
    target: "EntityKey",
    cardinality: "RelationCardinality",
  }),
  EntityTimelineMode: raw({ default: "default", custom: "custom" }),
  PrimarySearchDescriptor: record({ key: "string", placeholder: "string" }),
  EntityDescriptor: record(
    {
      key: "EntityKey",
      singular: "string",
      plural: "string",
      basePath: "string",
      shortcodePrefix: "string~",
      titleField: "string",
      sortFields: "[string]",
      domain: "WayfindingDomain~",
      sfSymbol: "string",
      emoji: "string",
      recordEmojiField: "string~",
      recordIconEntityField: "string~",
      searchable: "boolean",
      primarySearch: "PrimarySearchDescriptor~",
      timeline: "EntityTimelineMode~",
      fields: "[FieldDescriptor]",
      filters: "[FilterDescriptor]",
      relations: "[RelationDescriptor]",
      presentation: "EntityPresentation",
    },
    { conformances: codable },
  ),
  ValueSchema: record(
    {
      nullable: "boolean",
      node: "ValueSchema.Node",
      createOnly: "boolean?",
      notice: "string?",
    },
    { defaults: { nullable: "false", createOnly: "nil", notice: "nil" } },
  ),
  "ValueSchema.Node": tagged(
    {
      text: { format: "StructuredTextFormat~" },
      number: { integer: "boolean" },
      boolean: {},
      enum: { options: "[LabeledOption]" },
      reference: { entity: "EntityKey" },
      amount: { upper: "boolean" },
      constant: { value: "Json" },
      object: { fields: "[ValueSchema.Field]" },
      array: { item: "ValueSchema" },
      map: { keys: "[LabeledOption]", value: "ValueSchema" },
      variant: { discriminator: "string", cases: "[ValueSchema.Case]" },
    },
    hashable,
    true,
  ),
  "ValueSchema.Field": record(
    {
      key: "string",
      label: "string",
      required: "boolean",
      schema: "ValueSchema",
      readPath: "string?",
    },
    { defaults: { readPath: "nil" } },
  ),
  "ValueSchema.Case": record({
    value: "string",
    label: "string",
    fields: "[ValueSchema.Field]",
  }),
} as const;

import type { z } from "zod";

export type ManifestWireName = keyof typeof manifestWire;
type DeepReadonly<T> = T extends readonly (infer V)[]
  ? readonly DeepReadonly<V>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

type Definition<N extends ManifestWireName> = (typeof manifestWire)[N];
type Fields<F> = keyof F extends never
  ? Readonly<Record<string, never>>
  : {
      readonly [
        K in keyof F as F[K] extends `${string}?` ? never : K
      ]: F[K] extends string ? WireValue<F[K]> : never;
    } & {
      readonly [
        K in keyof F as F[K] extends `${string}?` ? K : never
      ]?: F[K] extends `${infer T}?` ? WireValue<T> : never;
    };
export type WireValue<T extends string> = T extends `${infer V}~`
  ? WireValue<V> | null
  : T extends `${infer V}?`
    ? WireValue<V> | undefined
    : T extends `[string:${infer V}]`
      ? { readonly [key: string]: WireValue<V> }
      : T extends `[${infer V}]`
        ? readonly WireValue<V>[]
        : T extends "StructuredTextFormat"
          ? (typeof structuredTextFormats)[number]
          : T extends
                | "string"
                | "EntityKey"
                | "EntityFieldKind"
                | "EntityControlKind"
                | "ControlRendererID"
                | "ListRendererID"
                | "DetailRendererID"
                | "EntityFilterKind"
                | "EntityHeroActionID"
                | "WayfindingDomain"
            ? string
            : T extends "integer"
              ? number
              : T extends "boolean"
                ? boolean
                : T extends "Json"
                  ? DeepReadonly<z.core.util.JSONType>
                  : T extends ManifestWireName
                    ? ManifestWire<T>
                    : never;

export type ManifestWire<N extends ManifestWireName> =
  Definition<N> extends { readonly kind: "struct"; readonly fields: infer F }
    ? Fields<F>
    : Definition<N> extends { readonly kind: "raw"; readonly cases: infer C }
      ? C[keyof C]
      : Definition<N> extends { readonly kind: "enum"; readonly cases: infer C }
        ? {
            [K in keyof C]: { readonly [P in K]: Fields<C[K]> };
          }[keyof C]
        : never;
