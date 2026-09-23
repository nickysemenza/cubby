import { fieldSuggestionsInput } from "@cubby/schemas/ai";
import { aiSmokeInputs, type AiSmokeScenario } from "@cubby/schemas/ai-smoke";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { projectKindValues } from "@cubby/schemas/project-fields";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { z } from "zod";

import {
  buildSearchHitComboboxItem,
  buildVendorComboboxItem,
} from "~/app/_components/combobox/combobox-builders";
import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { EntityPicker } from "~/app/_components/combobox/entity-picker";
import type { PickerSearchEntity } from "~/app/_components/combobox/entity-search-hooks";
import { WithEntitySearch } from "~/app/_components/combobox/with-search-hook";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import { image } from "~/entities/image.functions";
import { run } from "~/entities/run.functions";

const smokePropertySchema = z.object({
  type: z.string().optional(),
  enum: z.array(z.string()).optional(),
});
export const smokeObjectSchema = z.object({
  properties: z.record(z.string(), smokePropertySchema).optional(),
  required: z.array(z.string()).optional(),
});
const smokeFormValues = z.record(z.string(), z.json());
export type SmokeFormValue = z.infer<typeof smokeFormValues>;
type SmokeValue = z.infer<ReturnType<typeof z.json>>;
type SmokeProperty = z.infer<typeof smokePropertySchema>;

const pickerEntity = {
  ingredientId: "ingredient",
  ingredientIds: "ingredient",
  productId: "product",
  recipeId: "recipe",
  locationId: "location",
} as const;

const imageFields = new Set(["imageId", "imageIds"]);

export function smokeFieldControl(
  name: string,
  field: SmokeProperty,
): "record" | "select" | "checkbox" | "unsupported" {
  if (imageFields.has(name) || name === "runId" || name in pickerEntity)
    return "record";
  if (field.enum) return "select";
  if (field.type === "boolean") return "checkbox";
  return "unsupported";
}

export function defaultSmokeInput(scenario: AiSmokeScenario) {
  if (scenario === "fieldSuggestions")
    return {
      entity: "product",
      basisMode: "provided",
      targets: ["categoryId"],
      basis: { name: "cordless drill" },
    };
  if (scenario === "externalIdKind") return { fixture: "manufacturer_sku" };
  const schema = smokeObjectSchema.parse(
    z.toJSONSchema(aiSmokeInputs[scenario]),
  );
  return Object.fromEntries(
    Object.entries(schema.properties ?? {})
      .filter(([key]) => schema.required?.includes(key))
      .map(([key, field]) => [
        key,
        field.enum?.[0] ??
          (field.type === "array"
            ? []
            : field.type === "object"
              ? {}
              : field.type === "boolean"
                ? false
                : ""),
      ]),
  );
}

function ImagePicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | null;
  onChange: (item: ComboboxItem | null) => void;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ComboboxItem | null>(null);
  const query = useQuery({
    ...image.list.queryOptions({
      filters: search ? { nameFilter: search } : {},
      pagination: { pageIndex: 0, pageSize: 50 },
    }),
    enabled: open,
  });
  const items = useMemo(
    () =>
      (query.data?.items ?? []).map((row) => ({
        id: row.id,
        name: row.filename ?? row.id,
        shortcode: row.id,
      })),
    [query.data?.items],
  );
  return (
    <EntityPicker
      label={label}
      items={items}
      value={selected?.id === value ? selected : null}
      setValue={(item) => {
        setSelected(item);
        onChange(item);
      }}
      onSearchChange={setSearch}
      onOpenChange={setOpen}
      isLoading={query.isLoading}
      placeholder="Find an image"
      clearable
    />
  );
}

function RunPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | null;
  onChange: (item: ComboboxItem | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ComboboxItem | null>(null);
  const query = useQuery({
    ...run.list.queryOptions({
      filters: {},
      pagination: { pageIndex: 0, pageSize: 100 },
    }),
    enabled: open,
  });
  const items = useMemo(
    () =>
      (query.data?.items ?? []).map((row) => ({
        id: row.id,
        shortcode: row.id,
        name: row.displayName,
        secondary: row.id,
      })),
    [query.data?.items],
  );
  return (
    <EntityPicker
      label={label}
      items={items}
      value={selected?.id === value ? selected : null}
      setValue={(item) => {
        setSelected(item);
        onChange(item);
      }}
      onOpenChange={setOpen}
      isLoading={query.isLoading}
      placeholder="Find a recent Run"
      clearable
    />
  );
}

function RecordPicker({
  entity,
  label,
  value,
  onChange,
}: {
  entity: PickerSearchEntity;
  label: string;
  value: string | null;
  onChange: (item: ComboboxItem | null) => void;
}) {
  const [selected, setSelected] = useState<ComboboxItem | null>(null);
  const renderPicker = (search: {
    items: ComboboxItem[];
    onSearchChange: (query: string) => void;
    onOpenChange: (open: boolean) => void;
    isLoading: boolean;
  }) => (
    <EntityPicker
      {...search}
      entity={entity}
      label={label}
      value={selected?.id === value ? selected : null}
      setValue={(item) => {
        setSelected(item);
        onChange(item);
      }}
      placeholder={`Find ${entity}`}
      clearable
    />
  );
  if (entity === "vendor")
    return (
      <WithEntitySearch
        entity="vendor"
        build={(row) => buildVendorComboboxItem(row, { itemId: "shortcode" })}
        buildSearchHit={(hit) => buildSearchHitComboboxItem(hit, "vendor")}
      >
        {renderPicker}
      </WithEntitySearch>
    );
  return <WithEntitySearch entity={entity}>{renderPicker}</WithEntitySearch>;
}

function RecordField({
  name,
  value,
  onChange,
}: {
  name: string;
  value: SmokeValue | undefined;
  onChange: (value: SmokeValue) => void;
}) {
  const multi = name.endsWith("Ids");
  const selected = multi ? z.array(z.string()).catch([]).parse(value) : [];
  const current = multi ? null : z.string().nullable().catch(null).parse(value);
  const onPick = (item: ComboboxItem | null) => {
    if (!multi) {
      onChange(item?.id ?? "");
      return;
    }
    if (item && !selected.includes(item.id)) onChange([...selected, item.id]);
  };
  const entity = Object.entries(pickerEntity).find(
    ([field]) => field === name,
  )?.[1];
  const picker =
    name === "runId" ? (
      <RunPicker label={name} value={current} onChange={onPick} />
    ) : imageFields.has(name) ? (
      <ImagePicker label={name} value={current} onChange={onPick} />
    ) : entity ? (
      <RecordPicker
        entity={entity}
        label={name}
        value={current}
        onChange={onPick}
      />
    ) : null;
  return (
    <div className="grid gap-2">
      <label className="text-sm font-medium">
        {name.replace(/([A-Z])/g, " $1")}
      </label>
      {picker}
      {multi && selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((id) => (
            <Button
              key={id}
              size="sm"
              variant="outline"
              type="button"
              onClick={() => onChange(selected.filter((item) => item !== id))}
            >
              {id} ×
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function FieldSuggestionFields({
  value,
  onChange,
}: {
  value: SmokeFormValue;
  onChange: (next: SmokeFormValue) => void;
}) {
  const entity = fieldSuggestionsInput.shape.entity
    .catch("product")
    .parse(value.entity);
  const model = entityFieldModels[entity];
  const fields = model?.fields ?? [];
  const targets = fields.filter((field) => field.control?.suggest);
  const selected = z.array(z.string()).catch([]).parse(value.targets);
  const basisKeys = [
    ...new Set(
      selected.flatMap((target) => {
        const field = fields.find((candidate) => candidate.key === target);
        if (!field?.control?.suggest) return [];
        return [
          ...field.control.suggest.basis,
          ...(field.control.suggest.mode === "prune" ? [target] : []),
        ];
      }),
    ),
  ];
  const basis = z
    .record(z.string(), z.string().nullable())
    .catch({})
    .parse(value.basis);
  return (
    <div className="grid gap-3">
      <label className="grid gap-1 text-sm font-medium">
        Entity
        <NativeSelect
          value={entity}
          onChange={(event) =>
            onChange({
              entity: event.target.value,
              basisMode: value.basisMode ?? "provided",
              targets: [],
              basis: {},
            })
          }
        >
          {fieldSuggestionsInput.shape.entity.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </NativeSelect>
      </label>
      <label className="grid gap-1 text-sm font-medium">
        Basis mode
        <NativeSelect
          value={String(value.basisMode ?? "provided")}
          onChange={(event) =>
            onChange({ ...value, basisMode: event.target.value })
          }
        >
          {fieldSuggestionsInput.shape.basisMode.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </NativeSelect>
      </label>
      <fieldset className="grid gap-1">
        <legend className="text-sm font-medium">Targets</legend>
        <div className="grid max-h-40 gap-1 overflow-y-auto rounded-md border border-border p-2 sm:grid-cols-2">
          {targets.map((field) => (
            <label key={field.key} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(field.key)}
                onChange={(event) =>
                  onChange({
                    ...value,
                    targets: event.target.checked
                      ? [...selected, field.key]
                      : selected.filter((item) => item !== field.key),
                  })
                }
              />
              {field.key}
            </label>
          ))}
        </div>
      </fieldset>
      {basisKeys.map((key) => {
        const field = fields.find((candidate) => candidate.key === key);
        const reference = field?.reference?.entity;
        const options =
          field?.control?.options ??
          (entity === "project" && key === "kind"
            ? projectKindValues.map((value) => ({ value, label: value }))
            : null);
        const pickable =
          reference &&
          [
            "ingredient",
            "location",
            "product",
            "recipe",
            "project",
            "task",
            "plant",
            "planting",
            "vendor",
            "ledgerParty",
          ].includes(reference);
        return pickable ? (
          <div key={key} className="grid gap-1">
            <RecordPicker
              // SAFETY: pickable is true only for entities in PickerSearchEntity.
              entity={reference as PickerSearchEntity}
              label={`Basis · ${key}`}
              value={basis[key] ?? null}
              onChange={(item) =>
                onChange({
                  ...value,
                  basis: { ...basis, [key]: item?.id ?? null },
                })
              }
            />
          </div>
        ) : options ? (
          <label key={key} className="grid gap-1 text-sm font-medium">
            Basis · {key}
            <NativeSelect
              value={basis[key] ?? ""}
              onChange={(event) =>
                onChange({
                  ...value,
                  basis: { ...basis, [key]: event.target.value || null },
                })
              }
            >
              <option value="">Unspecified</option>
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          </label>
        ) : (
          <label key={key} className="grid gap-1 text-sm font-medium">
            Basis · {key}
            <Input
              value={basis[key] ?? ""}
              onChange={(event) =>
                onChange({
                  ...value,
                  basis: { ...basis, [key]: event.target.value || null },
                })
              }
            />
          </label>
        );
      })}
    </div>
  );
}

export function AiSmokeForm({
  scenario,
  schema,
  value,
  onChange,
}: {
  scenario: AiSmokeScenario;
  schema: SmokeValue;
  value: SmokeFormValue;
  onChange: (next: SmokeFormValue) => void;
}) {
  if (scenario === "fieldSuggestions")
    return <FieldSuggestionFields value={value} onChange={onChange} />;
  const form = smokeObjectSchema.parse(schema);
  return (
    <div className="grid gap-3">
      {Object.entries(form.properties ?? {}).map(([name, field]) => {
        if (
          scenario === "purchaseAudit" &&
          ((name === "runId" && value.source !== "run") ||
            (name === "fixture" && value.source === "run"))
        )
          return null;
        const control = smokeFieldControl(name, field);
        if (control === "record")
          return (
            <RecordField
              key={name}
              name={name}
              value={value[name]}
              onChange={(next) => onChange({ ...value, [name]: next })}
            />
          );
        if (control === "select" && field.enum)
          return (
            <label key={name} className="grid gap-1 text-sm font-medium">
              {name.replace(/([A-Z])/g, " $1")}
              <NativeSelect
                value={String(value[name] ?? field.enum[0])}
                onChange={(event) =>
                  onChange({ ...value, [name]: event.target.value })
                }
              >
                {field.enum.map((option) => (
                  <option key={option} value={option}>
                    {option.replaceAll("_", " ")}
                  </option>
                ))}
              </NativeSelect>
            </label>
          );
        if (control === "checkbox")
          return (
            <label
              key={name}
              className="flex items-center gap-2 text-sm font-medium"
            >
              <input
                type="checkbox"
                checked={z.boolean().catch(false).parse(value[name])}
                onChange={(event) =>
                  onChange({ ...value, [name]: event.target.checked })
                }
              />
              {name.replace(/([A-Z])/g, " $1")}
            </label>
          );
        return (
          <p key={name} className="text-sm text-destructive">
            No form control for {name}
          </p>
        );
      })}
    </div>
  );
}
