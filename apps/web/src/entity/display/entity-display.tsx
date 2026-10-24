import type { AuditEntityKind } from "@cubby/schemas/audit";
import {
  classificationFieldRefusal,
  classificationFieldDisplayRefusal,
} from "@cubby/schemas/classification-field-policy";
import { amount as amountSchema } from "@cubby/schemas/codec";
import {
  storedDateRangeSchema,
  type CalendarDateRange,
} from "@cubby/schemas/date-range";
import {
  type Entity,
  type EntityRef,
  entitySchema,
} from "@cubby/schemas/entity";
import { displayItems } from "@cubby/schemas/entity-definitions/label-field";
import {
  entityFieldModels,
  type EntityFieldModel,
} from "@cubby/schemas/entity-fields";
import {
  entityManifest,
  type BrowserRoutedEntity,
} from "@cubby/schemas/entity-manifest";
import { entityPreviewFieldKeys } from "@cubby/schemas/entity-preview";
import { generatedEntitySort } from "@cubby/schemas/entity-sort";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { resolvedListSchema } from "@cubby/schemas/field-resolution";
import { flexRender } from "@tanstack/react-table";
import prettyBytes from "pretty-bytes";
import { Fragment, type ReactNode } from "react";
import { z } from "zod";

import {
  EntityRefLink,
  EntityFilterLink,
} from "~/entity/components/entity-ref-link";
import { ReferencePreview } from "~/entity/components/reference-preview";
import { referenceScopeFor } from "~/entity/editing/reference-scope";
import {
  fieldQualityChecks,
  useFieldQuality,
  QualityResult,
  QualityCheckDetails,
} from "~/entity/entity-detail/record-quality";
import { EntityDisplayImagesProvider } from "~/entity/entity-media/entity-display-images";
import { NotApplicableField } from "~/entity/fields/field-applicability";
import { getEntityFilters } from "~/entity/filter-manifest";
import { filterUrlKey } from "~/entity/filters";
import { referenceEntitySearch } from "~/entity/picker/reference-entity-search";
import { ShortcodeProse } from "~/entity/prose/shortcode-prose";
import { RecordFieldSuggestion } from "~/entity/suggestions/record-suggestions";
import {
  createEditableAccessorColumn,
  renderOptionCell,
} from "~/entity/table/column-helpers";
import {
  EditableCell,
  EditableDateRangeCell,
  type PickerOption,
} from "~/entity/table/editable-cell";
import { EditableEntityCell } from "~/entity/table/editable-entity-cell";
import { formatCurrency } from "~/lib/number-format";
import { cn } from "~/lib/utils";
import { isReferencePickerEntity } from "~/ui/combobox/reference-picker-entities";
import { CurrencyValue } from "~/ui/common/currency-value";
import { DateDisplay } from "~/ui/common/date-display";
import { AddFactValue, type Fact, Facts, useFactsAdd } from "~/ui/common/facts";
import { RecordList, RecordRow } from "~/ui/common/record-list";
import {
  NumberValue,
  renderScalarValue,
  type ScalarDisplayValue,
} from "~/ui/common/scalar-value";
import type { CellClipboardSpec } from "~/ui/data-table/cell-clipboard";
import { dateRangeCellData } from "~/ui/data-table/cell-data";
import {
  type ColumnCellData,
  type PasteFieldValues,
  booleanCellData,
  dateCellData,
  entityCellData,
  numberCellData,
  selectCellData,
  specFromCellData,
  textCellData,
  timestampCellData,
} from "~/ui/data-table/cell-data";
import {
  createCubbyColumnCollection,
  type CubbyColumnCollection,
  type CubbyColumnHelper,
  type CubbyColumnDef,
} from "~/ui/data-table/table-features";
import {
  attachCubbyColumnMeta,
  type MobileColumnMeta,
} from "~/ui/data-table/table-meta";
import { CellMagnitudeBar } from "~/ui/data-table/visuals/cell-visual";
import { ExternalLinkText } from "~/ui/external-link";
import { Button } from "~/ui/primitives/button";
import { Checkbox } from "~/ui/primitives/checkbox";
import { NoneValue } from "~/ui/primitives/none-value";
import { tryFormatAmount } from "~/ui/text/format-amount";

import { columnHeaderFor } from "../column-header";
import { recordFieldClearing } from "../editing/field-clearing";
import {
  entities,
  entityPluralLabel,
  isBrowserRoutedEntity,
} from "../entities";
import {
  readDisplayReferenceField,
  readReferenceField,
  type ReferenceItem,
} from "../entity-references";
import { FieldExplanationContents } from "../fields/field-explanation";
import {
  FieldResolutionBadge,
  fieldResolutionFor,
  InheritedMarker,
  resolutionPolicyFor,
} from "../fields/field-resolution";
import { CategoryLabelById } from "../presentation/category-label";
import { SpendingCategoryLabel } from "../presentation/spending-category-label";
import { readPathValue } from "../read-path";
import { compactFieldRendererFor } from "./compact-field-renderers";
import {
  enumDisplayValue,
  enumFieldOptions,
  enumFieldSuggestSource,
} from "./enum-field-display";
import { listRendererColumns } from "./list-field-renderers";

type DisplayField = EntityFieldModel["fields"][number];
type DisplaySurface = "list" | "detail";
const proseFieldKeys = new Set([
  "notes",
  "description",
  "aiDescription",
  "summary",
  "detail",
  "reason",
  "comment",
  "message",
]);
const isProseField = (key: string, control: DisplayField["control"]) =>
  control?.kind === "textarea" || proseFieldKeys.has(key);

function renderProseValue(value: ScalarDisplayValue, surface: DisplaySurface) {
  if (value.kind !== "text") return renderScalarValue(value, surface);
  if (!value.label)
    return surface === "detail" ? "Not recorded" : <NoneValue />;
  return surface === "list" ? (
    <span className="block truncate" title={value.label}>
      <ShortcodeProse>{value.label}</ShortcodeProse>
    </span>
  ) : (
    <span className="break-words whitespace-pre-wrap">
      <ShortcodeProse>{value.label}</ShortcodeProse>
    </span>
  );
}
const explainedRecordSchema = z.object({ id: z.string() });
const entityDisplayFields = (entity: Entity, surface: DisplaySurface) =>
  entityFieldModels[entity].fields.filter((field) => field.display[surface]);

/**
 * Columns hidden by default (`display.listHidden`) but still toggleable via
 * the View menu — the one per-field fact a page's old `initialColumnVisibility`
 * literal genuinely carried; everything else in those objects was either a
 * plain columnId echo of a `display.list` field (redundant) or a computed/
 * relation column outside the field model (which this cannot see and a page
 * must keep declaring itself). Callers merge this into their own
 * `initialColumnVisibility` rather than replacing it outright.
 */
export const entityListHiddenColumns = (
  entity: Entity,
): Record<string, boolean> =>
  Object.fromEntries(
    entityDisplayFields(entity, "list")
      .filter((field) => field.display.listHidden)
      .map((field) => [field.display.columnId ?? field.key, false]),
  );

/** Declared `listOrder` first, ascending; unordered fields keep model order. */
const orderedListFields = (entity: Entity): DisplayField[] =>
  entityDisplayFields(entity, "list")
    .map((field, index) => ({ field, index }))
    .sort(
      (left, right) =>
        (left.field.display.listOrder ?? Number.MAX_SAFE_INTEGER) -
          (right.field.display.listOrder ?? Number.MAX_SAFE_INTEGER) ||
        left.index - right.index,
    )
    .map(({ field }) => field);

/**
 * Buckets a declared `display.width` into the shared table's fixed-layout
 * class. Four buckets can't reproduce every hand-tuned pixel width in the app
 * (observed widths run from `w-20` to `w-64`); each bucket picks the class
 * closest to its cluster's center rather than the extremes, so this is a
 * deliberate approximation, not a literal replay of any one column's class.
 */
function widthClassName(
  width: DisplayField["display"]["width"],
  kind?: DisplayField["kind"],
): string | undefined {
  // A date column ignores its bucket: the shared date width keeps
  // `formatDateSpan`'s relative context unclipped.
  if (kind === "date") return undefined;
  switch (width) {
    case "xs":
      return "w-20";
    case "sm":
      return "w-28";
    case "md":
      return "w-40";
    case "lg":
      return "w-56";
    case null:
      return undefined;
  }
}

/** The labels `presence` falls back to when the field declares no roster. */
const PRESENCE_OPTIONS: PickerOption[] = [
  { value: "yes", label: "Yes", color: "var(--slate)" },
  { value: "no", label: "No", color: "var(--muted-foreground)" },
];

/** Whether a value is "there": true, a non-empty string or a non-empty list. */
function isPresent(value: ScalarDisplayValue): boolean {
  switch (value.kind) {
    case "empty":
      return false;
    case "boolean":
      return value.raw;
    case "list":
      return value.raw.length > 0;
    case "json":
      return Array.isArray(value.raw)
        ? value.raw.length > 0
        : value.raw !== null && value.raw !== undefined;
    case "text":
      return value.raw !== "";
    default:
      return true;
  }
}

/** The array behind a list or a JSON array value, else null. */
function listItems(value: ScalarDisplayValue): readonly unknown[] | null {
  if (value.kind === "list") return value.raw;
  if (value.kind === "json" && Array.isArray(value.raw)) return value.raw;
  return null;
}

/**
 * Renders a declared scalar per its `display.format`, falling back to the
 * kind-derived default ({@link renderScalarValue}) when no format is set or
 * the value's runtime kind doesn't match the declared formatter (an "empty"
 * value always short-circuits, regardless of format).
 */
function renderFormattedScalar(
  format: DisplayField["display"]["format"],
  value: ScalarDisplayValue,
  surface: "list" | "detail" = "list",
  context?: { entity: Entity; field: DisplayField },
): ReactNode {
  // Presence answers "is there one" — an empty value is a clear "no", not a dash.
  if (format === "presence") {
    const options = context?.field.display.valueOptions
      ? enumFieldOptions(context.entity, context.field)
      : PRESENCE_OPTIONS;
    return renderOptionCell(isPresent(value) ? "yes" : "no", options);
  }
  if (value.kind === "empty")
    return (
      context?.field.display.emptyLabel ??
      (surface === "detail"
        ? "Not recorded"
        : renderScalarValue(value, surface))
    );
  switch (format) {
    // Known counts read literally: `0` is a fact, never a dash.
    case "count":
      return value.kind === "number" ? (
        <span className="tabular-nums">
          <NumberValue value={value.raw} />
        </span>
      ) : (
        renderScalarValue(value, surface)
      );
    case "arrayCount": {
      const items = listItems(value);
      return items ? (
        <span className="tabular-nums">{items.length}</span>
      ) : (
        renderScalarValue(value, surface)
      );
    }
    case "bytes":
      return value.kind === "number" ? (
        <span className="tabular-nums">{prettyBytes(value.raw)}</span>
      ) : (
        renderScalarValue(value, surface)
      );
    case "join": {
      const items = listItems(value);
      if (!items) return renderScalarValue(value, surface);
      const joined = items.map(String).join(", ");
      return joined ? (
        <span className="text-xs text-muted-foreground">{joined}</span>
      ) : (
        <NoneValue />
      );
    }
    // Money is ink; a credit (negative, sign printed) is the only green
    // and a zero is muted — `CurrencyValue` owns that tone for both formats.
    case "currency":
    case "signedCurrency":
      return value.kind === "number" ? (
        <CurrencyValue value={value.raw} />
      ) : (
        renderScalarValue(value, surface)
      );
    case "plainDate":
      return renderScalarValue(
        {
          kind: "date",
          raw: value.kind === "date" ? value.raw : String(value.raw),
          due: value.kind === "date" ? value.due : undefined,
        },
        surface,
      );
    case "timestamp":
      return renderScalarValue(
        {
          kind: "timestamp",
          raw: value.kind === "timestamp" ? value.raw : String(value.raw),
        },
        surface,
      );
    case "external-link": {
      const href = value.kind === "text" ? value.raw : String(value.raw);
      return href ? <ExternalLinkText href={href} truncate /> : <NoneValue />;
    }
    // A `{ value, unit }` measure; anything else declared `amount` falls back
    // to the kind-derived rendering rather than crashing the page.
    case "amount": {
      const parsed =
        value.kind === "json" ? amountSchema.safeParse(value.raw) : null;
      return parsed?.success ? (
        <span className="tabular-nums">{tryFormatAmount(parsed.data)}</span>
      ) : (
        renderScalarValue(value, surface)
      );
    }
    case "resolvedList": {
      const parsed = resolvedListSchema.safeParse(value.raw);
      if (!parsed.success) return renderScalarValue(value, surface);
      return parsed.data.length === 0 ? (
        (context?.field.display.emptyLabel ?? <NoneValue />)
      ) : (
        <span className="inline-flex max-w-full min-w-0 items-center overflow-hidden whitespace-pre">
          {parsed.data.map((item, index) => (
            <Fragment key={item.ref?.entityId ?? item.label}>
              {index > 0 ? <span aria-hidden="true">, </span> : null}
              <span
                className={cn(
                  "inline-flex min-w-0 items-center gap-1",
                  item.inherited && "text-muted-foreground",
                )}
              >
                {item.ref ? (
                  referenceLink(
                    item.ref.entityKind,
                    { id: item.ref.entityId, name: item.label },
                    true,
                  )
                ) : (
                  <span className="truncate">{item.label}</span>
                )}
                {item.inherited ? <InheritedMarker /> : null}
              </span>
            </Fragment>
          ))}
        </span>
      );
    }
    case null:
      return renderScalarValue(value, surface);
  }
}

/** A resolved field whose effective value is empty names what that means
 * (an owner field reads Household or Unknown, not a dash). */
function resolutionEmptyLabel(
  entity: Entity,
  record: unknown,
  field: DisplayField,
  explainMissing = false,
): ReactNode {
  const resolution = fieldResolutionFor(record, field.key);
  if (!resolution || resolution.value !== null) return null;
  // Allocations have multiple reference values rather than one scalar value.
  if (resolution.mode === "allocated") return null;
  const labels = resolutionPolicyFor(entity, field.key)?.labels;
  const label =
    resolution.mode === "inherit" ? labels?.unresolved : labels?.none;
  const text = label ?? (explainMissing ? resolution.source : null);
  return text ? <span className="text-muted-foreground">{text}</span> : null;
}

/**
 * The declaration's `mobile.slot` is a plain string — it's just the slot name
 * a `.entity.ts` author typed, not the shared table's own `MobileSlot` union —
 * so this is the one place that trusts a declared slot name at the table's
 * boundary rather than plumbing the union type back through the generator.
 */
function toMobileColumnMeta(
  mobile: DisplayField["display"]["mobile"],
): MobileColumnMeta | undefined {
  if (!mobile) return undefined;
  return {
    // SAFETY: entity declarations only ever write one of MobileColumnMeta's
    // own slot literals (compile.ts requires a nonempty string, not a real
    // enum) — this is the declared-metadata boundary that trusts that.
    slot: mobile.slot as MobileColumnMeta["slot"],
    priority: mobile.priority,
    interactive: mobile.interactive,
  };
}

// A structured array behind a `text-array` kind (product `externalIds` reads
// as objects) renders as readable JSON unless a domain renderer claims it.
const listOrJson = z.union([
  z.array(z.string()).transform((raw) => ({ kind: "list" as const, raw })),
  z.unknown().transform((raw) => ({ kind: "json" as const, raw })),
]);
const readListValue = (value: unknown): ScalarDisplayValue =>
  listOrJson.parse(value);

const pathScalar = z.union([
  z.boolean().transform((raw) => ({ kind: "boolean" as const, raw })),
  z.number().transform((raw) => ({ kind: "number" as const, raw })),
  z.string().transform((raw) => ({ kind: "text" as const, raw, label: raw })),
  z.array(z.string()).transform((raw) => ({ kind: "list" as const, raw })),
  z.unknown().transform((raw) => ({ kind: "json" as const, raw })),
]);
/** A scalar read off a `display.readPath`, typed by what the row holds. */
function pathScalarValue(
  entity: Entity,
  field: DisplayField,
  value: unknown,
): ScalarDisplayValue {
  const scalar = pathScalar.parse(value);
  if (scalar.kind !== "text") return scalar;
  if (field.kind === "date") return { kind: "date", raw: scalar.raw };
  if (field.kind === "timestamp") return { kind: "timestamp", raw: scalar.raw };
  return field.display.valueOptions
    ? enumDisplayValue(entity, field, scalar.raw)
    : scalar;
}

/** An editable stored field with nothing in it: the detail page offers "Add…". */
function isAddableEmpty<TRecord extends object>(
  entity: Entity,
  record: TRecord,
  field: DisplayField,
) {
  if (!field.control || (!field.readKey && field.display.readPath === null))
    return false;
  const value = readScalarField(entity, record, field);
  return (
    value.kind === "empty" ||
    (value.kind === "text" && value.raw.trim() === "") ||
    (value.kind === "list" && value.raw.length === 0)
  );
}

function readScalarField<TRecord extends object>(
  entity: Entity,
  record: TRecord,
  field: DisplayField,
): ScalarDisplayValue {
  const readPath = field.display.readPath;
  if (!field.readKey && readPath === null)
    throw new Error(`Display field ${field.key} needs a renderer`);
  // SAFETY: The generated model owns the read key; its scalar schema checks the value
  // before rendering, including absent fields in partial detail responses.
  const stored =
    readPath !== null
      ? readPathValue(record, readPath)
      : record[field.readKey as keyof TRecord];
  // Read surfaces display the canonical value, including system rules that
  // supersede a stored override. Editors retain the stored assignment intent.
  const resolution = fieldResolutionFor(record, field.key);
  const value = resolution ? resolution.value : stored;
  if (value === undefined || value === null)
    return { kind: "empty", raw: value === undefined ? undefined : null };
  // A path-backed value is projected off a nested row, so its runtime shape is
  // the authority; the declared kind only disambiguates dates and timestamps,
  // and a declared roster tints a string like any enum.
  if (readPath !== null) return pathScalarValue(entity, field, value);
  switch (field.kind) {
    case "text": {
      const raw = z.string().parse(value);
      return { kind: "text", raw, label: raw };
    }
    case "enum":
      return enumDisplayValue(entity, field, z.string().parse(value));
    case "number":
      return { kind: "number", raw: z.number().parse(value) };
    case "boolean":
      return { kind: "boolean", raw: z.boolean().parse(value) };
    case "date":
      return { kind: "date", raw: z.string().parse(value) };
    case "timestamp":
      return {
        kind: "timestamp",
        raw: z.union([z.string(), z.date()]).parse(value),
      };
    case "text-array":
      return readListValue(value);
    // A reference reads as its shortcode(s) here; `readReferenceField` below
    // resolves the linked record for the detail surface.
    case "identifier": {
      if (field.reference?.multiple)
        return { kind: "list", raw: z.array(z.string()).parse(value) };
      const raw = z.string().parse(value);
      return { kind: "text", raw, label: raw };
    }
    // A structured value renders as readable JSON unless a domain renderer
    // claims it; the detail page never crashes on an undeclared shape.
    case "dateRange":
    case "json":
      return { kind: "json", raw: value };
  }
}

function copyScalarField<TRecord extends object>(
  entity: Entity,
  record: TRecord,
  field: DisplayField,
): string | null {
  const value = readScalarField(entity, record, field);
  switch (value.kind) {
    case "empty":
      return null;
    case "list":
      return value.raw.join(", ");
    case "timestamp":
      return new Date(value.raw).toISOString();
    case "json":
      return JSON.stringify(value.raw);
    default:
      return String(value.raw);
  }
}

/** Routed manifest reference targets whose shortcode is a display-image ref. */
const referenceMediaEntity = (entity: string): BrowserRoutedEntity | null =>
  // SAFETY: a manifest reference target is always a declared entity key.
  isBrowserRoutedEntity(entity as Entity) && entity !== "usda-food"
    ? (entity as BrowserRoutedEntity)
    : null;

/** The display-image refs a reference field names on one record. */
export function referenceMediaRefs<TRecord extends object>(
  record: TRecord,
  field: DisplayField,
): EntityRef[] {
  const reference = readDisplayReferenceField(record, field);
  const entityKind = reference && referenceMediaEntity(reference.entity);
  if (!reference || entityKind === null) return [];
  return reference.items.map((item) => ({ entityKind, entityId: item.id }));
}

function referenceBrowse<TRecord extends object>(
  record: TRecord,
  field: DisplayField,
): ReactNode {
  const target = field.reference
    ? referenceMediaEntity(field.reference.entity)
    : null;
  if (
    !target ||
    !isBrowserRoutedEntity(target) ||
    field.control ||
    !field.reference?.multiple ||
    !field.reference.scope.length
  )
    return null;
  const data = z.record(z.string(), z.unknown()).parse(record);
  const search = new URLSearchParams();
  for (const binding of field.reference.scope) {
    const spec = getEntityFilters(target).find(
      (item) =>
        item.field === binding.targetField ||
        item.columnId === binding.targetField,
    );
    const value = z.string().safeParse(data[binding.sourceField]);
    if (spec && value.success) search.set(filterUrlKey(spec), value.data);
  }
  return search.size ? (
    <a
      className="text-primary underline"
      href={`/${entities[target].basePath}?${search}`}
    >
      View all
    </a>
  ) : null;
}

function referenceLink(
  entity: string,
  item: ReferenceItem,
  compact = false,
): ReactNode {
  const routed = referenceMediaEntity(entity);
  if (routed === null)
    return <span className="font-mono text-xs">{item.name ?? item.id}</span>;
  // A compact category reference reads as its full-path pill, like the
  // category's own list cell (`compactFieldRendererFor`).
  if (compact && routed === "productCategory")
    return <CategoryLabelById id={item.id} />;
  if (routed === "spendingCategory")
    return (
      <SpendingCategoryLabel id={item.id} name={item.name} emoji={item.emoji} />
    );
  return (
    <EntityRefLink
      entity={routed}
      id={item.id}
      name={item.name}
      emoji={item.emoji}
    />
  );
}

/** Render a proposed scalar with the same compact field renderer used by its
 * list cell. Reference values resolve their human label through the shared
 * by-id link instead of exposing an internal UUID or public code. */
export function renderSuggestedListFieldValue<TRecord extends { id: string }>(
  entity: Entity,
  record: TRecord,
  fieldKey: string,
  value: z.infer<ReturnType<typeof z.json>>,
  label?: string,
): ReactNode {
  if (value === null || value === "") return <NoneValue />;
  const field = entityFieldModels[entity].fields.find(
    (candidate) => candidate.key === fieldKey,
  );
  if (!field) return String(value ?? "—");
  const readKey = field.readKey ?? field.key;
  // A proposal must not inherit the current value's resolved projection,
  // nested reference labels, allocations, or field resolution.
  const proposedRecord = {
    id: record.id,
    [field.key]: value,
    [readKey]: value,
  };
  // A domain renderer (a category's full-path pill) wins over the generic
  // reference link. It sees only the proposed value: the row's own resolved
  // projection describes the current value, not this one.
  const domain = compactFieldRendererFor(entity, fieldKey)?.(proposedRecord, {
    label,
  });
  if (domain !== undefined) return domain;
  const referenceId = z.string().safeParse(value);
  if (field.reference && referenceId.success) {
    // SAFETY: the entity reference target is declared by this field's
    // manifest entry and is a member of the audit entity-kind roster.
    const entityKind = field.reference.entity as AuditEntityKind;
    return (
      <EntityRefLink entity={entityKind} id={referenceId.data} name={label} />
    );
  }
  if (
    label &&
    !field.reference?.multiple &&
    !enumFieldOptions(entity, field).some((option) => option.value === value)
  )
    return <span className="min-w-0 truncate">{label}</span>;
  return renderCompactFieldValue(entity, proposedRecord, field, {
    singleLine: true,
  });
}

/** What a `display.labelPath` / `detailLabelPath` read may carry: text, or a `[]` projection of text. */
const labelValue = z.union([z.string().min(1), z.array(z.string()).min(1)]);

/** The text the record carries at a declared label path, or `null` when it has none. */
function readLabel<TRecord extends object>(
  record: TRecord,
  path: string,
): string | null {
  const parsed = labelValue.safeParse(readPathValue(record, path));
  if (!parsed.success) return null;
  return Array.isArray(parsed.data) ? parsed.data.join(", ") : parsed.data;
}

/** Reference fields link to the target's detail route; a field with a
 * `detailLabelPath` prints the text the server composed for it; everything
 * else renders through its declared `display.format`. */
export function renderDetailFieldValue<TRecord extends object>(
  entity: Entity,
  record: TRecord,
  field: DisplayField,
): ReactNode {
  const refusal = classificationFieldDisplayRefusal(entity, record, field.key);
  if (refusal) return <NotApplicableField reason={refusal} />;
  if (field.kind === "dateRange") return renderDateRangeValue(record, field);
  const emptyLabel = resolutionEmptyLabel(entity, record, field, true);
  if (emptyLabel) return emptyLabel;
  if (field.display.itemsPath) {
    const parsed = displayItems.safeParse(
      readPathValue(record, field.display.itemsPath),
    );
    const items = parsed.success ? (parsed.data ?? []) : [];
    if (items.length === 0) return "Not recorded";
    return (
      <RecordList>
        {items.map((item) => (
          <RecordRow
            key={JSON.stringify(item)}
            primary={
              item.entity && item.id
                ? referenceLink(item.entity, { id: item.id, name: item.title })
                : item.title
            }
            secondary={item.subtitle}
            trailing={item.trailing}
            clip={false}
          />
        ))}
      </RecordList>
    );
  }
  if (field.display.detailLabelPath) {
    const label = readLabel(record, field.display.detailLabelPath);
    return label === null ? (
      <>Not recorded</>
    ) : (
      <span className="whitespace-pre-line">{label}</span>
    );
  }
  const reference = readDisplayReferenceField(record, field);
  if (reference !== null) {
    if (
      reference.items.length === 0 &&
      !reference.unclassifiedAllocations?.length
    )
      return reference.incomplete ? (
        <span>Unclassified</span>
      ) : (
        <>Not recorded</>
      );
    return (
      <>
        {referenceBrowse(record, field)}
        <ReferencePreview
          items={reference.items}
          limit={field.display.referencePreviewLimit}
          renderItem={(item) => (
            <span className="flex items-center gap-2">
              {referenceLink(reference.entity, item)}
              {item.amount !== undefined && (
                <span className="tabular-nums">
                  {item.amount === null
                    ? "Unpriced"
                    : formatCurrency(item.amount)}
                </span>
              )}
            </span>
          )}
        />
        {!!reference.unclassifiedAllocations?.length && (
          <span className="text-muted-foreground">
            Unclassified ·{" "}
            {reference.unclassifiedAllocations
              .map((share) =>
                share.amount == null
                  ? "Unpriced"
                  : formatCurrency(share.amount),
              )
              .join(", ")}
          </span>
        )}
        {reference.incomplete && !reference.unclassifiedAllocations?.length && (
          <span className="text-muted-foreground">Partly unclassified</span>
        )}
      </>
    );
  }
  if (isProseField(field.key, field.control) && field.display.format === null)
    return renderProseValue(readScalarField(entity, record, field), "detail");
  return renderFormattedScalar(
    field.display.format,
    readScalarField(entity, record, field),
    "detail",
    { entity, field },
  );
}

/** Dense surfaces prefer a row-backed domain value before scalar fallback. */
export function renderCompactFieldValue<TRecord extends object>(
  entity: Entity,
  record: TRecord,
  field: DisplayField,
  { singleLine = false }: { singleLine?: boolean } = {},
): ReactNode {
  const domainRenderer = compactFieldRendererFor(entity, field.key);
  const domainValue = domainRenderer?.(record);
  if (domainValue !== undefined) return domainValue;
  if (field.kind === "dateRange") return renderDateRangeValue(record, field);
  const emptyLabel = resolutionEmptyLabel(entity, record, field);
  if (emptyLabel) return emptyLabel;
  const reference = readDisplayReferenceField(record, field);
  if (reference !== null) {
    if (reference.items.length === 0)
      return reference.incomplete ? <span>Unclassified</span> : <NoneValue />;
    if (singleLine)
      return (
        <ReferencePreview
          items={reference.items}
          limit={field.display.referencePreviewLimit}
          renderItem={(item) => referenceLink(reference.entity, item, true)}
          singleLine
          trailing={
            reference.incomplete ? (
              <span className="text-muted-foreground">Partly unclassified</span>
            ) : (
              referenceBrowse(record, field)
            )
          }
        />
      );
    return (
      <>
        {referenceBrowse(record, field)}
        <ReferencePreview
          items={reference.items}
          limit={field.display.referencePreviewLimit}
          renderItem={(item) => referenceLink(reference.entity, item)}
        />
        {reference.incomplete && (
          <span className="text-muted-foreground">Partly unclassified</span>
        )}
      </>
    );
  }
  const value = readScalarField(entity, record, field);
  if (isProseField(field.key, field.control) && field.display.format === null)
    return renderProseValue(value, "list");
  return renderFormattedScalar(field.display.format, value, "list", {
    entity,
    field,
  });
}

/** Real phone targets keep adjacent filter and explanation hit areas disjoint. */
const LEDGER_FILTER_ACTION_CLASS = "size-11 md:size-6";

/** Filter kinds whose URL value is one option or one id. */
const COHORT_FILTER_KINDS = new Set(["multiselect", "idMulti"]);

/**
 * The list filter a detail field can seed: a descriptor on the same entity
 * whose `field`/`columnId` names the field (or the key minus `Id` for a
 * reference, `ingredientId` → `ingredient`) and whose kind takes one value.
 */
function cohortFilterSpecFor(entity: Entity, field: DisplayField) {
  const base = field.key.replace(/Ids?$/u, "");
  return (
    getEntityFilters(entity).find(
      (spec) =>
        COHORT_FILTER_KINDS.has(spec.kind) &&
        (spec.columnId === field.key ||
          spec.field === field.key ||
          (field.reference !== null && spec.columnId === base)),
    ) ?? null
  );
}

/**
 * The filtered list a derived count opens: its one `{ entity, relation }`
 * provenance source, scoped by the filter that entity's relation section for
 * the same relation declares. The section is the only place the manifest
 * names that scope, so a count with no section stays a plain number.
 */
function relationCountFilter(entity: Entity, field: DisplayField) {
  if (field.kind !== "number" || field.provenance?.kind !== "derived")
    return null;
  const [source, ...others] = field.provenance.sources;
  if (!source?.relation || others.length > 0) return null;
  const section = entitySummary[entity].detail.sections.find(
    (candidate) =>
      candidate.kind === "relation" && candidate.relation === source.relation,
  );
  if (section?.kind !== "relation") return null;
  const target = entityManifest[entity].relationships.find(
    (relation) => relation.key === source.relation,
  )?.target;
  if (target === undefined || !isBrowserRoutedEntity(target)) return null;
  const spec = getEntityFilters(target).find(
    (candidate) => candidate.columnId === section.filter.descriptor,
  );
  return spec
    ? {
        to: entities[target].routes.list,
        // The count follows the direct reference, so the list opens with the
        // filter's "Include sub-…" toggle off.
        search: (id: string) => ({
          [filterUrlKey(spec)]: id,
          ...(spec.subtree === undefined ? {} : { [spec.subtree]: "false" }),
        }),
        plural: entityPluralLabel(target).toLocaleLowerCase(),
      }
    : null;
}

/**
 * "Show all <plural> with <label> <value>" beside a field that a list filter
 * can select on. Reference and enum fields get one icon link; a text-array
 * with a multiselect filter links every value.
 */
function cohortFilterAction<TRecord extends object>(
  entity: Entity,
  record: TRecord,
  field: DisplayField,
): ReactNode {
  const countFilter = relationCountFilter(entity, field);
  const recordId = explainedRecordSchema.safeParse(record);
  if (countFilter !== null && recordId.success) {
    return (
      <EntityFilterLink
        to={countFilter.to}
        search={countFilter.search(recordId.data.id)}
        label={`Show all ${countFilter.plural}`}
        className={LEDGER_FILTER_ACTION_CLASS}
      />
    );
  }
  if (!isBrowserRoutedEntity(entity)) return undefined;
  const spec = cohortFilterSpecFor(entity, field);
  if (spec === null) return undefined;
  const urlKey = filterUrlKey(spec);
  const plural = entityPluralLabel(entity).toLocaleLowerCase();
  const label = field.label.toLocaleLowerCase();
  const linkTo = (value: string, text: string) => (
    <EntityFilterLink
      key={value}
      to={entities[entity].routes.list}
      search={{ [urlKey]: value }}
      label={`Show all ${plural} with ${label} ${text}`}
      className={LEDGER_FILTER_ACTION_CLASS}
    />
  );
  const reference = readDisplayReferenceField(record, field);
  if (reference !== null) {
    const [item] = reference.items;
    return item && reference.items.length === 1
      ? linkTo(item.id, item.name ?? item.id)
      : undefined;
  }
  const value = readScalarField(entity, record, field);
  switch (value.kind) {
    case "text":
    case "enum":
      return linkTo(value.raw, value.label);
    case "list":
      return value.raw.length > 0 ? (
        <span className="flex flex-wrap">
          {value.raw.map((item) => linkTo(item, item))}
        </span>
      ) : undefined;
    default:
      return undefined;
  }
}

/**
 * The detail fields a `fields` section of `entitySummary[entity].detail`
 * names, in declared order; without a section, every `display.detail` field
 * by `detailOrder`.
 */
const entityDetailFields = (
  entity: Entity,
  fields?: readonly string[],
): DisplayField[] => {
  const detail = entityDisplayFields(entity, "detail");
  if (fields === undefined)
    return [...detail].sort(
      (left, right) =>
        (left.display.detailOrder ?? Number.MAX_SAFE_INTEGER) -
        (right.display.detailOrder ?? Number.MAX_SAFE_INTEGER),
    );
  return fields.map((key) => {
    const field = detail.find((candidate) => candidate.key === key);
    if (field === undefined)
      throw new Error(`${entity}.${key} is not a display.detail field`);
    return field;
  });
};

/** Statuses that settle a deadline; a settled record is never overdue. */
const SETTLED_STATUSES = new Set([
  "done",
  "completed",
  "complete",
  "cancelled",
  "canceled",
  "finished",
  "skipped",
  "closed",
]);
const settledRecord = z.looseObject({
  status: z.string().nullish(),
  completedAt: z.unknown().optional(),
});

/**
 * Whether a date field is a deadline the record still owes: a `dueDate`-keyed
 * field on a record that is neither settled by status nor completed.
 */
export function isOpenDeadline(key: string, record: unknown): boolean {
  if (!/(^d|D)ue(End)?Date$/.test(key)) return false;
  const parsed = settledRecord.safeParse(record);
  return isUnsettledRecord(parsed.success ? parsed.data : null);
}

function isUnsettledRecord(
  record: z.infer<typeof settledRecord> | null,
): boolean {
  if (record === null) return true;
  const { status, completedAt } = record;
  if (status && SETTLED_STATUSES.has(status.toLowerCase())) return false;
  return completedAt === undefined || completedAt === null;
}

const readDateRange = <TRecord extends object>(
  record: TRecord,
  field: DisplayField,
) =>
  storedDateRangeSchema
    .nullish()
    .parse(
      readPathValue(
        record,
        field.display.readPath ?? field.readKey ?? field.key,
      ),
    ) ?? null;

const renderDateRangeValue = <TRecord extends object>(
  record: TRecord,
  field: DisplayField,
): ReactNode => {
  const value = readDateRange(record, field);
  if (value === null) return <NoneValue />;
  const period = field.dateRange?.semantics === "period";
  const settled = settledRecord.safeParse(record);
  return (
    <span>
      {period && value.start && !value.end
        ? "From "
        : !value.start
          ? "Through "
          : ""}
      <DateDisplay
        start={value.start}
        end={value.end}
        due={
          !period && isUnsettledRecord(settled.success ? settled.data : null)
        }
        className="tabular-nums"
      />
    </span>
  );
};

/**
 * The compact facts a record's preview shows: its declared preview fields, or
 * the first detail `fields` section in order, skipping the title, the hero
 * chip and breadcrumb (the card header carries those), structured values,
 * and empty fields — a preview spends its few rows on what is known.
 */
export function entityPreviewFacts<TRecord extends object>(
  entity: Entity,
  record: TRecord,
  limit = 4,
  options: { singleLine?: boolean } = {},
): { label: string; value: ReactNode }[] {
  const { preview } = entitySummary[entity].detail;
  const keys = entityPreviewFieldKeys(entity);
  const fields = entityFieldModels[entity].fields;
  const facts: { label: string; value: ReactNode }[] = [];
  for (const key of keys) {
    if (preview.length === 0 && facts.length >= limit) break;
    const field = fields.find((candidate) => candidate.key === key);
    if (!field || (field.kind === "json" && field.display.format === null))
      continue;
    const reference = readDisplayReferenceField(record, field);
    const known = reference
      ? reference.items.length > 0
      : field.readKey !== null &&
        copyScalarField(entity, record, field) !== null;
    if (!known) continue;
    facts.push({
      label: field.label,
      value: renderCompactFieldValue(entity, record, field, options),
    });
  }
  return facts;
}

/**
 * The declared `hero.when` — when the thing happened — rendered by the field's
 * own renderer; null when undeclared or empty, so the header falls back to
 * the ingest `createdAt`.
 */
export function entityHeroWhen<TRecord extends object>(
  entity: Entity,
  record: TRecord,
): { label: string; value: ReactNode } | null {
  const when: { field: string; label?: string } | null =
    entitySummary[entity].detail.hero.when;
  if (when === null) return null;
  const field = entityFieldModels[entity].fields.find(
    (candidate) => candidate.key === when.field,
  );
  if (!field || copyScalarField(entity, record, field) === null) return null;
  return {
    label: when.label ?? field.label,
    value: renderDetailFieldValue(entity, record, field),
  };
}

/** The field keys of one declared `fields` detail section. */
export const entitySectionFields = (
  entity: Entity,
  sectionId: string,
): readonly string[] => {
  const section = entitySummary[entity].detail.sections.find(
    (candidate) => candidate.id === sectionId,
  );
  if (section === undefined || section.kind !== "fields")
    throw new Error(`${entity} declares no fields section ${sectionId}`);
  return section.fields;
};

export type DetailFieldRenderer<TRecord extends object> = (
  record: TRecord,
) => Omit<Fact, "label"> & { label?: string };

export function EntityBasicInfo<TRecord extends object>({
  entity,
  record,
  overrides = {},
  afterFields = {},
  fields: fieldKeys,
  cohortLinks = true,
  actions,
  header,
  footer,
}: {
  entity: Entity;
  record: TRecord;
  /** A declared `fields` section's keys; every `display.detail` field when omitted. */
  fields?: readonly string[];
  overrides?: Readonly<Record<string, DetailFieldRenderer<TRecord>>>;
  /** Derive a "show all" list link for fields a filter descriptor can select on. */
  cohortLinks?: boolean;
  /** Computed facts retain their domain renderer beside the declared field
   * they enrich. They do not become persisted entity fields. */
  afterFields?: Readonly<Record<string, readonly Fact[]>>;
  actions?: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
}) {
  const fields = entityDetailFields(entity, fieldKeys);
  const explainedRecord = explainedRecordSchema.safeParse(record);
  const quality = useFieldQuality(
    entity,
    explainedRecord.success ? explainedRecord.data.id : undefined,
  );
  for (const key of [...Object.keys(overrides), ...Object.keys(afterFields)]) {
    if (!fields.some((field) => field.key === key)) {
      throw new Error(`Undeclared detail renderer for ${entity}.${key}`);
    }
  }
  const onAdd = useFactsAdd();
  const mediaRefs = fields.flatMap((field) =>
    referenceMediaRefs(record, field),
  );
  const facts = (
    <Facts
      layout="list"
      facts={fields.flatMap<Fact>((field) => {
        const refusal = classificationFieldRefusal(entity, record, field.key);
        if (
          refusal &&
          classificationFieldDisplayRefusal(entity, record, field.key) !== null
        )
          return [
            {
              label: field.label,
              value: <NotApplicableField reason={refusal} />,
            },
          ];
        const checks = fieldQualityChecks(quality?.checks ?? [], field.key);
        const override = overrides[field.key]?.(record);
        const rendered = override ?? {
          value:
            !refusal && onAdd && isAddableEmpty(entity, record, field) ? (
              <AddFactValue label={field.label} onAdd={onAdd} />
            ) : (
              renderDetailFieldValue(entity, record, field)
            ),
        };
        // A renderer that names `filterAction` (even as null) owns the
        // cohort affordance; otherwise the manifest's descriptor supplies it.
        const filterAction =
          "filterAction" in rendered
            ? rendered.filterAction
            : cohortLinks
              ? cohortFilterAction(entity, record, field)
              : undefined;
        const explanation =
          field.explanation && explainedRecord.success ? (
            <FieldExplanationContents
              entity={entity}
              id={explainedRecord.data.id}
              field={field.key}
              label={field.label}
              surface="detail"
            />
          ) : undefined;
        const resolution = fieldResolutionFor(record, field.key);
        // Keep suggestion and resolution with the value; the fact list's separate
        // action rail owns the controls regardless of caption wrapping.
        const decoratedValue = field.control?.suggest ? (
          <span className="inline-flex max-w-full min-w-0 items-center gap-1">
            <RecordFieldSuggestion record={record} field={field.key}>
              {rendered.value ?? "Not recorded"}
            </RecordFieldSuggestion>
          </span>
        ) : (
          (rendered.value ?? "Not recorded")
        );
        return [
          {
            label: field.label,
            fullWidth: isProseField(field.key, field.control),
            ...rendered,
            value: decoratedValue,
            caption: resolution ? (
              <FieldResolutionBadge
                record={record}
                field={field.key}
                interactive={!refusal}
              />
            ) : undefined,
            anchor: quality
              ? `${quality.prefix}-field-${field.key}`
              : undefined,
            quality:
              checks.length > 0 ? (
                <span className="flex flex-col items-start gap-1">
                  {checks.map((check) => (
                    <QualityResult key={check.check} check={check} />
                  ))}
                </span>
              ) : undefined,
            explanation:
              checks.length > 0 && explainedRecord.success ? (
                <div className="grid gap-3">
                  {checks.map((check) => (
                    <QualityCheckDetails
                      key={check.check}
                      check={check}
                      entityId={explainedRecord.data.id}
                    />
                  ))}
                  {explanation}
                </div>
              ) : (
                explanation
              ),
            filterAction,
          },
          ...(afterFields[field.key] ?? []),
        ];
      })}
    />
  );
  const info =
    header || footer || actions ? (
      <div className="space-y-2">
        {header}
        {facts}
        {footer}
        {actions && <div className="pt-2">{actions}</div>}
      </div>
    ) : (
      facts
    );
  // Only a card that names references needs covers (and a QueryClient).
  return mediaRefs.length > 0 ? (
    <EntityDisplayImagesProvider refs={mediaRefs}>
      {info}
    </EntityDisplayImagesProvider>
  ) : (
    info
  );
}

/** The concrete value shapes a generic editable control can save. */
// `nullish`: an optional read key absent from a partial projection edits
// from empty rather than failing the whole fields section.
const editableFieldValue = z
  .union([z.string(), z.number(), z.boolean(), storedDateRangeSchema])
  .nullish();
type EditableFieldValue = Exclude<
  z.output<typeof editableFieldValue>,
  undefined
>;

type EditableField = Pick<
  DisplayField,
  "key" | "label" | "nullable" | "display"
> & {
  control: NonNullable<DisplayField["control"]>;
};

const editableControlKinds = new Set([
  "text",
  "textarea",
  "number",
  "date",
  "dateRange",
  "select",
  "checkbox",
]);

function isMoneyField(
  field: Pick<DisplayField, "display" | "control">,
): boolean {
  const format = field.display.format;
  return (
    format === "currency" ||
    format === "signedCurrency" ||
    field.control?.renderer === "money"
  );
}

const asText = (value: EditableFieldValue) =>
  value === null ? null : String(value);
const numberOrNull = z.number().nullable().catch(null);
const booleanOrNull = z.boolean().nullable().catch(null);
const asNumber = (value: EditableFieldValue) => numberOrNull.parse(value);
const asBoolean = (value: unknown) => booleanOrNull.parse(value);

/** Keep the declared control correlated with its descriptor and editor value. */
type EditableFieldBinding<TString, TNumber, TBoolean> =
  | { kind: "text" | "textarea" | "date" | "select"; data: TString }
  | { kind: "number"; data: TNumber }
  | { kind: "checkbox"; data: TBoolean };

type EditableFieldClipboard = EditableFieldBinding<
  CellClipboardSpec<string | null>,
  CellClipboardSpec<number | null>,
  CellClipboardSpec<boolean | null>
>;

/** The row-parametrized copy/paste descriptor for an editable field's column. */
function editableFieldCellData<TRecord extends object>(
  entity: Entity,
  field: EditableField,
  read: (row: TRecord) => EditableFieldValue,
  save: (row: TRecord, value: EditableFieldValue) => Promise<void>,
): EditableFieldBinding<
  ColumnCellData<TRecord, string | null>,
  ColumnCellData<TRecord, number | null>,
  ColumnCellData<TRecord, boolean | null>
> {
  const text = (row: TRecord) => asText(read(row));
  switch (field.control.kind) {
    case "text":
    case "textarea":
      return {
        kind: field.control.kind,
        data: textCellData<TRecord>("text", text, save),
      };
    case "date":
      return { kind: "date", data: dateCellData<TRecord>(text, save) };
    case "number":
      return {
        kind: "number",
        data: numberCellData<TRecord>(
          isMoneyField(field) ? "currency" : "number",
          (row) => asNumber(read(row)),
          save,
        ),
      };
    case "select":
      return {
        kind: "select",
        data: selectCellData<TRecord>(
          text,
          enumFieldOptions(entity, field),
          save,
        ),
      };
    case "checkbox":
      return {
        kind: "checkbox",
        data: booleanCellData<TRecord>((row) => asBoolean(read(row)), save),
      };
    case "dateRange":
    case "specialized":
      throw new Error(
        `Editable control kind "${field.control.kind}" needs a hand-written override`,
      );
  }
}

/**
 * A field's editable control, derived from its declared `control.kind` and
 * `display.format`. The detail page (`editableFieldOverrides`) and list
 * columns (`createEntityDisplayColumns`) share this one mapping; only
 * `specialized` controls are hand-rendered.
 */
function renderEditableField<TRecord extends object>(
  entity: Entity,
  field: EditableField,
  value: EditableFieldValue,
  save: (next: EditableFieldValue) => Promise<void>,
  record: TRecord,
  surface: DisplaySurface,
  clipboard: EditableFieldClipboard,
  /** A date field folded into a span shows the span text but edits its own value. */
  spanValue?: ReactNode,
): ReactNode {
  const refusal = classificationFieldRefusal(entity, record, field.key);
  if (refusal) {
    const readField = entityDisplayFields(entity, surface).find(
      (candidate) => candidate.key === field.key,
    );
    if (
      readField &&
      classificationFieldDisplayRefusal(entity, record, field.key) === null
    )
      return surface === "detail"
        ? renderDetailFieldValue(entity, record, readField)
        : renderCompactFieldValue(entity, record, readField);
    return <NotApplicableField reason={refusal} />;
  }
  const { key, control } = field;
  const format = field.display.format;
  const resolution = fieldResolutionFor(record, field.key);
  const editValue = resolution
    ? (editableFieldValue.parse(resolution.storedValue) ?? null)
    : value;
  const displayField = entityDisplayFields(entity, surface).find(
    (candidate) => candidate.key === field.key,
  );
  const displayed = (rendered: ReactNode) =>
    surface === "detail" && displayField
      ? renderDetailFieldValue(entity, record, displayField)
      : resolution && displayField
        ? renderCompactFieldValue(entity, record, displayField)
        : rendered;
  switch (clipboard.kind) {
    case "text":
    case "textarea": {
      const prose = isProseField(key, control);
      return (
        <EditableCell
          value={asText(editValue)}
          trigger={
            prose ? (surface === "detail" ? "pencil-wrap" : "pencil") : "wrap"
          }
          clipboard={clipboard.data}
          config={
            control.kind === "textarea"
              ? { type: "text", multiline: true, rows: 4 }
              : { type: "text" }
          }
          onSave={save}
          renderValue={(v) =>
            displayed(
              format === "external-link" || control.renderer === "url" ? (
                v ? (
                  <ExternalLinkText href={v} />
                ) : (
                  <NoneValue />
                )
              ) : v && prose ? (
                <ShortcodeProse>{v}</ShortcodeProse>
              ) : (
                (v ?? <NoneValue />)
              ),
            )
          }
        />
      );
    }
    case "number": {
      const money = isMoneyField(field);
      return money ? (
        <EditableCell
          value={asNumber(editValue)}
          config={{ type: "currency" }}
          clipboard={clipboard.data}
          onSave={save}
          renderValue={(v) =>
            displayed(
              v === null ? (
                <NoneValue />
              ) : (
                <CurrencyValue value={v} interactive={false} />
              ),
            )
          }
        />
      ) : (
        <EditableCell
          value={asNumber(editValue)}
          config={{ type: "number" }}
          clipboard={clipboard.data}
          onSave={save}
          renderValue={(v) =>
            displayed(v === null ? <NoneValue /> : <NumberValue value={v} />)
          }
        />
      );
    }
    case "date": {
      return (
        <EditableCell
          value={asText(editValue)}
          config={{
            type: "date",
            ...recordFieldClearing(entity, key, field.nullable, record),
          }}
          clipboard={clipboard.data}
          onSave={save}
          renderValue={(v) =>
            displayed(
              spanValue ??
                (v ? (
                  renderFormattedScalar(
                    format,
                    { kind: "date", raw: v, due: isOpenDeadline(key, record) },
                    surface,
                  )
                ) : (
                  <NoneValue />
                )),
            )
          }
        />
      );
    }
    case "select": {
      const options: PickerOption[] = enumFieldOptions(entity, field);
      return (
        <EditableCell
          value={asText(editValue)}
          config={{
            type: "select",
            options,
            clearable: field.nullable,
            suggest: enumFieldSuggestSource(entity, field, record),
          }}
          clipboard={clipboard.data}
          onSave={save}
          renderValue={(v) => displayed(renderOptionCell(v, options))}
        />
      );
    }
    case "checkbox":
      return (
        <span className="inline-flex items-center gap-2">
          <Checkbox
            checked={asBoolean(resolution ? resolution.value : value) === true}
            indeterminate={
              asBoolean(resolution ? resolution.value : value) === null
            }
            onCheckedChange={(next) => {
              void save(next);
            }}
            aria-label={`Set ${field.label}`}
          />
          {asBoolean(resolution ? resolution.value : value) === null ? (
            <span className="text-xs text-muted-foreground">Undecided</span>
          ) : null}
          {resolution?.canReset && field.nullable ? (
            <Button
              type="button"
              variant="link"
              size="xs"
              onClick={() => void save(null)}
            >
              Use inherited
            </Button>
          ) : null}
        </span>
      );
  }
}

/**
 * `entityMutationOptionsFactory(entity, "update")`-bound scalar-field
 * `EditableCell` overrides for `EntityBasicInfo`. Belongs only in a page's
 * `overrides` for a field whose editor is a plain scalar update — text,
 * textarea, number, currency, date, or select with no Badge, `filterAction`,
 * conditional visibility, or entity-reference picker; a block with any of
 * that extra logic stays hand-written next to this call.
 */
export function editableFieldOverrides<TRecord extends { id: string }, TResult>(
  entity: Entity,
  record: TRecord,
  keys: readonly string[],
  mutate: (variables: {
    id: string;
    data: Record<string, EditableFieldValue>;
  }) => Promise<TResult>,
): Record<string, () => { value: ReactNode }> {
  const fields = entityDisplayFields(entity, "detail");
  return Object.fromEntries(
    keys.map((key) => {
      const field = fields.find((candidate) => candidate.key === key);
      const refusal = classificationFieldRefusal(entity, record, key);
      if (refusal)
        return [
          key,
          () => ({
            value:
              field &&
              classificationFieldDisplayRefusal(entity, record, key) ===
                null ? (
                renderDetailFieldValue(entity, record, field)
              ) : (
                <NotApplicableField reason={refusal} />
              ),
          }),
        ] as const;
      if (!field?.control || field.readKey === null) {
        throw new Error(`${entity}.${key} has no editable scalar control`);
      }
      const control = field.control;
      if (
        field.reference &&
        !field.reference.multiple &&
        isReferencePickerEntity(field.reference.entity)
      ) {
        const target = field.reference.entity;
        const item = readReferenceField(record, field)?.items[0];
        const value = item ? { id: item.id, name: item.name ?? item.id } : null;
        return [
          key,
          () => ({
            value: (
              <EditableEntityCell
                value={value}
                onSave={async (id) => {
                  await mutate({ id: record.id, data: { [key]: id } });
                }}
                SearchProvider={referenceEntitySearch(target)}
                scope={referenceScopeFor(field.reference, record)}
                label={target}
                clearable={field.nullable}
                trigger="pencil"
                renderValue={() =>
                  renderDetailFieldValue(entity, record, field)
                }
              />
            ),
          }),
        ] as const;
      }
      const resolution = fieldResolutionFor(record, field.key);
      // SAFETY: `readKey` names a declared read projection on this same
      // record shape — the manifest is the contract this file already
      // trusts throughout (see `readScalarField` above); the parse turns
      // the untyped indexed read into the concrete `EditableFieldValue`
      // every generic control branch renders.
      const value =
        editableFieldValue.parse(
          resolution
            ? resolution.storedValue
            : record[field.readKey as keyof TRecord],
        ) ?? null;
      const save = async (next: EditableFieldValue): Promise<void> => {
        await mutate({ id: record.id, data: { [key]: next } });
      };
      if (field.kind === "dateRange") {
        const range = readDateRange(record, field);
        const data = dateRangeCellData(
          () => range,
          (_row, next) => save(next),
        );
        return [
          key,
          () => ({
            value: (
              <EditableDateRangeCell
                value={range}
                onSave={save}
                semantics={field.dateRange?.semantics ?? "period"}
                renderValue={() => renderDateRangeValue(record, field)}
                clipboard={specFromCellData(data, record)}
              />
            ),
          }),
        ] as const;
      }
      const binding = editableFieldCellData(
        entity,
        { ...field, control },
        () => value,
        (_row, next) => save(next),
      );
      const override = () => {
        let clipboard: EditableFieldClipboard;
        switch (binding.kind) {
          case "text":
          case "textarea":
          case "date":
          case "select":
            clipboard = {
              kind: binding.kind,
              data: specFromCellData(binding.data, record),
            };
            break;
          case "number":
            clipboard = {
              kind: binding.kind,
              data: specFromCellData(binding.data, record),
            };
            break;
          case "checkbox":
            clipboard = {
              kind: binding.kind,
              data: specFromCellData(binding.data, record),
            };
            break;
        }
        return {
          value: renderEditableField(
            entity,
            { ...field, control },
            value,
            save,
            record,
            "detail",
            clipboard,
          ),
        };
      };
      return [key, override] as const;
    }),
  );
}

/**
 * The copy/paste descriptor for a generated column, keyed off the same
 * `display.format` the cell renderer switches on — `external-link` copies
 * like the field's own kind (number or text), so it has no dedicated branch.
 */
function cellDataForField<TRecord extends object>(
  entity: Entity,
  field: DisplayField,
) {
  switch (field.display.format) {
    case "currency":
    case "signedCurrency":
      return numberCellData<TRecord>("currency", (record) => {
        const value = readScalarField(entity, record, field);
        return value.kind === "number" ? value.raw : null;
      });
    case "plainDate":
      return dateCellData<TRecord>((record) =>
        copyScalarField(entity, record, field),
      );
    case "timestamp":
      return timestampCellData<TRecord>((record) => {
        const value = readScalarField(entity, record, field);
        return value.kind === "timestamp" ? value.raw : null;
      });
    case "external-link":
    case "presence":
    case "bytes":
    case "join":
    case "arrayCount":
    case "count":
    case null:
      // Read-only pills, instants, dates, and Yes/No keep their own kind so
      // layout sizes them like their editable twins instead of as free text.
      if (field.kind === "enum" && field.display.format === null)
        return selectCellData<TRecord>(
          (record) => {
            const value = readScalarField(entity, record, field);
            return value.kind === "enum" ? value.raw : null;
          },
          enumFieldOptions(entity, field),
        );
      if (field.kind === "timestamp" && field.display.format === null)
        return timestampCellData<TRecord>((record) => {
          const value = readScalarField(entity, record, field);
          return value.kind === "timestamp" ? value.raw : null;
        });
      if (field.kind === "date" && field.display.format === null)
        return dateCellData<TRecord>((record) =>
          copyScalarField(entity, record, field),
        );
      if (field.kind === "boolean")
        return booleanCellData<TRecord>((record) => {
          const value = readScalarField(entity, record, field);
          return value.kind === "boolean" ? value.raw : null;
        });
      return field.kind === "number"
        ? numberCellData<TRecord>("number", (record) => {
            const value = readScalarField(entity, record, field);
            return value.kind === "number" ? value.raw : null;
          })
        : textCellData<TRecord>("text", (record) =>
            copyScalarField(entity, record, field),
          );
  }
}

/** Specialized columns retain their cell behavior and table metadata. Declared
 * membership, field accessors, and plain headers belong to the entity model. */
export function createEntityDisplayColumns<TRecord extends object>(
  entity: Entity,
  helper: CubbyColumnHelper<TRecord>,
  overrides?: CubbyColumnCollection<TRecord>,
  options: {
    /**
     * Restrict to these column ids, in this order (a relation section's
     * declared `columns`). Reference and structured fields without an
     * override then render generically — a link to the target, readable
     * JSON — instead of failing: an embedded table shows the declaration's
     * columns as-is.
     */
    only?: readonly string[];
    /**
     * An embedded relation table with no declared `columns` shows the
     * target's list columns minus the computed ones only a list page's
     * specialized renderer can fill, instead of failing on them.
     */
    skipSpecialized?: boolean;
    /** One semantic update for every pasted field in a row. */
    onSaveFields?: (row: TRecord, values: PasteFieldValues) => Promise<void>;
    /** Manifest-backed scalar write. The list owner supplies the typed entity mutation. */
    onSaveField?: (
      row: TRecord,
      field: string,
      value: EditableFieldValue,
    ) => Promise<void>;
  } = {},
): CubbyColumnCollection<TRecord> {
  // SAFETY: `generatedEntitySort` is `as const satisfies Partial<Record<Entity,
  // ...>>`, so its inferred type carries only the entity keys actually present
  // (e.g. "cookbook" and "usda-food" have no sort roster at all) — indexing it
  // with a generic `Entity` needs the wider Partial view reinstated here, not
  // the narrower literal TS would otherwise reject for those missing keys. The
  // `?? []` just below is what makes an absent roster safe: an entity with no
  // sort declaration then sorts no generated column, rather than throwing.
  const sortRoster = (
    generatedEntitySort as Partial<
      Record<Entity, { fields: readonly string[] }>
    >
  )[entity];
  const sortableColumnIds: readonly string[] = sortRoster?.fields ?? [];
  const { only, skipSpecialized, onSaveFields } = options;
  const onSaveField =
    options.onSaveField ??
    (onSaveFields
      ? (row: TRecord, field: string, value: EditableFieldValue) =>
          onSaveFields(row, { [field]: value })
      : undefined);
  const withRowWrite = <TSaved,>(
    field: string,
    data: ColumnCellData<TRecord, TSaved>,
  ): ColumnCellData<TRecord, TSaved> =>
    onSaveFields && data.applyPaste
      ? { ...data, rowWrite: { field, save: onSaveFields } }
      : data;
  const titleField = entitySummary[entity].titleField;
  const updateFields: readonly string[] = entityFieldModels[entity].update;
  const listFields = orderedListFields(entity);
  const selected =
    only === undefined
      ? listFields
      : only.flatMap((id) => {
          const field = listFields.find(
            (candidate) => (candidate.display.columnId ?? candidate.key) === id,
          );
          if (field === undefined)
            throw new Error(`${entity}.${id} is not a list column`);
          return [field];
        });
  // oxlint-disable-next-line complexity -- one exhaustive manifest control dispatcher preserves column metadata and clipboard ownership together.
  return createCubbyColumnCollection<TRecord>((addColumn) => {
    const usedOverrides = new Set<string>();
    for (const field of selected) {
      const columnId = field.display.columnId ?? field.key;
      // A suggestable field renders the suggestion mark in the cell rail;
      // column sizing reserves its slot from this flag. A column headed by
      // the field's label paints its short form.
      const headerForm = columnHeaderFor(field);
      const add = <TValue,>(column: CubbyColumnDef<TRecord, TValue>) => {
        const meta = { ...column.meta };
        if (field.display.columnGroup)
          meta.columnGroup = field.display.columnGroup;
        meta.valueKind = isMoneyField(field)
          ? "money"
          : field.reference?.entity === "ledgerParty"
            ? "person"
            : field.kind === "date"
              ? "date"
              : field.kind === "boolean"
                ? "boolean"
                : column.meta?.numeric
                  ? "number"
                  : field.control?.kind === "select"
                    ? "enum"
                    : "text";
        if (field.control?.suggest) meta.suggest = true;
        if (column.header === field.label) {
          if (headerForm.short !== field.label)
            meta.shortHeader = headerForm.short;
          if (headerForm.countOf) meta.countOf = headerForm.countOf;
        }
        const decorated: CubbyColumnDef<TRecord, TValue> = {
          ...column,
          meta,
          ...(field.display.columnBar
            ? {
                cell: (context) => {
                  const maximum = context.table
                    .getPrePaginatedRowModel()
                    .flatRows.reduce((max, row) => {
                      const value = row.getValue(columnId);
                      return typeof value === "number" && Number.isFinite(value)
                        ? Math.max(max, Math.abs(value))
                        : max;
                    }, 0);
                  return (
                    <CellMagnitudeBar
                      value={context.getValue()}
                      maximum={maximum}
                    >
                      {flexRender(column.cell, context)}
                    </CellMagnitudeBar>
                  );
                },
              }
            : {}),
        };
        if (meta.cellData) {
          const data = meta.cellData;
          const allowed = (row: unknown) =>
            row !== null &&
            typeof row === "object" &&
            classificationFieldRefusal(entity, row, field.key) === null &&
            data.canWrite?.(row) !== false;
          meta.cellData = { ...data, canWrite: allowed };
        }
        const renderCell = decorated.cell;
        decorated.cell = (context) => {
          const refusal = classificationFieldRefusal(
            entity,
            context.row.original,
            field.key,
          );
          if (refusal)
            return classificationFieldDisplayRefusal(
              entity,
              context.row.original,
              field.key,
            ) === null ? (
              renderCompactFieldValue(entity, context.row.original, field, {
                singleLine: true,
              })
            ) : (
              <NotApplicableField reason={refusal} />
            );
          return flexRender(renderCell, context);
        };
        addColumn(decorated);
      };
      const isIdentityField = field.readKey === titleField;
      // The standard-column pipeline owns the one canonical identity lane; an
      // override claiming it fails below as undeclared.
      if (isIdentityField) continue;
      if (field.kind === "dateRange") {
        const valueOf = (row: TRecord) => readDateRange(row, field);
        const save =
          onSaveField && updateFields.includes(field.key)
            ? (row: TRecord, value: CalendarDateRange | null) =>
                onSaveField(row, field.key, value)
            : undefined;
        const cellData = withRowWrite(
          field.key,
          dateRangeCellData(valueOf, save),
        );
        add(
          createEditableAccessorColumn(
            helper,
            (row) => valueOf(row)?.start ?? valueOf(row)?.end ?? null,
            {
              id: columnId,
              header: field.label,
              enableSorting: sortableColumnIds.includes(columnId),
              meta: {
                entityColumnRole: "fact",
                className: "w-80",
                mobile: toMobileColumnMeta(field.display.mobile),
              },
              cellData,
              renderValue: (row) => renderDateRangeValue(row, field),
              renderEditable: (row) =>
                save ? (
                  <EditableDateRangeCell
                    value={valueOf(row)}
                    onSave={(next) => save(row, next)}
                    semantics={field.dateRange?.semantics ?? "period"}
                    renderValue={() => renderDateRangeValue(row, field)}
                    clipboard={specFromCellData(cellData, row)}
                  />
                ) : (
                  renderDateRangeValue(row, field)
                ),
            },
          ),
        );
        continue;
      }
      // A standard column belongs to the shared table's pipeline, unless the
      // field names a renderer (the image entity's thumbnail has no row
      // `displayImages` for the pipeline to read).
      const namedRenderer = field.display.renderer?.list ?? null;
      if (field.display.standard && namedRenderer === null) continue;
      const defaultEnableSorting = sortableColumnIds.includes(columnId);
      if (namedRenderer !== null) {
        overrides?.visit((column) => {
          const id =
            column.id ??
            ("accessorKey" in column ? String(column.accessorKey) : null);
          if (id === columnId) {
            throw new Error(
              `Manifest and legacy list renderers both claim ${entity}.${field.key}`,
            );
          }
        });
        const rendered = listRendererColumns(entity, namedRenderer, helper);
        let count = 0;
        rendered.visit((column) => {
          const id =
            column.id ??
            ("accessorKey" in column ? String(column.accessorKey) : null);
          if (id !== columnId) {
            throw new Error(
              `List renderer ${namedRenderer} must render ${entity}.${columnId}`,
            );
          }
          count += 1;
          add({
            ...column,
            id: columnId,
            meta: attachCubbyColumnMeta({
              ...column.meta,
              entityColumnRole: column.meta?.entityColumnRole ?? "fact",
              provenance: field.provenance ?? undefined,
              explanation: field.explanation
                ? { entity, field: field.key, label: field.label }
                : undefined,
            }),
            header:
              column.header === undefined ||
              z.string().safeParse(column.header).success
                ? field.label
                : column.header,
            enableSorting: column.enableSorting ?? defaultEnableSorting,
          });
        });
        if (count !== 1) {
          throw new Error(
            `List renderer ${namedRenderer} must produce one column for ${entity}.${field.key}`,
          );
        }
        continue;
      }
      let overridden = false;
      overrides?.visit((column) => {
        const id =
          column.id ??
          ("accessorKey" in column ? String(column.accessorKey) : null);
        if (id !== columnId) return;
        if (overridden)
          throw new Error(
            `Duplicate display renderer for ${entity}.${field.key}`,
          );
        overridden = true;
        usedOverrides.add(columnId);
        add({
          ...column,
          id: columnId,
          meta: attachCubbyColumnMeta({
            ...column.meta,
            entityColumnRole: "fact",
            provenance: field.provenance ?? undefined,
            explanation: field.explanation
              ? { entity, field: field.key, label: field.label }
              : undefined,
          }),
          header:
            column.header === undefined ||
            z.string().safeParse(column.header).success
              ? field.label
              : column.header,
          // Only fills in when the override left its own value unset — a
          // specialized column that deliberately opts out (or in) keeps that
          // choice.
          enableSorting: column.enableSorting ?? defaultEnableSorting,
        });
      });
      if (overridden) continue;
      const save = (row: TRecord, value: EditableFieldValue) =>
        onSaveField?.(row, field.key, value) ?? Promise.resolve();
      const referenceEditable =
        field.reference !== null &&
        !field.reference.multiple &&
        field.readKey !== null &&
        onSaveField !== undefined &&
        updateFields.includes(field.key) &&
        isReferencePickerEntity(field.reference.entity);
      if (
        referenceEditable &&
        field.reference !== null &&
        isReferencePickerEntity(field.reference.entity)
      ) {
        const referenceEntity = field.reference.entity;
        const getItem = (row: TRecord) => {
          const [item] = readReferenceField(row, field)?.items ?? [];
          return item ? { id: item.id, name: item.name ?? item.id } : null;
        };
        const cellData = withRowWrite(
          field.key,
          entityCellData<TRecord, string>(
            referenceEntity,
            (id) => id,
            getItem,
            (row, id) => save(row, id),
            field.nullable ? (row) => save(row, null) : undefined,
          ),
        );
        add(
          helper.accessor((record) => getItem(record)?.id ?? null, {
            id: columnId,
            header: field.label,
            enableSorting: defaultEnableSorting,
            meta: attachCubbyColumnMeta({
              entityColumnRole: "fact",
              provenance: field.provenance ?? undefined,
              explanation: field.explanation
                ? { entity, field: field.key, label: field.label }
                : undefined,
              className: widthClassName(field.display.width, field.kind),
              mobile: toMobileColumnMeta(field.display.mobile),
              cellData,
              linksTo: referenceEntity,
              entityRefs: (row) => referenceMediaRefs(row, field),
            }),
            cell: ({ row }) => (
              <EditableEntityCell
                value={getItem(row.original)}
                onSave={(id) => save(row.original, id)}
                SearchProvider={referenceEntitySearch(referenceEntity)}
                scope={referenceScopeFor(field.reference, row.original)}
                label={referenceEntity}
                clearable={field.nullable}
                trigger="pencil"
                clipboard={specFromCellData(cellData, row.original)}
                renderValue={(item) => {
                  const original = getItem(row.original);
                  if (item?.id !== original?.id)
                    return item ? (
                      referenceLink(referenceEntity, item)
                    ) : (
                      <NoneValue />
                    );
                  return (
                    compactFieldRendererFor(
                      entity,
                      field.key,
                    )?.(row.original) ??
                    renderCompactFieldValue(entity, row.original, field, {
                      singleLine: true,
                    })
                  );
                }}
              />
            ),
          }),
        );
        continue;
      }
      // A declared `labelPath` is text the server composed for the cell; the
      // field's own value, when it has one, stays the sort value.
      const labelPath = field.display.labelPath;
      if (labelPath !== null && field.reference === null) {
        const labelOf = (record: TRecord) => readLabel(record, labelPath);
        add(
          createEditableAccessorColumn(
            helper,
            (record) =>
              field.readKey !== null || field.display.readPath !== null
                ? readScalarField(entity, record, field).raw
                : labelOf(record),
            {
              id: columnId,
              header: field.label,
              enableSorting: defaultEnableSorting,
              meta: {
                entityColumnRole: "fact",
                provenance: field.provenance ?? undefined,
                explanation: field.explanation
                  ? { entity, field: field.key, label: field.label }
                  : undefined,
                className: widthClassName(field.display.width, field.kind),
                numeric: field.kind === "number" ? true : undefined,
                mobile: toMobileColumnMeta(field.display.mobile),
              },
              cellData: textCellData<TRecord>("text", labelOf),
              renderValue: (row) => labelOf(row) ?? <NoneValue />,
            },
          ),
        );
        continue;
      }
      // A path-backed field reads its value off the row (`display.readPath`)
      // and renders through its format like any scalar.
      const pathBacked = field.display.readPath !== null;
      if (
        !pathBacked &&
        (field.readKey === null ||
          field.reference ||
          field.kind === "json" ||
          field.kind === "identifier")
      ) {
        // A computed column (`readKey: null`, no reference) has nothing
        // generic to read: a full list page needs an override for it, while a
        // relation table (`only`) keeps it visible but empty. References and
        // structured values render through the detail renderer.
        const readable = field.readKey !== null || field.reference !== null;
        if (!readable && only === undefined) {
          if (skipSpecialized) continue;
          throw new Error(
            `Display field ${entity}.${field.key} needs a specialized column`,
          );
        }
        add(
          helper.display({
            id: columnId,
            header: field.label,
            enableSorting: defaultEnableSorting,
            meta: attachCubbyColumnMeta({
              entityColumnRole: "fact",
              provenance: field.provenance ?? undefined,
              explanation: field.explanation
                ? { entity, field: field.key, label: field.label }
                : undefined,
              className: widthClassName(field.display.width, field.kind),
              mobile: toMobileColumnMeta(field.display.mobile),
              linksTo: entitySchema.safeParse(field.reference?.entity).data,
              entityRefs: field.reference
                ? (row) => referenceMediaRefs(row, field)
                : undefined,
            }),
            cell: ({ row }) =>
              readable ? (
                renderCompactFieldValue(entity, row.original, field, {
                  singleLine: true,
                })
              ) : (
                <NoneValue />
              ),
          }),
        );
        continue;
      }
      const format = field.display.format;
      const control = field.control;
      if (
        onSaveField !== undefined &&
        control !== null &&
        updateFields.includes(field.key) &&
        editableControlKinds.has(control.kind)
      ) {
        const editableField = { ...field, control };
        const read = (row: TRecord): EditableFieldValue => {
          const value = readScalarField(entity, row, field);
          if (value.kind === "number" || value.kind === "boolean")
            return value.raw;
          return copyScalarField(entity, row, field);
        };
        const binding = editableFieldCellData(
          entity,
          editableField,
          read,
          save,
        );
        const addEditable = <TSaved extends EditableFieldValue>(
          cellData: ColumnCellData<TRecord, TSaved>,
          clipboardFor: (
            spec: CellClipboardSpec<TSaved>,
          ) => EditableFieldClipboard,
        ) =>
          add(
            createEditableAccessorColumn(helper, read, {
              id: columnId,
              header: field.label,
              enableSorting: defaultEnableSorting,
              meta: {
                entityColumnRole: "fact",
                provenance: field.provenance ?? undefined,
                explanation: field.explanation
                  ? { entity, field: field.key, label: field.label }
                  : undefined,
                className: widthClassName(field.display.width, field.kind),
                mobile: toMobileColumnMeta(field.display.mobile),
                numeric: control.kind === "number" ? true : undefined,
              },
              cellData: withRowWrite(field.key, cellData),
              renderValue: (row) =>
                renderCompactFieldValue(entity, row, field, {
                  singleLine: true,
                }),
              renderEditable: (row, _value, clipboard) =>
                renderEditableField(
                  entity,
                  editableField,
                  read(row),
                  (next) => save(row, next),
                  row,
                  "list",
                  clipboardFor(clipboard),
                ),
            }),
          );
        switch (binding.kind) {
          case "text":
          case "textarea":
          case "date":
          case "select":
            addEditable(binding.data, (spec) => ({
              kind: binding.kind,
              data: spec,
            }));
            break;
          case "number":
            addEditable(binding.data, (spec) => ({
              kind: binding.kind,
              data: spec,
            }));
            break;
          case "checkbox":
            addEditable(binding.data, (spec) => ({
              kind: binding.kind,
              data: spec,
            }));
            break;
        }
        continue;
      }
      const countFilter = relationCountFilter(entity, field);
      add(
        createEditableAccessorColumn(
          helper,
          (record) => readScalarField(entity, record, field).raw,
          {
            id: columnId,
            header: field.label,
            enableSorting: defaultEnableSorting,
            meta: {
              entityColumnRole: "fact",
              provenance: field.provenance ?? undefined,
              explanation: field.explanation
                ? { entity, field: field.key, label: field.label }
                : undefined,
              className: widthClassName(field.display.width, field.kind),
              numeric:
                format === "currency" ||
                format === "signedCurrency" ||
                format === "count" ||
                format === "arrayCount" ||
                format === "bytes" ||
                countFilter !== null
                  ? true
                  : undefined,
              mobile: toMobileColumnMeta(field.display.mobile),
            },
            cellData: cellDataForField<TRecord>(entity, field),
            renderValue: (row) => {
              const read = readScalarField(entity, row, field);
              const value =
                read.kind === "date" && isOpenDeadline(field.key, row)
                  ? { ...read, due: true }
                  : read;
              const domainValue = compactFieldRendererFor(
                entity,
                field.key,
              )?.(row);
              const rendered = domainValue ??
                (isProseField(field.key, field.control) && format === null
                  ? renderProseValue(value, "list")
                  : renderFormattedScalar(format, value, "list", {
                      entity,
                      field,
                    })) ?? <NoneValue />;
              const recordId = explainedRecordSchema.safeParse(row);
              if (
                countFilter === null ||
                !recordId.success ||
                value.kind !== "number" ||
                value.raw === 0
              )
                return rendered;
              return (
                <EntityFilterLink
                  display="value"
                  to={countFilter.to}
                  search={countFilter.search(recordId.data.id)}
                  label={`Show ${value.raw} ${countFilter.plural}`}
                  className="tabular-nums"
                >
                  {rendered}
                </EntityFilterLink>
              );
            },
          },
        ),
      );
    }
    overrides?.visit((column) => {
      const id =
        column.id ??
        ("accessorKey" in column ? String(column.accessorKey) : null);
      if (!id || !usedOverrides.has(id))
        throw new Error(
          `Undeclared display renderer for ${entity}.${id ?? "unknown"}`,
        );
    });
  });
}
