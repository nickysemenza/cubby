import { fieldSuggestionsInput } from "@cubby/schemas/ai";
import { aiSmokeInputs, type AiSmokeScenario } from "@cubby/schemas/ai-smoke";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { projectKindValues } from "@cubby/schemas/project-fields";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { z } from "zod";

import { entityListFor } from "~/entity/entity-list";
import type { PickerSearchEntity } from "~/entity/picker/entity-search-hooks";
import { Picker } from "~/entity/picker/picker";
import { referenceEntitySearch } from "~/entity/picker/reference-entity-search";
import type { ComboboxItem } from "~/ui/combobox/combobox-types";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { Button } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";
import { Textarea } from "~/ui/primitives/textarea";

const ENTITY_OPTIONS: readonly PickerOption[] =
  fieldSuggestionsInput.shape.entity.options.map((option) => ({
    value: option,
    label: option,
  }));

const BASIS_MODE_OPTIONS: readonly PickerOption[] =
  fieldSuggestionsInput.shape.basisMode.options.map((option) => ({
    value: option,
    label: option,
  }));

/** A captioned choose-mode picker; the caption doubles as its accessible name. */
function SmokeChoice({
  caption,
  options,
  value,
  onValueChange,
}: {
  caption: string;
  options: readonly PickerOption[];
  value: string;
  onValueChange: (value: string | null) => void;
}) {
  return (
    <div className="grid gap-1 text-sm font-medium">
      <span>{caption}</span>
      <Picker
        mode="choose"
        label={caption}
        options={options}
        value={value}
        onValueChange={onValueChange}
      />
    </div>
  );
}

const smokePropertySchema = z.object({
  type: z.union([z.string(), z.array(z.string())]).optional(),
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
): "record" | "select" | "checkbox" | "text" | "json" | "unsupported" {
  if (imageFields.has(name) || name === "runId" || name in pickerEntity)
    return "record";
  if (field.enum) return "select";
  const types = Array.isArray(field.type)
    ? field.type
    : field.type == null
      ? []
      : [field.type];
  if (types.includes("boolean")) return "checkbox";
  if (types.includes("string")) return "text";
  if (types.includes("array") || types.includes("object")) return "json";
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
      .map(([key, field]) => {
        const types = Array.isArray(field.type)
          ? field.type
          : field.type == null
            ? []
            : [field.type];
        return [
          key,
          field.enum?.[0] ??
            (types.includes("array")
              ? []
              : types.includes("object")
                ? {}
                : types.includes("boolean")
                  ? false
                  : ""),
        ];
      }),
  );
}

function StructuredJsonField({
  name,
  value,
  fieldType,
  onChange,
}: {
  name: string;
  value: SmokeValue | undefined;
  fieldType: "array" | "object";
  onChange: (value: SmokeValue) => void;
}) {
  const initialValue = value ?? (fieldType === "array" ? [] : {});
  const [draft, setDraft] = useState(() =>
    JSON.stringify(initialValue, null, 2),
  );
  const [invalidJson, setInvalidJson] = useState(false);
  const label = name.replace(/([A-Z])/g, " $1");
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <Textarea
        aria-label={label}
        aria-invalid={invalidJson}
        value={draft}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          try {
            const parsed = z.json().parse(JSON.parse(next));
            setInvalidJson(false);
            onChange(parsed);
          } catch {
            // SILENT: The inline invalid-JSON alert surfaces parse failure; submit the draft so validation cannot reuse stale data.
            setInvalidJson(true);
            onChange(next);
          }
        }}
      />
      {invalidJson && (
        <span role="alert" className="text-destructive">
          Enter valid JSON before running this probe.
        </span>
      )}
    </label>
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
    ...entityListFor("image").queryOptions({
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
    <Picker
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
    ...entityListFor("run").queryOptions({
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
    <Picker
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
    <Picker
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
  const Search = referenceEntitySearch(entity);
  return <Search>{renderPicker}</Search>;
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
      <SmokeChoice
        caption="Entity"
        options={ENTITY_OPTIONS}
        value={entity}
        onValueChange={(next) => {
          if (next == null) return;
          onChange({
            entity: next,
            basisMode: value.basisMode ?? "provided",
            targets: [],
            basis: {},
          });
        }}
      />
      <SmokeChoice
        caption="Basis mode"
        options={BASIS_MODE_OPTIONS}
        value={String(value.basisMode ?? "provided")}
        onValueChange={(next) => {
          if (next != null) onChange({ ...value, basisMode: next });
        }}
      />
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
          <SmokeChoice
            key={key}
            caption={`Basis · ${key}`}
            options={[
              { value: "", label: "Unspecified" },
              ...options.map((option) => ({
                value: option.value,
                label: option.label,
              })),
            ]}
            value={basis[key] ?? ""}
            onValueChange={(next) =>
              onChange({
                ...value,
                basis: { ...basis, [key]: next || null },
              })
            }
          />
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
            <SmokeChoice
              key={name}
              caption={name.replace(/([A-Z])/g, " $1")}
              options={field.enum.map((option) => ({
                value: option,
                label: option.replaceAll("_", " "),
              }))}
              value={String(value[name] ?? field.enum[0])}
              onValueChange={(next) => {
                if (next != null) onChange({ ...value, [name]: next });
              }}
            />
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
        if (control === "text")
          return (
            <label key={name} className="grid gap-1 text-sm font-medium">
              {name.replace(/([A-Z])/g, " $1")}
              <Input
                value={z.string().catch("").parse(value[name])}
                onChange={(event) =>
                  onChange({ ...value, [name]: event.target.value })
                }
              />
            </label>
          );
        if (control === "json") {
          const fieldType = Array.isArray(field.type)
            ? field.type.find(
                (type): type is "array" | "object" =>
                  type === "array" || type === "object",
              )
            : field.type === "array" || field.type === "object"
              ? field.type
              : null;
          if (fieldType)
            return (
              <StructuredJsonField
                key={`${scenario}:${name}`}
                name={name}
                value={value[name]}
                fieldType={fieldType}
                onChange={(next) => onChange({ ...value, [name]: next })}
              />
            );
        }
        return (
          <p key={name} className="text-sm text-destructive">
            No form control for {name}
          </p>
        );
      })}
    </div>
  );
}
