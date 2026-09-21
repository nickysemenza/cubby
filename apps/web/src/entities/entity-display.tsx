import { amount as amountSchema } from "@cubby/schemas/codec";
import type { Entity } from "@cubby/schemas/entity";
import {
  entityFieldModels,
  type EntityFieldModel,
} from "@cubby/schemas/entity-fields";
import {
  entityInspectorMetadata,
  type BrowserRoutedEntity,
  type ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import { generatedEntitySort } from "@cubby/schemas/entity-sort";
import { entitySummary } from "@cubby/schemas/entity-summary";
import type { ReactNode } from "react";
import { z } from "zod";

import {
  fieldSuggestionBasisFromRecord,
  suggestTargetsFor,
} from "~/app/_components/ai/field-suggestion";
import {
  isReferencePickerEntity,
  referenceEntitySearch,
} from "~/app/_components/combobox/reference-entity-search";
import {
  booleanCellData,
  dateCellData,
  entityCellData,
  numberCellData,
  selectCellData,
  specFromCellData,
  textCellData,
  timestampCellData,
} from "~/app/_components/data-table/cell-data";
import { renderOptionCell } from "~/app/_components/data-table/columnHelpers";
import {
  EditableCell,
  type FilterableComboboxItem,
} from "~/app/_components/data-table/editable-cell";
import { EditableEntityCell } from "~/app/_components/data-table/editable-entity-cell";
import {
  createCubbyColumnCollection,
  type CubbyColumnCollection,
  type CubbyColumnHelper,
} from "~/app/_components/data-table/table-features";
import {
  attachCubbyColumnMeta,
  type MobileColumnMeta,
} from "~/app/_components/data-table/table-meta";
import { ExternalLinkText } from "~/app/_components/ExternalLink";
import { tryFormatAmount } from "~/app/_components/inventory/format-amount";
import { TableLink } from "~/app/_components/table/TableLink";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import {
  renderScalarValue,
  type ScalarDisplayValue,
} from "~/components/common/scalar-value";
import { Checkbox } from "~/components/ui/checkbox";
import { EntityFilterLink } from "~/components/ui/entity-filter-link";
import { NoneValue } from "~/components/ui/none-value";
import { formatCurrency } from "~/lib/utils";

import { presentEntitySelectOptions } from "./editing/select-options";
import {
  entities,
  entityDetailParams,
  entityPluralLabel,
  isBrowserRoutedEntity,
} from "./entities";
import { readReferenceField, type ReferenceItem } from "./entity-references";
import { FieldExplanation } from "./field-explanation";
import { listRendererColumns } from "./list-field-renderers";

type DisplayField = EntityFieldModel["fields"][number];
type DisplaySurface = "list" | "detail";
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
): string | undefined {
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
): ReactNode {
  if (value.kind === "empty") return renderScalarValue(value, surface);
  switch (format) {
    case "currency":
      return value.kind === "number" ? (
        <span className="text-positive">{formatCurrency(value.raw)}</span>
      ) : (
        renderScalarValue(value, surface)
      );
    // Negative money is legitimate domain-wide (a refund-only vendor, a
    // credit), so a signed renderer — flat "text-positive" only reads as
    // spend when the value is negative — is generic, not vendor-specific.
    case "signedCurrency":
      return value.kind === "number" ? (
        <span className={value.raw < 0 ? "text-positive" : "font-medium"}>
          {formatCurrency(value.raw)}
        </span>
      ) : (
        renderScalarValue(value, surface)
      );
    case "plainDate":
      return renderScalarValue(
        {
          kind: "date",
          raw: value.kind === "date" ? value.raw : String(value.raw),
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
        <span className="font-mono tabular-nums">
          {tryFormatAmount(parsed.data)}
        </span>
      ) : (
        renderScalarValue(value, surface)
      );
    }
    case null:
      return renderScalarValue(value, surface);
  }
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

function readScalarField<TRecord extends object>(
  record: TRecord,
  field: DisplayField,
): ScalarDisplayValue {
  if (!field.readKey)
    throw new Error(`Display field ${field.key} needs a renderer`);
  // SAFETY: The generated model owns the read key; its scalar schema checks the value
  // before rendering, including absent fields in partial detail responses.
  const value = record[field.readKey as keyof TRecord];
  if (value === undefined || value === null)
    return { kind: "empty", raw: value === undefined ? undefined : null };
  switch (field.kind) {
    case "text":
    case "enum": {
      const raw = z.string().parse(value);
      return {
        kind: "text",
        raw,
        label:
          field.control?.options?.find((option) => option.value === raw)
            ?.label ?? raw,
      };
    }
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
    case "json":
      return { kind: "json", raw: value };
  }
}

function copyScalarField<TRecord extends object>(
  record: TRecord,
  field: DisplayField,
): string | null {
  const value = readScalarField(record, field);
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

function referenceLink(entity: string, item: ReferenceItem): ReactNode {
  const label = item.name ?? item.id;
  // SAFETY: a manifest reference target is always a declared entity key.
  if (!isBrowserRoutedEntity(entity as Entity) || entity === "usda-food")
    return <span className="font-mono text-xs">{label}</span>;
  return (
    <TableLink
      // SAFETY: `isBrowserRoutedEntity` above proves the manifest reference
      // target names a routed entity.
      to={entities[entity as BrowserRoutedEntity].routes.detail}
      params={entityDetailParams(item.id)}
      title={label}
    >
      {label}
    </TableLink>
  );
}

/** Reference fields link to the target's detail route; everything else
 * renders through its declared `display.format`. */
export function renderDetailFieldValue<TRecord extends object>(
  record: TRecord,
  field: DisplayField,
): ReactNode {
  const reference = readReferenceField(record, field);
  if (reference !== null) {
    if (reference.items.length === 0) return <NoneValue />;
    return (
      <span className="flex flex-wrap gap-x-2 gap-y-0.5">
        {reference.items.map((item) => (
          <span key={item.id}>{referenceLink(reference.entity, item)}</span>
        ))}
      </span>
    );
  }
  return renderFormattedScalar(
    field.display.format,
    readScalarField(record, field),
    "detail",
  );
}

/** Filter kinds whose URL value is one option or one id. */
const COHORT_FILTER_KINDS = new Set(["select", "multiselect", "id", "idMulti"]);

/**
 * The list filter a detail field can seed: a descriptor on the same entity
 * whose `field`/`columnId` names the field (or the key minus `Id` for a
 * reference, `ingredientId` → `ingredient`) and whose kind takes one value.
 */
function cohortDescriptorFor(entity: Entity, field: DisplayField) {
  const base = field.key.replace(/Ids?$/u, "");
  return (
    entityInspectorMetadata[entity].filterDescriptors.find(
      (descriptor) =>
        COHORT_FILTER_KINDS.has(descriptor.kind) &&
        (descriptor.columnId === field.key ||
          descriptor.field === field.key ||
          (field.reference !== null && descriptor.columnId === base)),
    ) ?? null
  );
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
  if (!isBrowserRoutedEntity(entity)) return undefined;
  const descriptor = cohortDescriptorFor(entity, field);
  if (descriptor === null) return undefined;
  const plural = entityPluralLabel(entity).toLocaleLowerCase();
  const label = field.label.toLocaleLowerCase();
  const linkTo = (value: string, text: string) => (
    <EntityFilterLink
      key={value}
      to={entities[entity].routes.list}
      search={{ [descriptor.urlKey]: value }}
      label={`Show all ${plural} with ${label} ${text}`}
    />
  );
  const reference = readReferenceField(record, field);
  if (reference !== null) {
    const [item] = reference.items;
    return item && reference.items.length === 1
      ? linkTo(item.id, item.name ?? item.id)
      : undefined;
  }
  const value = readScalarField(record, field);
  switch (value.kind) {
    case "text":
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
) => Omit<BasicInfoField, "label"> & { label?: string };

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
  afterFields?: Readonly<Record<string, readonly BasicInfoField[]>>;
  actions?: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
}) {
  const fields = entityDetailFields(entity, fieldKeys);
  const explainedRecord = explainedRecordSchema.safeParse(record);
  for (const key of [...Object.keys(overrides), ...Object.keys(afterFields)]) {
    if (!fields.some((field) => field.key === key)) {
      throw new Error(`Undeclared detail renderer for ${entity}.${key}`);
    }
  }
  return (
    <BasicInfo
      actions={actions}
      header={header}
      footer={footer}
      fields={fields.flatMap((field) => {
        const rendered = overrides[field.key]?.(record) ?? {
          value: renderDetailFieldValue(record, field),
        };
        // A renderer that names `filterAction` (even as null) owns the
        // cohort affordance; otherwise the manifest's descriptor supplies it.
        const filterAction =
          "filterAction" in rendered
            ? rendered.filterAction
            : cohortLinks
              ? cohortFilterAction(entity, record, field)
              : undefined;
        const explanationAction =
          field.explanation && explainedRecord.success ? (
            <FieldExplanation
              entity={entity}
              id={explainedRecord.data.id}
              field={field.key}
              label={field.label}
            />
          ) : undefined;
        return [
          {
            label: field.label,
            ...rendered,
            filterAction:
              filterAction || explanationAction ? (
                <>
                  {filterAction}
                  {explanationAction}
                </>
              ) : undefined,
          },
          ...(afterFields[field.key] ?? []),
        ];
      })}
    />
  );
}

/** The concrete value shapes a generic `EditableCell` config can save. */
type EditableFieldValue = string | number | null;
// `nullish`: an optional read key absent from a partial projection edits
// from empty rather than failing the whole fields section.
const editableFieldValue = z.union([z.string(), z.number()]).nullish();

/**
 * A field's editable control, derived from its declared `control.kind` and
 * `display.format` — the same generic mapping `editableFieldOverrides` below
 * uses for every field in its `keys`. Only the plain scalar shapes: a
 * boolean (`checkbox`) has no `EditableCell` config, and `specialized`
 * controls are, by definition, hand-rendered.
 */
function renderEditableField<TRecord extends object>(
  entity: Entity,
  key: string,
  control: NonNullable<DisplayField["control"]>,
  format: DisplayField["display"]["format"],
  value: EditableFieldValue,
  save: (next: EditableFieldValue) => Promise<void>,
  record: TRecord,
): ReactNode {
  switch (control.kind) {
    case "text":
    case "textarea": {
      const text = value === null ? null : String(value);
      return (
        <EditableCell
          value={text}
          config={
            control.kind === "textarea"
              ? { type: "text", multiline: true, rows: 4 }
              : { type: "text" }
          }
          onSave={save}
          renderValue={(v) =>
            format === "external-link" || control.renderer === "url" ? (
              v ? (
                <ExternalLinkText href={v} />
              ) : (
                <NoneValue />
              )
            ) : (
              (v ?? <NoneValue />)
            )
          }
        />
      );
    }
    case "number": {
      const num = value === null ? null : Number(value);
      if (
        format === "currency" ||
        format === "signedCurrency" ||
        control.renderer === "money"
      ) {
        return (
          <EditableCell
            value={num}
            config={{ type: "currency" }}
            onSave={save}
            renderValue={(v) =>
              v === null ? <NoneValue /> : formatCurrency(v)
            }
          />
        );
      }
      return (
        <EditableCell
          value={num}
          config={{ type: "number" }}
          onSave={save}
          renderValue={(v) => v ?? <NoneValue />}
        />
      );
    }
    case "date":
      return (
        <EditableCell
          value={value === null ? null : String(value)}
          config={{ type: "date" }}
          onSave={save}
          renderValue={(v) => v ?? <NoneValue />}
        />
      );
    case "select": {
      const options: FilterableComboboxItem[] = presentEntitySelectOptions(
        entity,
        key,
        control.options ?? [],
        "edit",
      );
      // SAFETY: a detail page only exists for a shortcode entity; `entity`'s
      // broader `Entity` type here is this file's shared display-field plumbing.
      const shortcodeEntity = entity as ShortcodeEntity;
      const suggest = control.suggest
        ? {
            entity: shortcodeEntity,
            targets: [key],
            basis: fieldSuggestionBasisFromRecord(
              shortcodeEntity,
              suggestTargetsFor(shortcodeEntity, [key]),
              record,
            ),
          }
        : undefined;
      return (
        <EditableCell
          value={value === null ? null : String(value)}
          config={{ type: "select", options, suggest }}
          onSave={save}
          renderValue={(v) => renderOptionCell(v, options)}
        />
      );
    }
    case "checkbox":
    case "specialized":
      throw new Error(
        `Editable control kind "${control.kind}" needs a hand-written override`,
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
      if (!field?.control || field.readKey === null) {
        throw new Error(`${entity}.${key} has no editable scalar control`);
      }
      const control = field.control;
      // SAFETY: `readKey` names a declared read projection on this same
      // record shape — the manifest is the contract this file already
      // trusts throughout (see `readScalarField` above); the parse turns
      // the untyped indexed read into the concrete `EditableFieldValue`
      // every generic control branch renders.
      const value =
        editableFieldValue.parse(record[field.readKey as keyof TRecord]) ??
        null;
      const save = async (next: EditableFieldValue): Promise<void> => {
        await mutate({ id: record.id, data: { [key]: next } });
      };
      const override = () => ({
        value: renderEditableField(
          entity,
          key,
          control,
          field.display.format,
          value,
          save,
          record,
        ),
      });
      return [key, override] as const;
    }),
  );
}

/**
 * The copy/paste descriptor for a generated column, keyed off the same
 * `display.format` the cell renderer switches on — `external-link` copies
 * like the field's own kind (number or text), so it has no dedicated branch.
 */
function cellDataForField<TRecord extends object>(field: DisplayField) {
  switch (field.display.format) {
    case "currency":
    case "signedCurrency":
      return numberCellData<TRecord>("currency", (record) => {
        const value = readScalarField(record, field);
        return value.kind === "number" ? value.raw : null;
      });
    case "plainDate":
      return dateCellData<TRecord>((record) => copyScalarField(record, field));
    case "timestamp":
      return timestampCellData<TRecord>((record) => {
        const value = readScalarField(record, field);
        return value.kind === "timestamp" ? value.raw : null;
      });
    case "external-link":
    case null:
      return field.kind === "number"
        ? numberCellData<TRecord>("number", (record) => {
            const value = readScalarField(record, field);
            return value.kind === "number" ? value.raw : null;
          })
        : textCellData<TRecord>("text", (record) =>
            copyScalarField(record, field),
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
    /** Manifest-backed scalar write. The list owner supplies the typed entity mutation. */
    onSaveField?: (
      row: TRecord,
      field: string,
      value: string | number | boolean | null,
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
  const { only, onSaveField } = options;
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
  return createCubbyColumnCollection<TRecord>((add) => {
    const usedOverrides = new Set<string>();
    for (const field of selected) {
      const columnId = field.display.columnId ?? field.key;
      const isIdentityField = field.readKey === titleField;
      if (isIdentityField) {
        // The standard-column pipeline owns the one canonical identity lane.
        // Consume a legacy field override while list modules migrate so it
        // cannot create a second, competing destination later in the row.
        overrides?.visit((column) => {
          const id =
            column.id ??
            ("accessorKey" in column ? String(column.accessorKey) : null);
          if (id === columnId) usedOverrides.add(columnId);
        });
        continue;
      }
      if (field.display.standard) continue;
      const defaultEnableSorting = sortableColumnIds.includes(columnId);
      const namedRenderer = field.display.renderer?.list ?? null;
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
      const save = (row: TRecord, value: string | number | boolean | null) =>
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
        const cellData = entityCellData<TRecord, string>(
          referenceEntity,
          (id) => id,
          getItem,
          (row, id) => save(row, id),
          field.nullable ? (row) => save(row, null) : undefined,
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
              className: widthClassName(field.display.width),
              mobile: toMobileColumnMeta(field.display.mobile),
              cellData,
            }),
            cell: ({ row }) => (
              <EditableEntityCell
                value={getItem(row.original)}
                onSave={(id) => save(row.original, id)}
                SearchProvider={referenceEntitySearch(referenceEntity)}
                label={referenceEntity}
                clearable={field.nullable}
                trigger="pencil"
                clipboard={specFromCellData(cellData, row.original)}
                renderValue={(item) =>
                  item ? referenceLink(referenceEntity, item) : <NoneValue />
                }
              />
            ),
          }),
        );
        continue;
      }
      if (
        field.readKey === null ||
        field.reference ||
        field.kind === "json" ||
        field.kind === "identifier"
      ) {
        // A computed column (`readKey: null`, no reference) has nothing
        // generic to read: a full list page needs an override for it, while a
        // relation table (`only`) keeps it visible but empty. References and
        // structured values render through the detail renderer.
        const readable = field.readKey !== null || field.reference !== null;
        if (!readable && only === undefined) {
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
              className: widthClassName(field.display.width),
              mobile: toMobileColumnMeta(field.display.mobile),
            }),
            cell: ({ row }) =>
              readable ? (
                renderDetailFieldValue(row.original, field)
              ) : (
                <NoneValue />
              ),
          }),
        );
        continue;
      }
      const format = field.display.format;
      const control = field.control;
      const editable =
        onSaveField !== undefined &&
        control !== null &&
        updateFields.includes(field.key) &&
        ["text", "textarea", "number", "date", "select", "checkbox"].includes(
          control.kind,
        );
      if (
        editable &&
        (control?.kind === "text" || control?.kind === "textarea")
      ) {
        const cellData = textCellData<TRecord>(
          "text",
          (row) => copyScalarField(row, field),
          (row, value) => save(row, value),
        );
        add(
          helper.accessor((record) => copyScalarField(record, field), {
            id: columnId,
            header: field.label,
            enableSorting: defaultEnableSorting,
            meta: attachCubbyColumnMeta({
              entityColumnRole: "fact",
              provenance: field.provenance ?? undefined,
              explanation: field.explanation
                ? { entity, field: field.key, label: field.label }
                : undefined,
              className: widthClassName(field.display.width),
              mobile: toMobileColumnMeta(field.display.mobile),
              cellData,
            }),
            cell: ({ row }) => (
              <EditableCell
                value={copyScalarField(row.original, field)}
                onSave={(value) => save(row.original, value)}
                clipboard={specFromCellData(cellData, row.original)}
                config={{
                  type: "text",
                  multiline: control.kind === "textarea",
                }}
                renderValue={(value) => value ?? <NoneValue />}
              />
            ),
          }),
        );
        continue;
      }
      if (editable && control?.kind === "date") {
        const cellData = dateCellData<TRecord>(
          (row) => copyScalarField(row, field),
          (row, value) => save(row, value),
        );
        add(
          helper.accessor((record) => copyScalarField(record, field), {
            id: columnId,
            header: field.label,
            enableSorting: defaultEnableSorting,
            meta: attachCubbyColumnMeta({
              entityColumnRole: "fact",
              provenance: field.provenance ?? undefined,
              explanation: field.explanation
                ? { entity, field: field.key, label: field.label }
                : undefined,
              className: widthClassName(field.display.width),
              mobile: toMobileColumnMeta(field.display.mobile),
              cellData,
              mono: true,
            }),
            cell: ({ row }) => (
              <EditableCell
                value={copyScalarField(row.original, field)}
                onSave={(value) => save(row.original, value)}
                clipboard={specFromCellData(cellData, row.original)}
                config={{ type: "date" }}
                renderValue={(value) =>
                  value ? (
                    renderFormattedScalar(format, { kind: "date", raw: value })
                  ) : (
                    <NoneValue />
                  )
                }
              />
            ),
          }),
        );
        continue;
      }
      if (editable && control?.kind === "number") {
        const kind =
          format === "currency" || format === "signedCurrency"
            ? "currency"
            : "number";
        const cellData = numberCellData<TRecord>(
          format === "currency" || format === "signedCurrency"
            ? "currency"
            : "number",
          (row) => {
            const value = readScalarField(row, field);
            return value.kind === "number" ? value.raw : null;
          },
          (row, value) => save(row, value),
        );
        add(
          helper.accessor((record) => readScalarField(record, field).raw, {
            id: columnId,
            header: field.label,
            enableSorting: defaultEnableSorting,
            meta: attachCubbyColumnMeta({
              entityColumnRole: "fact",
              provenance: field.provenance ?? undefined,
              explanation: field.explanation
                ? { entity, field: field.key, label: field.label }
                : undefined,
              className: widthClassName(field.display.width),
              mobile: toMobileColumnMeta(field.display.mobile),
              numeric: true,
              cellData,
            }),
            cell: ({ row }) => {
              const value = readScalarField(row.original, field);
              const number = value.kind === "number" ? value.raw : null;
              const editor = (
                <EditableCell
                  value={number}
                  onSave={(next) => save(row.original, next)}
                  clipboard={specFromCellData(cellData, row.original)}
                  config={{ type: "number" }}
                  renderValue={(next) =>
                    next == null ? (
                      <NoneValue />
                    ) : format === "currency" || format === "signedCurrency" ? (
                      formatCurrency(next)
                    ) : (
                      next
                    )
                  }
                />
              );
              return kind === "currency" ? (
                <EditableCell
                  value={number}
                  onSave={(next) => save(row.original, next)}
                  clipboard={specFromCellData(cellData, row.original)}
                  config={{ type: "currency" }}
                  renderValue={(next) =>
                    next == null ? <NoneValue /> : formatCurrency(next)
                  }
                />
              ) : (
                editor
              );
            },
          }),
        );
        continue;
      }
      if (editable && control?.kind === "select") {
        const selectOptions = presentEntitySelectOptions(
          entity,
          field.key,
          control.options ?? [],
          "edit",
        );
        const cellData = selectCellData<TRecord>(
          (row) => copyScalarField(row, field),
          selectOptions,
          (row, value) => save(row, value),
        );
        add(
          helper.accessor((record) => copyScalarField(record, field), {
            id: columnId,
            header: field.label,
            enableSorting: defaultEnableSorting,
            meta: attachCubbyColumnMeta({
              entityColumnRole: "fact",
              provenance: field.provenance ?? undefined,
              explanation: field.explanation
                ? { entity, field: field.key, label: field.label }
                : undefined,
              className: widthClassName(field.display.width),
              mobile: toMobileColumnMeta(field.display.mobile),
              cellData,
            }),
            cell: ({ row }) => (
              <EditableCell
                value={copyScalarField(row.original, field)}
                onSave={(value) => save(row.original, value)}
                clipboard={specFromCellData(cellData, row.original)}
                config={{ type: "select", options: selectOptions }}
                renderValue={(value) => renderOptionCell(value, selectOptions)}
              />
            ),
          }),
        );
        continue;
      }
      if (editable && control?.kind === "checkbox") {
        const cellData = booleanCellData<TRecord>(
          (row) => {
            const value = readScalarField(row, field);
            return value.kind === "boolean" ? value.raw : null;
          },
          (row, value) => save(row, value),
        );
        add(
          helper.accessor((record) => readScalarField(record, field).raw, {
            id: columnId,
            header: field.label,
            enableSorting: defaultEnableSorting,
            meta: attachCubbyColumnMeta({
              entityColumnRole: "fact",
              provenance: field.provenance ?? undefined,
              explanation: field.explanation
                ? { entity, field: field.key, label: field.label }
                : undefined,
              className: widthClassName(field.display.width),
              mobile: toMobileColumnMeta(field.display.mobile),
              cellData,
            }),
            cell: ({ row }) => {
              const value = readScalarField(row.original, field);
              const checked = value.kind === "boolean" && value.raw;
              return (
                <Checkbox
                  checked={checked}
                  onCheckedChange={(next) => {
                    void save(row.original, next);
                  }}
                  aria-label={`Set ${field.label}`}
                />
              );
            },
          }),
        );
        continue;
      }
      add(
        helper.accessor((record) => readScalarField(record, field).raw, {
          id: columnId,
          header: field.label,
          enableSorting: defaultEnableSorting,
          meta: attachCubbyColumnMeta({
            entityColumnRole: "fact",
            provenance: field.provenance ?? undefined,
            explanation: field.explanation
              ? { entity, field: field.key, label: field.label }
              : undefined,
            className: widthClassName(field.display.width),
            numeric:
              format === "currency" || format === "signedCurrency"
                ? true
                : undefined,
            mobile: toMobileColumnMeta(field.display.mobile),
            cellData: cellDataForField<TRecord>(field),
          }),
          cell: ({ row }) =>
            renderFormattedScalar(
              format,
              readScalarField(row.original, field),
            ) ?? <NoneValue />,
        }),
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
