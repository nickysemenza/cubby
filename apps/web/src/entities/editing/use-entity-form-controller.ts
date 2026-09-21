import { generatedEntityEditIntents } from "@cubby/schemas/entity-edit-intents";
import { entityFieldSchemaMaps } from "@cubby/schemas/entity-field-schema-maps";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMemo } from "react";
import {
  type DefaultValues,
  type FieldValues,
  type Resolver,
  useForm,
} from "react-hook-form";
import { z } from "zod";

import { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import {
  buildUpdateObject,
  detectComboboxIdChange,
  type EntityFormProps,
  getSubmitButtonText,
} from "~/app/_components/form-utils";

/**
 * Entities carrying a generated edit-intent roster — the default field list a
 * form falls back to when it doesn't pass its own `fields` option.
 */
type IntentEntity = keyof typeof generatedEntityEditIntents;

type ShortcodeEntityType = Parameters<typeof parseShortcodeFor>[0];

type FieldModel = (typeof entityFieldModels)[IntentEntity];
type FieldModelEntry = FieldModel["fields"][number];
type SingularReferenceField = FieldModelEntry & {
  reference: { entity: string; multiple: false };
};

/**
 * A dynamically-keyed accumulator's value contract, derived from its owning
 * record/values type rather than widened to `unknown` — the field roster
 * (and so the concrete key set) is only known at runtime, but every value
 * that flows through one of these is still one of `T`'s own field values.
 */
type FieldValueOf<T> = T[keyof T];

/**
 * The value union every submit-time update accumulator holds: a field off
 * the record being edited, a field off this form's own values, or a parsed
 * reference shortcode — never `unknown`, even though the concrete key set is
 * only known at runtime (the field roster is chosen by `fields`/the entity's
 * edit intent, not by this file).
 */
type UpdateValue<TRecord, TFieldValues> =
  | FieldValueOf<TRecord>
  | FieldValueOf<TFieldValues>
  | ReturnType<typeof parseShortcodeFor>
  | null
  | undefined;

function hasSingularReference(
  field: FieldModelEntry,
): field is SingularReferenceField {
  return field.reference !== null && !field.reference.multiple;
}

/** Combobox item path convention: the field key without its "Id" suffix
 * ("productId" -> "product"), matching every existing hand-rolled form. */
function defaultItemPath(fieldKey: string): string {
  return fieldKey.endsWith("Id") ? fieldKey.slice(0, -2) : fieldKey;
}

function pick(source: Record<string, z.ZodTypeAny>, keys: readonly string[]) {
  const picked: Record<string, z.ZodTypeAny> = {};
  for (const key of keys) {
    const schema = source[key];
    if (schema) picked[key] = schema;
  }
  return picked;
}

/** Metadata for one reference field (a combobox-backed foreign key)
 * discovered from the entity's field model. */
interface EntityFormReferenceField {
  key: string;
  /** RHF path holding the `ComboboxItem`, e.g. "product" for "productId". */
  path: string;
  entity: string;
  nullable: boolean;
  label: string;
}

export interface EntityFormControllerConfig<
  TFieldValues extends FieldValues,
  TRecord extends object,
  TCreateData,
  TEditData,
> {
  /** Field-key roster to edit; defaults to the entity's `full` edit intent. */
  fields?: readonly string[];
  /**
   * Extra Zod entries merged into the resolver on top of the generated
   * create/update schema map. Two uses: an editor-only field with no server
   * counterpart (location/product's `collections`, folded into `tags` at
   * submit), or overriding a generated field's canonicalizing server schema
   * with a friendlier display-oriented one (product's `upc`/`isbn`/`fdc_id` —
   * see `product-form.tsx`).
   */
  extend?: Record<string, z.ZodTypeAny>;
  defaultValues: DefaultValues<TFieldValues>;
  /** Override a reference field's combobox-item path (defaults to the field
   * key without its trailing "Id"). Set a field to `null` when its form
   * stores the persisted reference ID directly rather than a ComboboxItem. */
  referencePaths?: Partial<Record<string, string | null>>;
  /** Scalar keys diffed via `buildUpdateObject` in edit mode. Defaults to
   * every non-reference field in `fields`. */
  editableScalarKeys?: readonly string[];
  /** True when edit mode has a pending change `buildUpdateObject` can't see
   * (e.g. image uploads tracked outside RHF state via `useImageState`). */
  hasAdditionalChanges?: () => boolean;
  transform: {
    /**
     * Pre-process form values before the scalar diff — folding, filtering, or
     * display coercions a form needs (e.g. product's tags/collections fold,
     * or stripping a stray "" / 0 sentinel). `referenceUpdates` carries the
     * reference fields' already-computed diffs, keyed by field key, so a form
     * can react to a just-changed reference (location's `type` following a
     * `productId` link/unlink). Defaults to identity.
     */
    diffValues?: (
      values: TFieldValues,
      referenceUpdates: Readonly<
        Record<string, UpdateValue<TRecord, TFieldValues>>
      >,
    ) => Partial<TFieldValues>;
    /**
     * Pre-process the existing record before the scalar diff — e.g. deriving
     * a display-format comparison value from a stored column (product's
     * `upc`/`isbn`, derived from `primaryGtin` — a virtual field with no
     * counterpart on `TRecord` itself, which is why this isn't `Partial<
     * TRecord>`). Defaults to identity.
     */
    diffRecord?: (
      record: TRecord,
    ) => Record<string, UpdateValue<TRecord, TFieldValues>>;
    create: (values: TFieldValues) => TCreateData;
    edit: (updates: Partial<TRecord>, values: TFieldValues) => TEditData;
  };
}

export interface EntityFormController<TFieldValues extends FieldValues> {
  form: ReturnType<typeof useForm<TFieldValues>>;
  handleSubmit: (values: TFieldValues) => Promise<void>;
  isPending: boolean;
  error?: string | readonly string[];
  submitButtonText: string;
  references: Readonly<Record<string, EntityFormReferenceField>>;
}

/**
 * Shared scaffolding behind the rich entity forms (product, location,
 * ingredient, inventory): builds the RHF resolver from the generated
 * create/update field-schema map instead of a hand-written Zod object,
 * discovers combobox-backed reference fields from the entity's field model,
 * and owns the create/edit submit branching (`buildUpdateObject` +
 * `detectComboboxIdChange`). A form supplies `defaultValues` and `transform`
 * (the genuinely rich, entity-specific conversions) and renders `FormWrapper`
 * plus its own field layout around the result.
 */
export function useEntityFormController<
  E extends IntentEntity,
  TFieldValues extends FieldValues,
  TRecord extends object,
  TCreateData,
  TEditData,
>(
  entity: E,
  props: EntityFormProps<TCreateData, TEditData, TRecord>,
  config: EntityFormControllerConfig<
    TFieldValues,
    TRecord,
    TCreateData,
    TEditData
  >,
): EntityFormController<TFieldValues> {
  const model = entityFieldModels[entity];
  const fieldKeys =
    config.fields ?? generatedEntityEditIntents[entity].fields.full;
  const referencePaths = config.referencePaths;

  const { scalarKeys, scalarReferenceKeys, referenceFields, references } =
    useMemo(() => {
      const scalarReferenceFields = model.fields.filter(
        (field): field is SingularReferenceField =>
          hasSingularReference(field) &&
          fieldKeys.includes(field.key) &&
          referencePaths?.[field.key] === null,
      );
      const refFields = model.fields.filter(
        (field): field is SingularReferenceField =>
          hasSingularReference(field) &&
          fieldKeys.includes(field.key) &&
          referencePaths?.[field.key] !== null,
      );
      const refKeySet = new Set<string>(refFields.map((field) => field.key));
      const scalars = fieldKeys.filter((key) => !refKeySet.has(key));
      const refs: Record<string, EntityFormReferenceField> = {};
      for (const field of refFields) {
        refs[field.key] = {
          key: field.key,
          path: referencePaths?.[field.key] ?? defaultItemPath(field.key),
          entity: field.reference.entity,
          nullable: field.nullable,
          label: field.label,
        };
      }
      return {
        scalarKeys: scalars,
        scalarReferenceKeys: new Set(
          scalarReferenceFields
            .filter((field) => field.nullable)
            .map((field) => field.key),
        ),
        referenceFields: refFields,
        references: refs,
      };
    }, [model, fieldKeys, referencePaths]);

  // SAFETY: the generated schema map is keyed by every field this entity
  // declares; `entity` selects the map, so the lookup always resolves.
  const schemaMap = entityFieldSchemaMaps[entity][
    props.mode === "create" ? "create" : "update"
  ] as Record<string, z.ZodTypeAny>;
  const extend = config.extend;

  const resolverSchema = useMemo(() => {
    const resolverFields = pick(schemaMap, scalarKeys);
    for (const key of scalarReferenceKeys) {
      const schema = resolverFields[key];
      if (schema) {
        resolverFields[key] = z.preprocess(
          (value) => (value === "" ? null : value),
          schema,
        );
      }
    }
    for (const field of Object.values(references)) {
      resolverFields[field.path] = field.nullable
        ? ComboboxItem.nullable()
        : ComboboxItem.nullable().refine((item) => item !== null, {
            message: `Please select a ${field.label.toLowerCase()}`,
          });
    }
    Object.assign(resolverFields, extend ?? {});
    return z.object(resolverFields);
  }, [schemaMap, scalarKeys, scalarReferenceKeys, references, extend]);

  // SAFETY: the resolver schema is assembled at runtime from the generated
  // schema map, discovered reference fields, and `extend` — every RHF path
  // this form registers is covered by construction, but TS can't correlate a
  // dynamically-built object schema with the caller's own `TFieldValues`.
  const untypedResolver: unknown = zodResolver(resolverSchema);
  const form = useForm<TFieldValues>({
    // SAFETY: see the `untypedResolver` declaration above.
    resolver: untypedResolver as Resolver<TFieldValues>,
    defaultValues: config.defaultValues,
  });

  const editableScalarKeys = config.editableScalarKeys ?? scalarKeys;

  const handleSubmit = async (values: TFieldValues) => {
    if (props.mode === "create") {
      await props.onCreate(config.transform.create(values));
      return;
    }

    const record = props.entity;
    const diffRecord = config.transform.diffRecord
      ? { ...record, ...config.transform.diffRecord(record) }
      : record;

    const referenceUpdates: Record<
      string,
      UpdateValue<TRecord, TFieldValues>
    > = {};
    for (const field of referenceFields) {
      const ref = references[field.key];
      if (!ref) continue;
      // SAFETY: the reference-path convention (the combobox item lives at
      // `record[path]`) is validated by construction — every `ref.path` here
      // came from this same field model.
      const currentId =
        (record as Record<string, { id: string } | null | undefined>)[ref.path]
          ?.id ?? null;
      // SAFETY: same reference-path convention, applied to the form values.
      const comboValue = (
        values as Record<string, ComboboxItem | null | undefined>
      )[ref.path];
      // SAFETY: `ref.entity` names one of this field model's own reference
      // targets, always a valid shortcode entity key.
      const change = detectComboboxIdChange(currentId, comboValue, (value) =>
        parseShortcodeFor(ref.entity as ShortcodeEntityType, value),
      );
      if (change !== undefined) {
        referenceUpdates[field.key] = change;
      }
    }

    const diffValues = config.transform.diffValues
      ? config.transform.diffValues(values, referenceUpdates)
      : values;

    // SAFETY: `buildUpdateObject` only needs an index-by-string-key view of
    // the record/values pair it diffs; `editableScalarKeys` is this form's
    // own declared subset of `TRecord`'s fields.
    const scalarUpdates = buildUpdateObject(
      diffRecord as Record<string, UpdateValue<TRecord, TFieldValues>>,
      diffValues as Record<string, UpdateValue<TRecord, TFieldValues>>,
      editableScalarKeys,
    );
    const updates = { ...scalarUpdates, ...referenceUpdates };

    const hasChanges =
      Object.keys(updates).length > 0 ||
      (config.hasAdditionalChanges?.() ?? false);

    if (hasChanges) {
      // SAFETY: `updates` only ever holds diffs for `TRecord`'s own fields
      // (scalar keys from `editableScalarKeys`, reference keys from this
      // entity's field model).
      await props.onEdit(
        config.transform.edit(updates as Partial<TRecord>, values),
      );
    } else {
      props.onCancel?.();
    }
  };

  return {
    form,
    handleSubmit,
    isPending: props.isPending,
    error: props.error,
    submitButtonText: getSubmitButtonText(props.mode),
    references,
  };
}
