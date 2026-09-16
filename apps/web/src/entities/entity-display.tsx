import type { Entity } from "@cubby/schemas/entity";
import {
  entityFieldModels,
  type EntityFieldModel,
} from "@cubby/schemas/entity-fields";
import { generatedEntitySort } from "@cubby/schemas/entity-sort";
import { entitySummary } from "@cubby/schemas/entity-summary";
import type { ReactNode } from "react";
import { z } from "zod";

import {
  dateCellData,
  numberCellData,
  textCellData,
  timestampCellData,
} from "~/app/_components/data-table/cell-data";
import { renderOptionCell } from "~/app/_components/data-table/columnHelpers";
import {
  EditableCell,
  type FilterableComboboxItem,
} from "~/app/_components/data-table/editable-cell";
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
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import {
  renderScalarValue,
  type ScalarDisplayValue,
} from "~/components/common/scalar-value";
import { NoneValue } from "~/components/ui/none-value";
import { formatCurrency } from "~/lib/utils";

type DisplayField = EntityFieldModel["fields"][number];
type DisplaySurface = "list" | "detail";
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
): ReactNode {
  if (value.kind === "empty") return renderScalarValue(value, "list");
  switch (format) {
    case "currency":
      return value.kind === "number" ? (
        <span className="text-positive">{formatCurrency(value.raw)}</span>
      ) : (
        renderScalarValue(value, "list")
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
        renderScalarValue(value, "list")
      );
    case "plainDate":
      return renderScalarValue(
        {
          kind: "date",
          raw: value.kind === "date" ? value.raw : String(value.raw),
        },
        "list",
      );
    case "timestamp":
      return renderScalarValue(
        {
          kind: "timestamp",
          raw: value.kind === "timestamp" ? value.raw : String(value.raw),
        },
        "list",
      );
    case "external-link": {
      const href = value.kind === "text" ? value.raw : String(value.raw);
      return href ? <ExternalLinkText href={href} truncate /> : <NoneValue />;
    }
    case null:
      return renderScalarValue(value, "list");
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
      return { kind: "list", raw: z.array(z.string()).parse(value) };
    // A reference reads as its shortcode(s); a page that wants a link
    // overrides the field.
    case "identifier": {
      if (field.reference?.multiple)
        return { kind: "list", raw: z.array(z.string()).parse(value) };
      const raw = z.string().parse(value);
      return { kind: "text", raw, label: raw };
    }
    default:
      throw new Error(
        `Display field ${field.key} needs a specialized renderer`,
      );
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
    default:
      return String(value.raw);
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

export function EntityBasicInfo<TRecord extends object>({
  entity,
  record,
  overrides = {},
  afterFields = {},
  fields: fieldKeys,
  actions,
  header,
  footer,
}: {
  entity: Entity;
  record: TRecord;
  /** A declared `fields` section's keys; every `display.detail` field when omitted. */
  fields?: readonly string[];
  overrides?: Readonly<
    Record<
      string,
      (record: TRecord) => Omit<BasicInfoField, "label"> & { label?: string }
    >
  >;
  /** Computed facts retain their domain renderer beside the declared field
   * they enrich. They do not become persisted entity fields. */
  afterFields?: Readonly<Record<string, readonly BasicInfoField[]>>;
  actions?: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
}) {
  const fields = entityDetailFields(entity, fieldKeys);
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
      fields={fields.flatMap((field) => [
        {
          label: field.label,
          ...(overrides[field.key]?.(record) ?? {
            value: renderScalarValue(readScalarField(record, field), "detail"),
          }),
        },
        ...(afterFields[field.key] ?? []),
      ])}
    />
  );
}

/** The concrete value shapes a generic `EditableCell` config can save. */
type EditableFieldValue = string | number | null;
const editableFieldValue = z.union([z.string(), z.number()]).nullable();

/**
 * A field's editable control, derived from its declared `control.kind` and
 * `display.format` — the same generic mapping `editableFieldOverrides` below
 * uses for every field in its `keys`. Only the plain scalar shapes: a
 * boolean (`checkbox`) has no `EditableCell` config, and `specialized`
 * controls are, by definition, hand-rendered.
 */
function renderEditableField(
  control: NonNullable<DisplayField["control"]>,
  format: DisplayField["display"]["format"],
  value: EditableFieldValue,
  save: (next: EditableFieldValue) => Promise<void>,
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
      const options: FilterableComboboxItem[] = [...(control.options ?? [])];
      return (
        <EditableCell
          value={value === null ? null : String(value)}
          config={{ type: "select", options }}
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
      const value = editableFieldValue.parse(
        record[field.readKey as keyof TRecord],
      );
      const save = async (next: EditableFieldValue): Promise<void> => {
        await mutate({ id: record.id, data: { [key]: next } });
      };
      const override = () => ({
        value: renderEditableField(control, field.display.format, value, save),
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
  return createCubbyColumnCollection<TRecord>((add) => {
    const usedOverrides = new Set<string>();
    for (const field of orderedListFields(entity)) {
      if (field.display.standard) continue;
      const columnId = field.display.columnId ?? field.key;
      const defaultEnableSorting = sortableColumnIds.includes(columnId);
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
      if (
        field.readKey === null ||
        field.reference ||
        field.kind === "json" ||
        field.kind === "identifier"
      ) {
        throw new Error(
          `Display field ${entity}.${field.key} needs a specialized column`,
        );
      }
      const format = field.display.format;
      add(
        helper.accessor((record) => readScalarField(record, field).raw, {
          id: columnId,
          header: field.label,
          enableSorting: defaultEnableSorting,
          meta: attachCubbyColumnMeta({
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
