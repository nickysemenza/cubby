import type {
  StructuredField,
  StructuredNode,
  StructuredOption,
  StructuredValueSchema,
} from "@cubby/schemas/structured-value-schema";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { useId } from "react";
import {
  Controller,
  get,
  useFormState,
  useWatch,
  type FieldValues,
  type UseFormReturn,
} from "react-hook-form";
import { z } from "zod";

import {
  isReferencePickerEntity,
  requireReferenceEntitySearch,
} from "~/ui/combobox/reference-entity-search";
import { StaticPicker } from "~/ui/combobox/static-picker";
import {
  NullableNumericField,
  PlainDateField,
  SelectField,
  UnifiedTextField,
} from "~/ui/form-utils";
import { EntityValueField } from "~/ui/form-utils/entity-value-field";
import { ArrayFieldManager } from "~/ui/forms/array-field-manager";
import { FormFieldGroup } from "~/ui/forms/form-field-group";
import { Row } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Checkbox } from "~/ui/primitives/checkbox";

import { blank, blankCase, isDrawn } from "./structured-value";

/**
 * The one structured-value editor, drawn from a field's generated `StructuredValueSchema` (the
 * same description CubbyKit's `StructuredValueEditor` draws), so a new structured field is a
 * declaration, not a form. Every control is an existing form primitive bound to a nested
 * react-hook-form path (`sourceClaims.0.normalizedEvidence.amount`), so a server issue lands on the
 * position it names and an untouched hidden key (a row id, a claim's `sourceKey`) rides along in the
 * form value. Validation stays server-side.
 */
type Form = UseFormReturn<FieldValues>;
type NodeProps = {
  form: Form;
  path: string;
  label: string;
  schema: StructuredValueSchema;
  /** The input schema rejects this key absent; an optional one may be cleared. */
  required: boolean;
};

// SAFETY: a nested structured path (`rows.0.unit`) is a runtime string, and the form's
// field-path type cannot express a roster that is only known from the generated schema.
const asPath = (path: string) => path as never;

const singular = (label: string) =>
  label.length > 1 && label.endsWith("s") ? label.slice(0, -1) : label;

export function StructuredValueField({
  form,
  name,
  label,
  schema,
}: {
  form: Form;
  name: string;
  label: string;
  schema: StructuredValueSchema;
}) {
  return (
    <NodeEditor
      form={form}
      path={name}
      label={label}
      schema={schema}
      required
    />
  );
}

/** An amount or any composite value is added and removed as a whole when it may be `null`. */
const addedAsWhole = (node: StructuredNode) =>
  "amount" in node ||
  "object" in node ||
  "array" in node ||
  "map" in node ||
  "variant" in node;

function NodeEditor(props: NodeProps) {
  const { schema } = props;
  if (!isDrawn(schema)) return null;
  return schema.nullable && addedAsWhole(schema.node) ? (
    <NullableWhole {...props} />
  ) : (
    <NodeBody {...props} />
  );
}

function NullableWhole(props: NodeProps) {
  const { form, path, label, schema } = props;
  const value = useWatch({ control: form.control, name: path });
  const noun = label ? singular(label).toLowerCase() : "value";
  if (value === null || value === undefined)
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() =>
          form.setValue(path, blank(schema, true), {
            shouldDirty: true,
          })
        }
      >
        <PlusIcon className="mr-2 size-3.5" />
        Add {noun}
      </Button>
    );
  return (
    <div className="space-y-2">
      <NodeBody {...props} />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() => form.setValue(path, null, { shouldDirty: true })}
      >
        Remove {noun}
      </Button>
    </div>
  );
}

function NodeBody(props: NodeProps) {
  const { node } = props.schema;
  if ("text" in node)
    return <TextEditor {...props} format={node.text.format} />;
  if ("number" in node)
    return (
      <NullableNumericField
        form={props.form}
        name={asPath(props.path)}
        label={props.label}
        placeholder=""
        step={node.number.integer ? "1" : "any"}
      />
    );
  if ("boolean" in node) return <BooleanEditor {...props} />;
  if ("enum" in node)
    return (
      <SelectField
        form={props.form}
        name={asPath(props.path)}
        label={props.label}
        options={node.enum.options}
        nullable={props.schema.nullable}
      />
    );
  if ("reference" in node)
    return <ReferenceEditor {...props} entity={node.reference.entity} />;
  if ("amount" in node)
    return <AmountEditor {...props} upper={node.amount.upper} />;
  if ("object" in node)
    return <ObjectEditor {...props} fields={node.object.fields} />;
  if ("array" in node) return <ArrayEditor {...props} item={node.array.item} />;
  if ("map" in node)
    return <MapEditor {...props} keys={node.map.keys} item={node.map.value} />;
  if ("variant" in node)
    return (
      <VariantEditor
        {...props}
        discriminator={node.variant.discriminator}
        cases={node.variant.cases}
      />
    );
  return null;
}

function TextEditor({
  form,
  path,
  label,
  schema,
  required,
  format,
}: NodeProps & { format: string | null }) {
  if (format === "date")
    return (
      <PlainDateField
        form={form}
        name={asPath(path)}
        label={label}
        clearable={schema.nullable || !required}
      />
    );
  return (
    <UnifiedTextField
      form={form}
      name={asPath(path)}
      label={label}
      placeholder=""
      nullable={schema.nullable}
    />
  );
}

function BooleanEditor({ form, path, label }: NodeProps) {
  const controlId = useId();
  return (
    <Controller
      control={form.control}
      name={asPath(path)}
      render={({ field, fieldState }) => (
        <FormFieldGroup
          htmlFor={controlId}
          label={label}
          invalid={fieldState.invalid}
          error={fieldState.error}
        >
          <Row gap="sm" align="start">
            <Checkbox
              id={controlId}
              checked={field.value === true}
              name={field.name}
              onBlur={field.onBlur}
              ref={field.ref}
              onCheckedChange={(checked) => field.onChange(checked === true)}
              aria-invalid={fieldState.invalid}
            />
          </Row>
        </FormFieldGroup>
      )}
    />
  );
}

function ReferenceEditor({
  form,
  path,
  label,
  schema,
  required,
  entity,
}: NodeProps & { entity: string }) {
  if (!isReferencePickerEntity(entity))
    return (
      <UnifiedTextField
        form={form}
        name={asPath(path)}
        label={label}
        placeholder={`${label} code`}
        nullable={schema.nullable}
      />
    );
  return (
    <EntityValueField
      form={form}
      name={asPath(path)}
      entity={entity}
      label={label}
      clearable={schema.nullable || !required}
      SearchProvider={requireReferenceEntitySearch(entity)}
    />
  );
}

function AmountEditor({
  form,
  path,
  label,
  upper,
}: NodeProps & { upper: boolean }) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-24 flex-1">
        <NullableNumericField
          form={form}
          name={asPath(`${path}.value`)}
          label={label}
          placeholder=""
          step="any"
        />
      </div>
      {upper ? (
        <div className="min-w-24 flex-1">
          <NullableNumericField
            form={form}
            name={asPath(`${path}.upperValue`)}
            label={`${label} up to`}
            placeholder=""
            step="any"
          />
        </div>
      ) : null}
      <div className="min-w-24 flex-1">
        <UnifiedTextField
          form={form}
          name={asPath(`${path}.unit`)}
          label={`${label} unit`}
          placeholder=""
        />
      </div>
    </div>
  );
}

function FieldRows({
  form,
  path,
  fields,
}: {
  form: Form;
  path: string;
  fields: readonly StructuredField[];
}) {
  return (
    <>
      {fields
        .filter((field) => isDrawn(field.schema))
        .map((field) => (
          <NodeEditor
            key={field.key}
            form={form}
            path={`${path}.${field.key}`}
            label={field.label}
            schema={field.schema}
            required={field.required}
          />
        ))}
    </>
  );
}

function ObjectEditor({
  form,
  path,
  label,
  fields,
}: NodeProps & { fields: readonly StructuredField[] }) {
  return (
    <fieldset
      className="min-w-0 flex-1 space-y-3"
      // The field's own fieldset already names the top-level object.
      aria-label={path.includes(".") && label ? label : undefined}
    >
      <FieldRows form={form} path={path} fields={fields} />
    </fieldset>
  );
}

function ArrayEditor({
  form,
  path,
  label,
  item,
}: NodeProps & { item: StructuredValueSchema }) {
  const rowLabel = singular(label);
  const scalar = !("object" in item.node) && !("variant" in item.node);
  return (
    <ArrayFieldManager
      form={form}
      name={path}
      title={label || "Items"}
      addButtonText={`Add ${rowLabel.toLowerCase()}`}
      emptyValue={blank(item, true)}
    >
      {(_row, index) => (
        <div className="min-w-0 flex-1 space-y-3">
          <NodeEditor
            form={form}
            path={`${path}.${index}`}
            label={scalar ? `${rowLabel} ${index + 1}` : ""}
            schema={item}
            required
          />
        </div>
      )}
    </ArrayFieldManager>
  );
}

const presentKeys = (value: unknown) => {
  const parsed = z.record(z.string(), z.json()).safeParse(value);
  return parsed.success ? Object.keys(parsed.data) : [];
};

function MapEditor({
  form,
  path,
  label,
  keys,
  item,
}: NodeProps & {
  keys: readonly StructuredOption[];
  item: StructuredValueSchema;
}) {
  const value = useWatch({ control: form.control, name: path });
  const present = presentKeys(value);
  const absent = keys.filter((key) => !present.includes(key.value));
  const withEntry = (key: string, entry: ReturnType<typeof blank>) =>
    form.setValue(
      path,
      {
        ...z.record(z.string(), z.json()).catch({}).parse(value),
        [key]: entry,
      },
      { shouldDirty: true },
    );
  const withoutEntry = (key: string) =>
    form.setValue(
      path,
      Object.fromEntries(
        Object.entries(
          z.record(z.string(), z.json()).catch({}).parse(value),
        ).filter(([entry]) => entry !== key),
      ),
      { shouldDirty: true },
    );
  return (
    <div className="space-y-2">
      {label ? (
        <h3 className="my-0 text-xs font-medium text-muted-foreground">
          {label}
        </h3>
      ) : null}
      {keys
        .filter((key) => present.includes(key.value))
        .map((key) => (
          <div key={key.value} className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <NodeEditor
                form={form}
                path={`${path}.${key.value}`}
                label={key.label}
                schema={item}
                required
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="mb-1"
              aria-label={`Remove ${key.label}`}
              onClick={() => withoutEntry(key.value)}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        ))}
      {absent.length > 0 ? (
        <StaticPicker
          items={absent}
          value={null}
          label={`Add ${singular(label || "entry").toLowerCase()}`}
          placeholder={`Add ${singular(label || "entry").toLowerCase()}`}
          onValueChange={(key) => {
            if (key !== null) withEntry(key, blank(item, true));
          }}
        />
      ) : null}
    </div>
  );
}

function VariantEditor({
  form,
  path,
  label,
  discriminator,
  cases,
}: NodeProps & {
  discriminator: string;
  cases: readonly {
    value: string;
    label: string;
    fields: readonly StructuredField[];
  }[];
}) {
  const controlId = useId();
  const value = useWatch({ control: form.control, name: path });
  const tag = z.object({ [discriminator]: z.string() }).safeParse(value);
  const selected = tag.success
    ? cases.find((candidate) => candidate.value === tag.data[discriminator])
    : undefined;
  const { errors } = useFormState({
    control: form.control,
    name: asPath(path),
  });
  // An unchosen required variant is rejected at the value itself, not at its tag.
  const error = get(errors, path) ?? get(errors, `${path}.${discriminator}`);
  const title = label || discriminator;
  return (
    <div className="space-y-3">
      <FormFieldGroup
        htmlFor={controlId}
        label={title}
        invalid={error !== undefined}
        error={error}
      >
        <StaticPicker
          inputId={controlId}
          items={cases}
          value={selected?.value ?? null}
          label={title}
          placeholder={`Choose ${title.toLowerCase()}`}
          onValueChange={(chosen) => {
            const next = cases.find((candidate) => candidate.value === chosen);
            if (next !== undefined && next !== selected)
              form.setValue(path, blankCase(discriminator, next), {
                shouldDirty: true,
                shouldTouch: true,
              });
          }}
        />
      </FormFieldGroup>
      {selected ? (
        <FieldRows form={form} path={path} fields={selected.fields} />
      ) : null}
    </div>
  );
}
