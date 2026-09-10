import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { useId } from "react";
import { useFormContext, Controller, type FieldValues } from "react-hook-form";

import {
  PlainDateField,
  SelectField,
  UnifiedTextField,
} from "~/app/_components/form-utils";
import { FormFieldGroup } from "~/app/_components/forms/form-field-group";
import { Row } from "~/components/layout";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";

import {
  entityFieldPresentation,
  type EditMode,
} from "./entity-field-presentation";

type PrimitiveFieldOptions = {
  placeholder?: string;
  options?: { value: string; label: string }[];
  focusOnMount?: boolean;
  step?: string;
  prefix?: string;
  rows?: number;
};

export function EntityPrimitiveFields({
  entity,
  mode,
  exclude = [],
  include,
  section,
  options = {},
  paths = {},
}: {
  entity: Entity;
  mode: EditMode;
  exclude?: readonly string[];
  /** Optional ordered subset for incremental migrations that preserve layout. */
  include?: readonly string[];
  /** Selects a declared form section; newly declared fields join automatically. */
  section?: string;
  options?: Readonly<Record<string, PrimitiveFieldOptions>>;
  /** Maps canonical fields into an embedded form's existing paths. */
  paths?: Readonly<Record<string, string>>;
}) {
  const form = useFormContext<FieldValues>();
  const idPrefix = useId();
  const model = entityFieldModels[entity];
  const editable: readonly string[] =
    mode === "create" ? model.create : model.update;
  const eligible = model.fields.filter(
    (field) =>
      editable.includes(field.key) &&
      !exclude.includes(field.key) &&
      (section === undefined || field.control?.section === section),
  );
  const fields = include
    ? include.map((key) => {
        const field = eligible.find((candidate) => candidate.key === key);
        if (!field) {
          throw new Error(
            `Field ${entity}.${key} is not editable in ${mode} mode`,
          );
        }
        return field;
      })
    : eligible.filter(
        (field) => field.control && field.control.kind !== "specialized",
      );

  return (
    <>
      {fields.map((field) => {
        const presentation = entityFieldPresentation(entity, field.key, mode);
        const fieldOptions = options[field.key] ?? {};
        if (presentation.control.kind === "specialized") {
          throw new Error(
            `Field ${entity}.${field.key} requires a specialized renderer`,
          );
        }
        const name = paths[field.key] ?? field.key;
        const controlId = `${idPrefix}-${field.key}`;
        const descriptionId = `${controlId}-description`;
        const errorId = `${controlId}-error`;
        if (presentation.control.kind === "text") {
          // SAFETY: The generated text-control declaration selects a string
          // field. RHF's conditional string path cannot express a dynamic model.
          const textName = name as never;
          return (
            <UnifiedTextField
              key={field.key}
              form={form}
              name={textName}
              label={presentation.label}
              description={presentation.description ?? undefined}
              placeholder={fieldOptions.placeholder ?? presentation.label}
              nullable={field.nullable}
              focusOnMount={fieldOptions.focusOnMount}
            />
          );
        }
        if (presentation.control.kind === "textarea") {
          return (
            <Controller
              key={field.key}
              control={form.control}
              name={name}
              render={({ field: control, fieldState }) => (
                <FormFieldGroup
                  htmlFor={controlId}
                  descriptionId={descriptionId}
                  errorId={errorId}
                  label={presentation.label}
                  description={presentation.description ?? undefined}
                  invalid={fieldState.invalid}
                  error={fieldState.error}
                >
                  <Textarea
                    id={controlId}
                    {...control}
                    value={control.value ?? ""}
                    rows={fieldOptions.rows}
                    placeholder={fieldOptions.placeholder}
                    onChange={(event) =>
                      control.onChange(
                        event.target.value === "" && field.nullable
                          ? null
                          : event.target.value,
                      )
                    }
                    aria-invalid={fieldState.invalid}
                    aria-describedby={
                      [
                        presentation.description ? descriptionId : null,
                        fieldState.error ? errorId : null,
                      ]
                        .filter(Boolean)
                        .join(" ") || undefined
                    }
                  />
                </FormFieldGroup>
              )}
            />
          );
        }
        if (presentation.control.kind === "checkbox") {
          return (
            <Controller
              key={field.key}
              control={form.control}
              name={name}
              render={({ field: control, fieldState }) => (
                <FormFieldGroup
                  htmlFor={controlId}
                  descriptionId={descriptionId}
                  errorId={errorId}
                  label={presentation.label}
                  description={presentation.description ?? undefined}
                  invalid={fieldState.invalid}
                  error={fieldState.error}
                >
                  <Row gap="sm" align="start">
                    <Checkbox
                      id={controlId}
                      checked={control.value === true}
                      name={control.name}
                      onBlur={control.onBlur}
                      ref={control.ref}
                      onCheckedChange={(checked) =>
                        control.onChange(checked === true)
                      }
                      aria-invalid={fieldState.invalid}
                      aria-describedby={
                        [
                          presentation.description ? descriptionId : null,
                          fieldState.error ? errorId : null,
                        ]
                          .filter(Boolean)
                          .join(" ") || undefined
                      }
                    />
                  </Row>
                </FormFieldGroup>
              )}
            />
          );
        }
        if (presentation.control.kind === "select") {
          return (
            <SelectField
              key={field.key}
              form={form}
              name={name}
              label={presentation.label}
              options={
                fieldOptions.options ?? presentation.control.options ?? []
              }
              nullable={field.nullable}
              description={presentation.description ?? undefined}
            />
          );
        }
        if (presentation.control.kind === "date") {
          // SAFETY: The date declaration selects a plain-date string path; RHF
          // cannot correlate a runtime model key with its conditional path type.
          const dateName = name as never;
          return (
            <PlainDateField
              key={field.key}
              form={form}
              name={dateName}
              label={presentation.label}
              description={presentation.description ?? undefined}
            />
          );
        }
        if (presentation.control.kind === "number") {
          return (
            <Controller
              key={field.key}
              control={form.control}
              name={name}
              render={({ field: control, fieldState }) => (
                <FormFieldGroup
                  htmlFor={controlId}
                  descriptionId={descriptionId}
                  errorId={errorId}
                  label={presentation.label}
                  description={presentation.description ?? undefined}
                  invalid={fieldState.invalid}
                  error={fieldState.error}
                >
                  <div className={fieldOptions.prefix ? "relative" : undefined}>
                    {fieldOptions.prefix && (
                      <span className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground">
                        {fieldOptions.prefix}
                      </span>
                    )}
                    <Input
                      id={controlId}
                      type={presentation.control.kind}
                      {...control}
                      value={control.value ?? ""}
                      step={fieldOptions.step}
                      className={fieldOptions.prefix ? "pl-7" : undefined}
                      onChange={(event) =>
                        control.onChange(
                          event.target.value === ""
                            ? field.nullable
                              ? null
                              : undefined
                            : Number(event.target.value),
                        )
                      }
                      aria-invalid={fieldState.invalid}
                      aria-describedby={
                        [
                          presentation.description ? descriptionId : null,
                          fieldState.error ? errorId : null,
                        ]
                          .filter(Boolean)
                          .join(" ") || undefined
                      }
                    />
                  </div>
                </FormFieldGroup>
              )}
            />
          );
        }
        return null;
      })}
    </>
  );
}
