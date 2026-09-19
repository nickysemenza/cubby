import type { Entity } from "@cubby/schemas/entity";
import type { CompiledEntityPresentation } from "@cubby/schemas/entity-definitions/definition";
import { generatedEntityEditIntents } from "@cubby/schemas/entity-edit-intents";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { type ComponentType, type ReactNode, useId, useMemo } from "react";
import {
  Controller,
  useFormContext,
  useWatch,
  type FieldValues,
  type UseFormReturn,
} from "react-hook-form";

import { basisValueOf } from "~/app/_components/ai/field-suggestion";
import {
  WithEntitySearch,
  type WithEntitySearchProps,
} from "~/app/_components/combobox/with-search-hook";
import { WithVendorShortcodeSearch } from "~/app/_components/combobox/with-vendor-search";
import {
  NullableNumericField,
  PlainDateField,
  SelectField,
  SideBySideFields,
  UnifiedTextField,
} from "~/app/_components/form-utils";
import { EntityMultiValueField } from "~/app/_components/form-utils/entity-multi-value-field";
import { EntityValueField } from "~/app/_components/form-utils/entity-value-field";
import { VendorField } from "~/app/_components/form-utils/vendor-field";
import { FormFieldGroup } from "~/app/_components/forms/form-field-group";
import { AliasesField } from "~/components/forms/aliases-field";
import { Row } from "~/components/layout";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";

import {
  entityFieldPresentation,
  type EditMode,
  type EntityFieldPresentation,
} from "./entity-field-presentation";
import {
  entitySelectOptionsFor,
  type EntitySelectOption,
} from "./select-options";
type PrimitiveFieldOptions = {
  placeholder?: string;
  options?: readonly EntitySelectOption[];
  focusOnMount?: boolean;
  step?: string;
  prefix?: string;
  rows?: number;
  /** Select fields only — e.g. a category forced by a USDA/ISBN link. */
  disabled?: boolean;
  /** Select fields only — overrides `presentation.description` (e.g. why a
   * forced field is disabled) rather than fighting it. */
  description?: string;
};

type PrimitiveFieldModel = (typeof entityFieldModels)[Entity]["fields"][number];

/** `undefined` for a field with no `control.suggest` — the primitives' own
 * no-op convention (`AutoSuggestSlot`/`useAutoFieldSuggestion` treat a
 * missing `suggestField` as "no provider needed"). A standalone function so
 * the ternary doesn't count against `renderPrimitiveField`'s own complexity
 * budget. */
function suggestFieldFor(hasSuggest: boolean, key: string): string | undefined {
  return hasSuggest ? key : undefined;
}

/** Same reasoning as `suggestFieldFor`: an override (e.g. a select field
 * forced disabled with its own reason) beats the presentation's own
 * description, kept out of `renderPrimitiveField`'s own complexity budget. */
function selectDescriptionFor(
  fieldOptions: PrimitiveFieldOptions,
  presentation: EntityFieldPresentation,
): string | undefined {
  return fieldOptions.description ?? presentation.description ?? undefined;
}

/**
 * Renders one field's control given its presentation metadata. Shared by
 * `EntityPrimitiveFields` (a caller-chosen, section-scoped subset) and
 * `EntityIntentFields` below (a whole semantic intent, in model order) — the
 * per-kind switch is the same either way; only field *selection* differs.
 * Never called with `presentation.control.kind === "specialized"` — callers
 * dispatch that case themselves before reaching here.
 */
function renderPrimitiveField({
  entity,
  field,
  presentation,
  form,
  idPrefix,
  fieldOptions,
  name,
}: {
  entity: Entity;
  field: PrimitiveFieldModel;
  presentation: EntityFieldPresentation;
  form: UseFormReturn<FieldValues>;
  idPrefix: string;
  fieldOptions: PrimitiveFieldOptions;
  name: string;
}) {
  const control = presentation.control;
  if (control.kind === "specialized") {
    throw new Error(
      `Field ${entity}.${field.key} requires a specialized renderer`,
    );
  }
  const controlId = `${idPrefix}-${field.key}`;
  const descriptionId = `${controlId}-description`;
  const errorId = `${controlId}-error`;
  const placeholder = fieldOptions.placeholder ?? control.placeholder ?? null;
  if (control.kind === "text") {
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
        placeholder={placeholder ?? presentation.label}
        nullable={field.nullable}
        focusOnMount={fieldOptions.focusOnMount}
      />
    );
  }
  if (control.kind === "textarea") {
    return (
      <Controller
        key={field.key}
        control={form.control}
        name={name}
        render={({ field: rhfField, fieldState }) => (
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
              {...rhfField}
              value={rhfField.value ?? ""}
              rows={fieldOptions.rows}
              placeholder={placeholder ?? undefined}
              onChange={(event) =>
                rhfField.onChange(
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
  if (control.kind === "checkbox") {
    return (
      <Controller
        key={field.key}
        control={form.control}
        name={name}
        render={({ field: rhfField, fieldState }) => (
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
                checked={rhfField.value === true}
                name={rhfField.name}
                onBlur={rhfField.onBlur}
                ref={rhfField.ref}
                onCheckedChange={(checked) =>
                  rhfField.onChange(checked === true)
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
  if (control.kind === "select") {
    return (
      <SelectField
        key={field.key}
        form={form}
        name={name}
        label={presentation.label}
        options={fieldOptions.options ?? control.options ?? []}
        placeholder={placeholder ?? undefined}
        nullable={field.nullable}
        disabled={fieldOptions.disabled}
        description={selectDescriptionFor(fieldOptions, presentation)}
        suggestField={suggestFieldFor(Boolean(control.suggest), field.key)}
      />
    );
  }
  if (control.kind === "date") {
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
  // `control.kind === "number"`: a `renderer: "money"` field defaults to a
  // dollar prefix and cent-precision step — the two conventions every money
  // field in the manifest already renders with — unless a caller overrides
  // either explicitly.
  const isMoney = control.renderer === "money";
  const prefix = fieldOptions.prefix ?? (isMoney ? "$" : undefined);
  const step = fieldOptions.step ?? (isMoney ? "0.01" : undefined);
  return (
    <Controller
      key={field.key}
      control={form.control}
      name={name}
      render={({ field: rhfField, fieldState }) => (
        <FormFieldGroup
          htmlFor={controlId}
          descriptionId={descriptionId}
          errorId={errorId}
          label={presentation.label}
          description={presentation.description ?? undefined}
          invalid={fieldState.invalid}
          error={fieldState.error}
        >
          <div className={prefix ? "relative" : undefined}>
            {prefix && (
              <span className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground">
                {prefix}
              </span>
            )}
            <Input
              id={controlId}
              type="number"
              {...rhfField}
              value={rhfField.value ?? ""}
              step={step}
              placeholder={placeholder ?? undefined}
              className={prefix ? "pl-7" : undefined}
              onChange={(event) =>
                rhfField.onChange(
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
        const name = paths[field.key] ?? field.key;
        return renderPrimitiveField({
          entity,
          field,
          presentation,
          form,
          idPrefix,
          fieldOptions,
          name,
        });
      })}
    </>
  );
}

/** Props every specialized intent renderer receives. */
interface SpecializedIntentRendererProps {
  entity: Entity;
  field: PrimitiveFieldModel;
  form: UseFormReturn<FieldValues>;
  idPrefix: string;
  mode: EditMode;
}

/**
 * The shared `string[]` list editor for any `control.renderer: "tag-list"`
 * field (ingredient/location aliases, ingredient's enrichment exclusions,
 * …) — one control for every declaration that reuses this convention name,
 * keyed by the field's own key so multiple tag-list fields on one intent
 * render independently.
 */
function TagListField({ field, form }: SpecializedIntentRendererProps) {
  return (
    <AliasesField
      form={form}
      name={field.key}
      title={field.label}
      addButtonText={`Add ${field.label}`}
    />
  );
}

/**
 * Inventory's `amount` field is a `{ value, unit }` object with no single
 * scalar control — the shared value/unit row from `inventory-form.tsx`.
 */
function AmountField({ field, form }: SpecializedIntentRendererProps) {
  return (
    <SideBySideFields>
      <NullableNumericField
        form={form}
        name={`${field.key}.value`}
        label="Amount Value"
        placeholder="Enter amount"
        fraction
      />
      <UnifiedTextField
        form={form}
        name={`${field.key}.unit`}
        label="Amount Unit"
        placeholder="Enter unit"
        nullable={false}
      />
    </SideBySideFields>
  );
}

/**
 * `expense.vendor`: a roster-backed **name** (see `VendorField`'s own doc
 * comment for why this isn't a plain text box), wired to its `suggest` field
 * the same way every other suggestable control is.
 */
function VendorNameField({ field, form }: SpecializedIntentRendererProps) {
  return (
    <VendorField
      form={form}
      name={field.key}
      label={field.label}
      suggestField={suggestFieldFor(Boolean(field.control?.suggest), field.key)}
    />
  );
}

/**
 * A multi-reference field (`blockedByIds`, `candidateProductIds`): the full
 * id set, edited as chips plus the target's search picker.
 */
function EntityMultiSelectField({
  field,
  form,
}: SpecializedIntentRendererProps) {
  const referenceEntity = field.reference?.entity;
  if (referenceEntity === undefined)
    throw new Error(`Field ${field.key} is a multi-select without a reference`);
  return (
    <EntityMultiValueField
      form={form}
      name={field.key}
      // SAFETY: `referenceEntity` is a manifest-declared reference target,
      // always one of the picker's supported entities.
      entity={referenceEntity as never}
      label={field.label}
      SearchProvider={referenceEntitySearch(referenceEntity)}
    />
  );
}

/**
 * Renderers for `control.kind: "specialized"` fields that are not a
 * singular reference (those are handled generically below). Keyed by
 * `control.renderer`. Populated as bespoke forms move onto
 * `EntityIntentFields` (Lane A5) — an entity whose intent includes a
 * specialized, non-reference field with no entry here fails loudly rather
 * than silently dropping the field.
 */
const specializedIntentRenderers = {
  "tag-list": TagListField,
  amount: AmountField,
  "entity-multi-select": EntityMultiSelectField,
  "vendor-name": VendorNameField,
  // The gallery block the dialog shell mounts owns reordering (it writes
  // `imageOrder` through `onExistingImagesReorder`); the field itself has no
  // control of its own to draw.
  "image-order": () => null,
} satisfies Readonly<
  Record<string, ComponentType<SpecializedIntentRendererProps>>
>;

/** Looks up a manifest-declared `control.renderer` name, or `undefined` for
 * one this registry doesn't (yet) carry an entry for. */
function specializedRendererFor(
  name: string,
): ComponentType<SpecializedIntentRendererProps> | undefined {
  if (!Object.hasOwn(specializedIntentRenderers, name)) return undefined;
  // SAFETY: the `Object.hasOwn` check above proves `name` is one of
  // `specializedIntentRenderers`'s own declared keys, not an arbitrary string.
  return specializedIntentRenderers[
    name as keyof typeof specializedIntentRenderers
  ];
}

/**
 * One reference field's search provider: the vendor picker needs its own
 * shortcode-typed wrapper (vendor has no shared picker default — see
 * `with-vendor-search.tsx`); every other reference entity gets the generic
 * `WithEntitySearch` shell.
 */
function referenceEntitySearch(
  referenceEntity: string,
): (props: WithEntitySearchProps<string>) => ReactNode {
  if (referenceEntity === "vendor") {
    // SAFETY: `WithVendorShortcodeSearch` is keyed to `VendorShortcode`, a
    // string-branded type; the caller's id path is a plain string RHF field.
    return WithVendorShortcodeSearch as never;
  }
  return (props) => (
    // SAFETY: `referenceEntity` is a manifest-declared reference target,
    // always one of `WithEntitySearch`'s supported (non-vendor) entities.
    <WithEntitySearch entity={referenceEntity as never} {...props} />
  );
}

/**
 * Select-control choices for enum fields whose options carry a status color
 * — a shape the manifest's plain `control.options` (`{value,label}`) doesn't
 * express, and that a capture dialog's select should still render (list/
 * filter UI uses these same arrays for the same color coding). Keyed by
 * `${entity}.${fieldKey}`; every other select field's options come straight
 * off the manifest.
 */
/**
 * Generic capture/intent fields: iterates one semantic intent's field roster
 * in model order (not a caller-chosen subset) and renders each field with no
 * per-entity component. A singular reference renders as a search-backed
 * picker; `control.kind: "specialized"` dispatches to the small renderer
 * registry above; everything else falls through to the same per-kind
 * rendering `EntityPrimitiveFields` uses. Fields the intent doesn't declare a
 * control for (`pendingImageIds`, editor-only pseudo fields) are skipped —
 * the dialog shell renders those itself (see `entity-edit-dialog-content.tsx`).
 */
export function EntityIntentFields({
  entity,
  intent,
  mode = "create",
}: {
  entity: Entity;
  intent: string;
  mode?: EditMode;
}) {
  const form = useFormContext<FieldValues>();
  const idPrefix = useId();
  const model = entityFieldModels[entity];
  // SAFETY: `generatedEntityEditIntents` only declares the entities that
  // opted into standard editing (`EditableEntity`, a subset of `Entity`);
  // callers only ever pass one of those, but this component's `entity` prop
  // stays the broader `Entity` to match `EntityPrimitiveFields`.
  const declaredIntents = (
    generatedEntityEditIntents as Record<
      string,
      { fields: Record<string, readonly string[]> } | undefined
    >
  )[entity];
  const intentFieldKeys: readonly string[] =
    declaredIntents?.fields[intent] ?? [];
  // SAFETY: indexed by the broad `Entity` union, every entity's literal
  // `hiddenWhen` narrows to the same rule shape only when read through the
  // schema-level type — see `declaredAccess` in `definitions.ts` for the
  // identical `readOnlyWhen` narrowing trap.
  const hiddenWhen: CompiledEntityPresentation["edit"]["hiddenWhen"] =
    entitySummary[entity].edit.hiddenWhen;
  const hiddenWhenFields = useMemo(
    () => hiddenWhen.map((rule) => rule.field),
    [hiddenWhen],
  );
  const hiddenWhenValues: unknown[] = useWatch({
    control: form.control,
    name: hiddenWhenFields,
  });
  const hiddenFieldKeys = useMemo(() => {
    const hidden = new Set<string>();
    hiddenWhen.forEach((rule, index) => {
      const present = basisValueOf(hiddenWhenValues[index]) !== null;
      if (present === rule.present) {
        rule.fields.forEach((key) => hidden.add(key));
      }
    });
    return hidden;
  }, [hiddenWhen, hiddenWhenValues]);
  const fields = model.fields.filter(
    (field) =>
      intentFieldKeys.includes(field.key) &&
      field.control !== null &&
      !hiddenFieldKeys.has(field.key),
  );

  return (
    <>
      {fields.map((field) => {
        if (field.reference && !field.reference.multiple) {
          const referenceEntity = field.reference.entity;
          return (
            <EntityValueField
              key={field.key}
              form={form}
              // SAFETY: `field.key` is one of this entity's own declared
              // model field keys; RHF's conditional path type cannot express
              // a runtime-selected field roster.
              name={field.key as never}
              // SAFETY: `referenceEntity` is a manifest-declared reference
              // target, always one of the picker's supported entities.
              entity={referenceEntity as never}
              label={field.label}
              clearable={field.nullable}
              SearchProvider={referenceEntitySearch(referenceEntity)}
              suggestField={suggestFieldFor(
                Boolean(field.control?.suggest),
                field.key,
              )}
            />
          );
        }
        const presentation = entityFieldPresentation(entity, field.key, mode);
        if (presentation.control.kind === "specialized") {
          const Renderer = specializedRendererFor(
            presentation.control.renderer ?? "",
          );
          if (!Renderer) {
            throw new Error(
              `Field ${entity}.${field.key} has no specialized intent renderer for "${presentation.control.renderer}"`,
            );
          }
          return (
            <Renderer
              key={field.key}
              entity={entity}
              field={field}
              form={form}
              idPrefix={idPrefix}
              mode={mode}
            />
          );
        }
        const fieldOptions: PrimitiveFieldOptions = {};
        if (
          field.key === "name" &&
          mode === "create" &&
          presentation.control.kind === "text"
        ) {
          fieldOptions.focusOnMount = true;
        }
        if (presentation.control.kind === "select") {
          fieldOptions.options = entitySelectOptionsFor(
            entity,
            field.key,
            mode,
          );
        }
        return renderPrimitiveField({
          entity,
          field,
          presentation,
          form,
          idPrefix,
          fieldOptions,
          name: field.key,
        });
      })}
    </>
  );
}
