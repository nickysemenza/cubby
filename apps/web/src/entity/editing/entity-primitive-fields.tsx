import type { Entity } from "@cubby/schemas/entity";
import type {
  CompiledEditSection,
  CompiledEntityPresentation,
} from "@cubby/schemas/entity-definitions/definition";
import { generatedEntityEditIntents } from "@cubby/schemas/entity-edit-intents";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { ControlRendererId } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { resolveExpenseLineKind } from "@cubby/schemas/expense-line-kind";
import {
  type ComponentType,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
} from "react";
import {
  Controller,
  useFormContext,
  useWatch,
  type FieldValues,
  type UseFormReturn,
} from "react-hook-form";

import {
  SourceAliasesField,
  SourceRefsField,
} from "~/app/finance/financial-form-fields";
import { FieldProvenance } from "~/entity/field-provenance";
import {
  generic,
  implemented,
  ownedElsewhere,
  type PresentationCoverage,
} from "~/entity/presentation-coverage";
import { basisValueOf } from "~/features/ai/field-suggestion";
import { FormFieldResolution } from "~/features/ai/form-field-resolution";
import type { EntitySearchScope } from "~/ui/combobox/entity-search-hooks";
import {
  isReferencePickerEntity,
  requireReferenceEntitySearch,
} from "~/ui/combobox/reference-entity-search";
import type { SearchProviderProps } from "~/ui/combobox/with-search-hook";
import {
  NullableNumericField,
  PlainDateField,
  SelectField,
  SideBySideFields,
  UnifiedTextField,
} from "~/ui/form-utils";
import { EntityMultiValueField } from "~/ui/form-utils/entity-multi-value-field";
import { EntityValueField } from "~/ui/form-utils/entity-value-field";
import { VendorField } from "~/ui/form-utils/vendor-field";
import { AliasesField } from "~/ui/forms/aliases-field";
import { FormFieldGroup } from "~/ui/forms/form-field-group";
import { FormSection } from "~/ui/forms/form-section";
import { Row } from "~/ui/layout";
import { Checkbox } from "~/ui/primitives/checkbox";
import { Input } from "~/ui/primitives/input";
import { Textarea } from "~/ui/primitives/textarea";

import {
  entityFieldPresentation,
  type EditMode,
  type EntityFieldPresentation,
} from "./entity-field-presentation";
import { fieldClearing } from "./field-clearing";
import { LedgerAttributionsField } from "./ledger-attributions-field";
import {
  ProductExternalIdsField,
  ProductLabelNutritionField,
  ProductTagsField,
  ProductUnitMappingsField,
  ProductUpcField,
  ProductUsdaFoodField,
} from "./product-editor-fields";
import { referenceScopeFields, referenceScopeFor } from "./reference-scope";
import {
  presentEntitySelectOptions,
  type EntitySelectOption,
} from "./select-options";
import { structuredSchemaFor } from "./structured-schema";
import { StructuredValueField } from "./structured-value-field";
import type { EntityEditRecord } from "./types";
import {
  entityEditValueBagSchema,
  type EntityEditValueBag,
} from "./value-schema";
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
  description?: ReactNode;
};

export type PrimitiveFieldModel =
  (typeof entityFieldModels)[Entity]["fields"][number];

/** A singular reference's search provider, keyed by its target entity. The
 * production lookup is `requireReferenceEntitySearch`; a test injects a fake
 * instead of mocking the `with-search-hook` module. */
export type SearchProviderFor = (
  referenceEntity: string,
) => (props: SearchProviderProps<string>) => ReactNode;

/**
 * Set by a wrapper that owns each field's assignment — bulk edit's
 * unchanged/set/clear modes — instead of the record editor:
 * - clearing a date is the wrapper's mode, so the field draws no Clear action
 *   of its own, and the expense date rule reads `clearCost` (the selection's
 *   cost) rather than a watched `cost` field;
 * - inheritance (resolution) controls always render, since a multi-row
 *   selection mounts no suggestion provider to draw them.
 */
export type FieldAssignmentPolicy = Readonly<{
  clearCost: number | null;
  searchProviderFor: SearchProviderFor;
}>;

function IntentFieldResolution({
  entity,
  form,
  field,
  assignment,
}: {
  entity: Entity;
  form: UseFormReturn<FieldValues>;
  field: PrimitiveFieldModel;
  assignment: FieldAssignmentPolicy | undefined;
}) {
  if (assignment)
    return (
      <FormFieldResolution entity={entity} form={form} field={field.key} />
    );
  // The record editor resolves its entity from the suggestion provider.
  return field.resolution && !field.control?.suggest ? (
    <FormFieldResolution form={form} field={field.key} />
  ) : null;
}

/** `undefined` for a field with no `control.suggest` — the primitives' own
 * no-op convention (`AutoSuggestSlot`/`useAutoFieldSuggestion` treat a
 * missing `suggestField` as "no provider needed"). A standalone function so
 * the ternary doesn't count against `renderPrimitiveField`'s own complexity
 * budget. */
function suggestFieldFor(hasSuggest: boolean, key: string): string | undefined {
  return hasSuggest ? key : undefined;
}

function EntityDateField({
  entity,
  field,
  name,
  costName,
  form,
  label,
  description,
  record,
  assignment,
}: {
  entity: Entity;
  field: PrimitiveFieldModel;
  name: string;
  costName: string;
  form: UseFormReturn<FieldValues>;
  label: string;
  description: ReactNode;
  record?: EntityEditRecord | undefined;
  assignment: FieldAssignmentPolicy | undefined;
}) {
  const watchedCost: unknown = useWatch({
    control: form.control,
    name: costName,
  });
  // A watched null is a cleared cost, not an absent one; only `undefined`
  // falls back to the stored record.
  const cost = assignment
    ? assignment.clearCost
    : watchedCost === undefined
      ? record?.cost
      : watchedCost;
  return (
    <PlainDateField
      form={form}
      name={name}
      label={label}
      description={description}
      {...fieldClearing(entity, field.key, field.nullable, cost)}
      showClearAction={assignment === undefined}
    />
  );
}

/** Same reasoning as `suggestFieldFor`: an override (e.g. a select field
 * forced disabled with its own reason) beats the presentation's own
 * description, kept out of `renderPrimitiveField`'s own complexity budget. */
function selectDescriptionFor(
  fieldOptions: PrimitiveFieldOptions,
  presentation: EntityFieldPresentation,
): ReactNode {
  const helper = fieldOptions.description ?? presentation.description;
  if (!helper && !presentation.provenance) return undefined;
  return (
    <span className="space-y-0.5">
      {helper ? <span className="block">{helper}</span> : null}
      <FieldProvenance provenance={presentation.provenance} />
    </span>
  );
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
  mode,
  record,
  costName = "cost",
  assignment,
}: {
  entity: Entity;
  field: PrimitiveFieldModel;
  presentation: EntityFieldPresentation;
  form: UseFormReturn<FieldValues>;
  idPrefix: string;
  fieldOptions: PrimitiveFieldOptions;
  name: string;
  mode: EditMode;
  record?: EntityEditRecord | undefined;
  costName?: string;
  assignment?: FieldAssignmentPolicy | undefined;
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
  const description = selectDescriptionFor(fieldOptions, presentation);
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
        description={description}
        placeholder={placeholder ?? presentation.label}
        nullable={field.nullable}
        suggestField={suggestFieldFor(
          Boolean(field.control?.suggest),
          field.key,
        )}
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
            description={description}
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
                  description ? descriptionId : null,
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
            description={description}
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
                    description ? descriptionId : null,
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
        options={presentEntitySelectOptions(
          entity,
          field.key,
          fieldOptions.options ?? control.options ?? [],
          mode,
        )}
        placeholder={placeholder ?? undefined}
        nullable={field.nullable}
        disabled={fieldOptions.disabled}
        description={description}
        suggestField={suggestFieldFor(Boolean(control.suggest), field.key)}
      />
    );
  }
  if (control.kind === "date") {
    return (
      <EntityDateField
        key={field.key}
        record={record}
        entity={entity}
        field={field}
        name={name}
        costName={costName}
        form={form}
        label={presentation.label}
        description={description}
        assignment={assignment}
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
          description={description}
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
                  description ? descriptionId : null,
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
  const sectionFields =
    section === undefined
      ? undefined
      : new Set<string>(
          entitySummary[entity].edit.sections.find(
            (candidate) => candidate.id === section,
          )?.fields,
        );
  const eligible = model.fields.filter(
    (field) =>
      editable.includes(field.key) &&
      !exclude.includes(field.key) &&
      (section === undefined || sectionFields?.has(field.key) === true),
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
          costName: paths.cost ?? "cost",
          mode,
        });
      })}
    </>
  );
}

/** Props every specialized intent renderer receives. */
export interface SpecializedIntentRendererProps {
  entity: Entity;
  field: PrimitiveFieldModel;
  form: UseFormReturn<FieldValues>;
  idPrefix: string;
  mode: EditMode;
  scope?: EntitySearchScope | null;
}

/**
 * The shared `string[]` list editor for any `control.renderer: "tag-list"`
 * field (ingredient/location aliases, ingredient's enrichment exclusions,
 * …) — one control for every declaration that reuses this convention name,
 * keyed by the field's own key so multiple tag-list fields on one intent
 * render independently.
 */
function TagListField({ field, form }: SpecializedIntentRendererProps) {
  return <AliasesField form={form} name={field.key} title={field.label} />;
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
  scope,
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
      SearchProvider={requireReferenceEntitySearch(referenceEntity)}
      scope={scope}
    />
  );
}

function StructuredFieldRenderer({
  entity,
  field,
  form,
  mode,
}: SpecializedIntentRendererProps) {
  const schema = structuredSchemaFor(entity, field.key);
  if (schema === undefined)
    throw new Error(
      `${entity}.${field.key} is a structured-field with no valueSchema; classify it in nativeCoverage.structuredField`,
    );
  return (
    <StructuredValueField
      form={form}
      name={field.key}
      label={field.label}
      schema={schema}
      creating={mode === "create"}
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
export const controlRendererCoverage = {
  "entity-select": generic,
  money: generic,
  url: generic,
  "tag-list": implemented(TagListField),
  "ledger-attributions": implemented(({ entity, field, form, mode }) => (
    <LedgerAttributionsField
      form={form}
      name={field.key}
      label={field.label}
      prefillFromVendor={entity === "expense" && mode === "create"}
    />
  )),
  amount: implemented(AmountField),
  "entity-multi-select": implemented(EntityMultiSelectField),
  "vendor-name": implemented(VendorNameField),
  // The gallery block the dialog shell mounts owns reordering (it writes
  // `imageOrder` through `onExistingImagesReorder`); the field itself has no
  // control of its own to draw.
  "image-order": ownedElsewhere,
  // Drawn from the field's generated `StructuredValueSchema`, the same description native draws.
  "structured-field": implemented(StructuredFieldRenderer),
  "unit-mappings": implemented(ProductUnitMappingsField),
  "label-nutrition": implemented(ProductLabelNutritionField),
  "external-ids": implemented(ProductExternalIdsField),
  "upc-lookup": implemented(ProductUpcField),
  "usda-food": implemented(ProductUsdaFoodField),
  "product-tags": implemented(ProductTagsField),
  // `SourceAliasesField`/`SourceRefsField` (`financial-form-fields.tsx`)
  // already hardcode their own `name` (`sourceAliases`/`sourceRefs`), the
  // only field key either renderer is ever declared against — no need to
  // thread `field.key` through.
  "source-aliases": implemented(({ form }) => (
    <SourceAliasesField form={form} />
  )),
  "source-refs": implemented(({ form }) => <SourceRefsField form={form} />),
} satisfies Readonly<
  Record<
    ControlRendererId,
    PresentationCoverage<ComponentType<SpecializedIntentRendererProps>>
  >
>;

/** Looks up a manifest-declared `control.renderer` name, or `undefined` for
 * one this registry doesn't (yet) carry an entry for. */
function specializedRendererFor(
  name: string,
): ComponentType<SpecializedIntentRendererProps> | undefined {
  if (!Object.hasOwn(controlRendererCoverage, name)) return undefined;
  // SAFETY: the `Object.hasOwn` check above proves `name` is one of
  // `controlRendererCoverage`'s own declared keys, not an arbitrary string.
  const disposition = controlRendererCoverage[name as ControlRendererId];
  if (disposition.kind === "implemented") return disposition.implementation;
  if (disposition.kind === "ownedElsewhere") return () => null;
  return undefined;
}

/** Looks up one named field on `entity`'s model — the lookup `renderIntentField`
 * callers outside this module need before they can pass a `PrimitiveFieldModel`
 * to it. Throws rather than returning `undefined` so the field's presence is a
 * load-time invariant, not a per-render null check: the generator would have
 * already failed (`pnpm generate:check`) had the manifest dropped this key. */
export function requiredFieldModel(
  entity: Entity,
  key: string,
): PrimitiveFieldModel {
  const field = entityFieldModels[entity].fields.find(
    (candidate) => candidate.key === key,
  );
  if (!field) {
    throw new Error(`Field ${entity}.${key} is not declared in the model`);
  }
  return field;
}

/** A singular reference: the target's search picker, or a shortcode text
 * input for a target with no picker. */
function renderSingularReference({
  entity,
  field,
  form,
  reference,
  scopedValueRecord,
  assignment,
}: {
  entity: Entity;
  field: PrimitiveFieldModel;
  form: UseFormReturn<FieldValues>;
  reference: NonNullable<PrimitiveFieldModel["reference"]>;
  scopedValueRecord: EntityEditValueBag;
  assignment: FieldAssignmentPolicy | undefined;
}): ReactNode {
  if (!isReferencePickerEntity(reference.entity)) {
    // A target with no picker (device-reported provenance) takes its
    // shortcode as text; server validation stays final. Throwing here would
    // take the whole form down.
    return (
      <UnifiedTextField
        key={field.key}
        form={form}
        // SAFETY: `field.key` is one of this entity's declared model keys.
        name={field.key as never}
        label={field.label}
        placeholder={`${field.label} code`}
        nullable={field.nullable}
      />
    );
  }
  const referenceEntity = reference.entity;
  const scope = referenceScopeFor(reference, scopedValueRecord);
  return (
    <div key={field.key} className="space-y-1">
      <EntityValueField
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
        description={<FieldProvenance provenance={field.provenance} />}
        SearchProvider={(
          assignment?.searchProviderFor ?? requireReferenceEntitySearch
        )(referenceEntity)}
        scope={scope}
        suggestField={suggestFieldFor(
          Boolean(field.control?.suggest),
          field.key,
        )}
      />
      <IntentFieldResolution
        entity={entity}
        form={form}
        field={field}
        assignment={assignment}
      />
    </div>
  );
}

/** One rendered intent field, in `EntityIntentFields`' own dispatch order: a
 * singular reference gets the search-backed picker, a `control.kind:
 * "specialized"` field dispatches to `controlRendererCoverage`, and
 * everything else falls through to `renderPrimitiveField` — the exact
 * per-kind switch `EntityPrimitiveFields` uses. Extracted so the section
 * grammar below can lay these nodes out into `FormSection`s without
 * duplicating the dispatch, and exported (with `requiredFieldModel` above) so
 * a bespoke, section-composed form (`FinancialAccountFields`/
 * `FinancialTransactionFormFields`) can embed one named specialized field
 * through the same coverage-driven dispatch without adopting
 * `EntityIntentFields`' whole roster — those two forms already render their
 * singular references (`accountId`, `purchaseId`) through richer,
 * entity-specific search providers `EntityIntentFields`'s generic picker
 * can't reproduce. Bulk edit renders each declared field through here too,
 * wrapped in its own assignment modes (see {@link FieldAssignmentPolicy}). */
export function renderIntentField({
  entity,
  field,
  form,
  idPrefix,
  mode,
  record,
  scopedValueRecord,
  assignment,
}: {
  entity: Entity;
  field: PrimitiveFieldModel;
  form: UseFormReturn<FieldValues>;
  idPrefix: string;
  mode: EditMode;
  record?: EntityEditRecord | undefined;
  scopedValueRecord: EntityEditValueBag;
  assignment?: FieldAssignmentPolicy | undefined;
}): ReactNode {
  if (field.reference && !field.reference.multiple)
    return renderSingularReference({
      entity,
      field,
      form,
      reference: field.reference,
      scopedValueRecord,
      assignment,
    });
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
    const provenanceId = field.provenance
      ? `${idPrefix}-${field.key}-provenance`
      : undefined;
    return (
      <fieldset
        key={field.key}
        className="space-y-1"
        aria-label={field.label}
        aria-describedby={provenanceId}
      >
        <Renderer
          entity={entity}
          field={field}
          form={form}
          idPrefix={idPrefix}
          mode={mode}
          scope={referenceScopeFor(field.reference, scopedValueRecord)}
        />
        {field.provenance ? (
          <div id={provenanceId}>
            <FieldProvenance provenance={field.provenance} />
          </div>
        ) : null}
        <IntentFieldResolution
          entity={entity}
          form={form}
          field={field}
          assignment={assignment}
        />
      </fieldset>
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
  const rendered = renderPrimitiveField({
    record,
    entity,
    field,
    presentation,
    form,
    idPrefix,
    fieldOptions,
    name: field.key,
    mode,
    assignment,
  });
  return (
    <div key={field.key} className="space-y-1">
      {rendered}
      <IntentFieldResolution
        entity={entity}
        form={form}
        field={field}
        assignment={assignment}
      />
    </div>
  );
}

export type DeclaredEditSection = CompiledEditSection;

/** One rendered bucket of `EntityIntentFields`' fields. `title: null` is the
 * untitled `main` section, rendered with no `FormSection` wrapper. */
export type FieldGroup = Readonly<{
  id: string;
  title: string | null;
  collapsed: boolean;
  fields: readonly PrimitiveFieldModel[];
}>;

/**
 * Buckets one intent's field roster (already in model order) into the
 * compiled editor sections, which place every controlled roster field exactly
 * once and in the same order `GenericEntityEditModel.sections` renders on
 * native. A field no section names (an intent-only roster the compiler did
 * not see) joins `main`.
 */
export function buildFieldGroups(
  sections: readonly CompiledEditSection[],
  fields: readonly PrimitiveFieldModel[],
): FieldGroup[] {
  const sectionOf = new Map<string, string>();
  for (const section of sections)
    for (const key of section.fields) sectionOf.set(key, section.id);
  const ordered: readonly Pick<
    CompiledEditSection,
    "id" | "title" | "collapsed"
  >[] = sections.some((section) => section.id === "main")
    ? sections
    : [{ id: "main", title: null, collapsed: false }, ...sections];
  return ordered
    .map((section) => ({
      id: section.id,
      title: section.title,
      collapsed: section.collapsed,
      fields: fields.filter(
        (field) => (sectionOf.get(field.key) ?? "main") === section.id,
      ),
    }))
    .filter((group) => group.fields.length > 0);
}

/**
 * Pairs consecutive `control.width: "half"` fields within one group's own
 * field order (never across a section boundary — pairing runs per group,
 * after `buildFieldGroups`) into one `SideBySideFields` row; a lone trailing
 * half field, or any full-width field, renders alone. A section boundary
 * always breaks a pair even when the manifest declares two `"half"` fields
 * back to back across sections, since `buildFieldGroups` already separated
 * them into different `fields` arrays by then.
 */
// SAFETY: no entity declares `control.width: "half"` yet (PR 3 does
// product), so the generator's `satisfies`-typed field model infers `width`
// as the literal `null` from today's actual data alone; widen it back to the
// schema's real `"half" | null` until some entity's data makes that literal
// appear on its own.
const isHalfWidthField = (field: PrimitiveFieldModel): boolean =>
  (field.control?.width as "half" | null | undefined) === "half";

function pairHalfWidthFields(
  fields: readonly PrimitiveFieldModel[],
): (
  | readonly [PrimitiveFieldModel]
  | readonly [PrimitiveFieldModel, PrimitiveFieldModel]
)[] {
  const rows: (
    | readonly [PrimitiveFieldModel]
    | readonly [PrimitiveFieldModel, PrimitiveFieldModel]
  )[] = [];
  let index = 0;
  while (index < fields.length) {
    const field = fields[index]!;
    const next = fields[index + 1];
    if (isHalfWidthField(field) && next && isHalfWidthField(next)) {
      rows.push([field, next]);
      index += 2;
    } else {
      rows.push([field]);
      index += 1;
    }
  }
  return rows;
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
  record,
}: {
  entity: Entity;
  intent: string;
  mode?: EditMode;
  record?: EntityEditRecord | undefined;
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
  // `entitySummary` is compiled `as const`; indexed by the broad `Entity`
  // union, each entity's literal `hiddenWhen` narrows only through the
  // schema-level type, so read it through that annotation.
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
  const [lineKind, expenseName, expenseProduct]: unknown[] = useWatch({
    control: form.control,
    name: ["lineKind", "name", "productId"],
  });
  const projectIsAllocated =
    entity === "expense" &&
    resolveExpenseLineKind({
      lineKind: basisValueOf(lineKind),
      name: basisValueOf(expenseName),
      productId: basisValueOf(expenseProduct),
    }) !== "principal";
  useEffect(() => {
    if (projectIsAllocated && basisValueOf(form.getValues("projectId"))) {
      form.setValue("projectId", null, { shouldDirty: true });
    }
  }, [form, projectIsAllocated]);
  const fields = model.fields.filter(
    (field) =>
      intentFieldKeys.includes(field.key) &&
      field.control !== null &&
      !(projectIsAllocated && field.key === "projectId") &&
      !hiddenFieldKeys.has(field.key),
  );
  const scopedFieldKeys = useMemo(
    () =>
      Array.from(
        new Set(
          fields.flatMap((field) => referenceScopeFields(field.reference)),
        ),
      ),
    [fields],
  );
  const scopedValues: unknown[] = useWatch({
    control: form.control,
    name: scopedFieldKeys,
  });
  const scopedValueRecord = useMemo(
    () =>
      entityEditValueBagSchema.parse(
        Object.fromEntries(
          scopedFieldKeys.map((key, index) => [key, scopedValues[index]]),
        ),
      ),
    [scopedFieldKeys, scopedValues],
  );
  const declaredSections: readonly CompiledEditSection[] =
    entitySummary[entity].edit.sections;
  // `fields` already reflects this render's `hiddenWhen`/`projectIsAllocated`
  // state, so the grouping has to be recomputed with it every render — no
  // `useMemo` (a stale memo would leave a newly (in)visible field in the
  // wrong bucket, or drop it from every bucket, until something else
  // happened to invalidate the memo).
  const groups = buildFieldGroups(declaredSections, fields);

  return (
    <>
      {groups.map((group, index) => {
        const renderField = (field: PrimitiveFieldModel) =>
          renderIntentField({
            entity,
            field,
            form,
            idPrefix,
            mode,
            record,
            scopedValueRecord,
          });
        const nodes = pairHalfWidthFields(group.fields).map((row) =>
          row.length === 2 ? (
            <SideBySideFields key={`${row[0].key}-${row[1].key}`}>
              {renderField(row[0])}
              {renderField(row[1])}
            </SideBySideFields>
          ) : (
            renderField(row[0])
          ),
        );
        if (group.title === null) return nodes;
        return (
          <FormSection
            key={group.id}
            title={group.title}
            first={index === 0}
            collapsed={group.collapsed}
          >
            {nodes}
          </FormSection>
        );
      })}
    </>
  );
}
