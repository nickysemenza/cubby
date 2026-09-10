import type { Entity } from "@cubby/schemas/entity";
import {
  entityFieldModels,
  type EntityFieldModel,
} from "@cubby/schemas/entity-fields";
import { format } from "date-fns";
import type { ReactNode } from "react";
import { z } from "zod";

import {
  numberCellData,
  textCellData,
} from "~/app/_components/data-table/cell-data";
import {
  createCubbyColumnCollection,
  type CubbyColumnCollection,
  type CubbyColumnHelper,
} from "~/app/_components/data-table/table-features";
import { attachCubbyColumnMeta } from "~/app/_components/data-table/table-meta";
import { HoverableTimestamp } from "~/app/_components/HoverableTimestamp";
import { BasicInfo, type BasicInfoField } from "~/components/common/basic-info";
import { NoneValue } from "~/components/ui/none-value";
import { parsePlainDate } from "~/lib/plain-date";

type DisplayField = EntityFieldModel["fields"][number];
type DisplaySurface = "list" | "detail";
type ScalarDisplayValue =
  | { kind: "empty"; raw: null | undefined }
  | { kind: "text"; raw: string; label: string }
  | { kind: "number"; raw: number }
  | { kind: "boolean"; raw: boolean }
  | { kind: "date"; raw: string }
  | { kind: "timestamp"; raw: string | Date }
  | { kind: "list"; raw: string[] };

const entityDisplayFields = (entity: Entity, surface: DisplaySurface) =>
  entityFieldModels[entity].fields.filter((field) => field.display[surface]);

function readScalarField<TRecord extends object>(
  record: TRecord,
  field: DisplayField,
): ScalarDisplayValue {
  if (!field.readKey)
    throw new Error(`Display field ${field.key} needs a renderer`);
  if (field.reference)
    throw new Error(`Display field ${field.key} needs a specialized renderer`);
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
    default:
      throw new Error(
        `Display field ${field.key} needs a specialized renderer`,
      );
  }
}

function renderScalarField<TRecord extends object>(
  record: TRecord,
  field: DisplayField,
  surface: DisplaySurface = "detail",
): ReactNode {
  const value = readScalarField(record, field);
  switch (value.kind) {
    case "empty":
      return value.raw === undefined ? undefined : <NoneValue />;
    case "timestamp":
      return <HoverableTimestamp timestamp={value.raw} />;
    case "date":
      return format(parsePlainDate(value.raw), "MMM d, yyyy");
    case "boolean":
      return value.raw ? "Yes" : "No";
    case "number":
      return value.raw;
    case "list":
      return value.raw.length ? value.raw.join(", ") : <NoneValue />;
    case "text":
      return value.label ? (
        <span
          className={
            surface === "list"
              ? "block truncate"
              : "break-words whitespace-pre-wrap"
          }
          title={surface === "list" ? value.label : undefined}
        >
          {value.label}
        </span>
      ) : (
        <NoneValue />
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

export function EntityBasicInfo<TRecord extends object>({
  entity,
  record,
  overrides = {},
  afterFields = {},
  section = "overview",
  actions,
  header,
  footer,
}: {
  entity: Entity;
  record: TRecord;
  section?: string;
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
  const fields = entityDisplayFields(entity, "detail")
    .filter((field) => field.display.detailSection === section)
    .sort(
      (left, right) =>
        (left.display.detailOrder ?? Number.MAX_SAFE_INTEGER) -
        (right.display.detailOrder ?? Number.MAX_SAFE_INTEGER),
    );
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
            value: renderScalarField(record, field),
          }),
        },
        ...(afterFields[field.key] ?? []),
      ])}
    />
  );
}

/** Specialized columns retain their cell behavior and table metadata. Declared
 * membership, field accessors, and plain headers belong to the entity model. */
export function createEntityDisplayColumns<TRecord extends object>(
  entity: Entity,
  helper: CubbyColumnHelper<TRecord>,
  overrides?: CubbyColumnCollection<TRecord>,
): CubbyColumnCollection<TRecord> {
  return createCubbyColumnCollection<TRecord>((add) => {
    const usedOverrides = new Set<string>();
    for (const field of entityDisplayFields(entity, "list")) {
      if (field.display.standard) continue;
      const columnId = field.display.columnId ?? field.key;
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
        });
      });
      if (overridden) continue;
      if (
        field.reference ||
        field.kind === "json" ||
        field.kind === "identifier"
      ) {
        throw new Error(
          `Display field ${entity}.${field.key} needs a specialized column`,
        );
      }
      add(
        helper.accessor((record) => readScalarField(record, field).raw, {
          id: columnId,
          header: field.label,
          meta: attachCubbyColumnMeta({
            cellData:
              field.kind === "number"
                ? numberCellData<TRecord>("number", (record) => {
                    const value = readScalarField(record, field);
                    return value.kind === "number" ? value.raw : null;
                  })
                : textCellData<TRecord>("text", (record) =>
                    copyScalarField(record, field),
                  ),
          }),
          cell: ({ row }) =>
            renderScalarField(row.original, field, "list") ?? <NoneValue />,
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
