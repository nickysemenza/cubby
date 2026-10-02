import type { Entity } from "@cubby/schemas/entity";
import type { CompiledEntityPresentation } from "@cubby/schemas/entity-definitions/definition";
import { generatedEntityEditIntents } from "@cubby/schemas/entity-edit-intents";
import { entityFieldSchemaMaps } from "@cubby/schemas/entity-field-schema-maps";
import {
  entityFieldModels,
  type EntityFieldModel,
} from "@cubby/schemas/entity-fields";
import { entityKeys, entitySummary } from "@cubby/schemas/entity-summary";
import {
  canClearExpenseDate,
  EXPENSE_DATE_REQUIRED_MESSAGE,
} from "@cubby/schemas/expense-fields";
import { displayGtin, externalIdInput } from "@cubby/schemas/external-id";
import { fieldResolutionsSchema } from "@cubby/schemas/field-resolution";
import { productLabelNutrition } from "@cubby/schemas/nutrition";
import { unitMappingInput } from "@cubby/schemas/unitmapping";
import {
  collectionSlugsFromTags,
  collectionTagFromSlug,
  normalizeCollectionSlug,
} from "@cubby/shared/collection-tag";
import { isNutrientKey } from "@cubby/usda";
import { isEqual } from "es-toolkit";
import { z } from "zod";

import { householdLocalDate } from "~/lib/household-date";
import {
  isCanonicalPriceMapping,
  isMoneyUnit,
} from "~/lib/price-mapping-utils";
import { wasm } from "~/lib/wasm";

import { readReferenceField } from "../entity-references";
import {
  parseEntityEditCreateInput,
  parseEntityEditUpdateInput,
} from "./mutation-data";
import type { EntityEditRegistry } from "./registry";
import type {
  EditableEntity,
  EntityEditAccess,
  EntityEditContext,
  EntityEditDefinition,
  EntityEditField,
  EntityEditIntentDefinition,
  EntityEditIssue,
  EntityEditOperation,
  EntityEditRecord,
  EntityEditValue,
  EntityEditValueBag,
} from "./types";
import { projectEntityEditRecordValue } from "./value-schema";

const editable: EntityEditAccess = { mode: "editable" };

const readOnly = (reason: string): EntityEditAccess => ({
  mode: "read-only",
  reason,
});

const valueFor = (record: EntityEditRecord | undefined, id: string) => {
  const candidate = Object.entries(record ?? {}).find(
    ([key]) => key === id,
  )?.[1];
  // Tolerant: a read projection may nest `Date`s (audit stamps on
  // `unitMappings`/`externalIds` rows); opening an editor never throws on
  // one (`value-schema.ts`).
  return projectEntityEditRecordValue(candidate);
};

/**
 * Whether a form value differs from its baseline. `baseline === undefined`
 * means the record carries no such key. For a write-only field (`readKey:
 * null`) that is the normal state, and a `null` form value against it is
 * *unchanged* — otherwise every untouched write-only field would emit
 * `{ field: null }` on save (product's `upc: null` retires the primary GTIN
 * through `syncPrimaryGtin`). A nullable *read* field absent from a partial
 * record still emits `null`: there the absence is an incomplete projection,
 * not "nothing stored", and an explicit clear must reach the server.
 */
const changed = (input: {
  record: EntityEditRecord | undefined;
  writeOnly: boolean;
  baseline: EntityEditValue;
  value: EntityEditValue;
}) => {
  if (!input.record) return true;
  if (input.writeOnly && input.baseline === undefined && input.value === null)
    return false;
  return !isEqual(input.baseline, input.value);
};

/**
 * The gallery pseudo-fields have no stored twin on the record: `images` is
 * the read shape, and `pendingImageIds`/`removeImageIds`/`imageOrder`/
 * `pendingImagePurposes` are write-only instructions. Their baseline is
 * derived from `images` (order) or is the empty list/map, and a patch
 * carries them only when they instruct something — an untouched gallery
 * sends none of them.
 */
const IMAGE_LIST_FIELDS = new Set(["pendingImageIds", "removeImageIds"]);
const IMAGE_PURPOSES_FIELD = "pendingImagePurposes";
const imagePurposeMap = (
  value: EntityEditValue,
): Record<string, string> | undefined => {
  const parsed = z.record(z.string(), z.string()).safeParse(value);
  return parsed.success ? parsed.data : undefined;
};
const recordImageIds = (record: EntityEditRecord | undefined): string[] =>
  z
    .array(z.object({ id: z.string() }).loose())
    .catch([])
    .parse(record?.images)
    .map((image) => image.id);
const imageIdList = (value: EntityEditValue): string[] | undefined => {
  const parsed = z.array(z.string()).safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const multipleReferenceIdsFromRecord = <E extends EditableEntity>(
  entity: E,
  field: EntityFieldModel["fields"][number],
  record: EntityEditRecord,
): string[] | undefined => {
  if (!field.reference?.multiple) return undefined;
  const direct = readReferenceField(record, field)?.items ?? [];
  const projection =
    direct.length > 0
      ? direct
      : entityFieldModels[entity].fields
          .filter(
            (candidate) =>
              candidate.key !== field.key &&
              candidate.readKey !== null &&
              candidate.reference?.multiple === true &&
              candidate.reference.entity === field.reference?.entity,
          )
          .flatMap(
            (candidate) => readReferenceField(record, candidate)?.items ?? [],
          )
          .filter(
            (item, index, items) =>
              items.findIndex((candidate) => candidate.id === item.id) ===
              index,
          );
  return projection.length > 0 ? projection.map((item) => item.id) : undefined;
};

const noIssues = (): readonly EntityEditIssue[] => [];

type EditField<E extends EditableEntity> = EntityEditField<
  E,
  EntityEditRecord,
  EntityEditValue,
  EntityEditValueBag
>;

type EditIntent<E extends EditableEntity> = EntityEditIntentDefinition<
  E,
  EntityEditRecord
>;

interface FieldOptions<E extends EditableEntity> {
  required?: boolean;
  normalize?: (value: EntityEditValue) => EntityEditValue;
  access?: EditField<E>["access"];
  validate?: EditField<E>["validate"];
  /**
   * Override the generic record/create-default `initial` lookup — for an
   * editor-only pseudo field with no model field to read a record value from
   * (e.g. location's `collections`, folded from the stored `tags` at submit
   * and unfolded back into a list here for edit-mode seeding), or for a
   * model field whose form shape is a projection of the record's (rows
   * reduced to their input shape). On update the same projection is the
   * baseline `toPatch` diffs against, so an untouched projected field emits
   * nothing and a cleared one emits `null`.
   */
  initial?: EditField<E>["initial"];
}

interface IntentOptions<E extends EditableEntity> {
  /** Defaults to the entity's semantic field list under the same intent name. */
  fields?: readonly string[];
  access?: EditIntent<E>["access"];
  validate?: EditIntent<E>["validate"];
  defaults?: EditIntent<E>["defaults"];
  buildData?: (
    patch: EntityEditValueBag,
    context: EntityEditContext,
  ) => EntityEditValueBag;
}

/** Bare intent names, or names paired with the configuration they need. */
type IntentDeclaration<E extends EditableEntity> =
  | readonly string[]
  | Readonly<Record<string, IntentOptions<E>>>;

type FieldOverrides<E extends EditableEntity> = Readonly<
  Record<string, FieldOptions<E> | "trimmedName" | "nullableText">
>;

interface EntityEditBuilder<E extends EditableEntity> {
  fieldsFrom(
    intents: readonly string[],
    overrides?: FieldOverrides<E>,
  ): readonly EditField<E>[];
  fieldsFor(semanticIntent: string): readonly string[];
}

const isFieldShorthand = <E extends EditableEntity>(
  value: FieldOptions<E> | "trimmedName" | "nullableText" | undefined,
): value is "trimmedName" | "nullableText" => typeof value === "string";

// Editor blank handling predates API parsing and is part of the form contract.
const trimNormalize = (value: EntityEditValue): EntityEditValue => {
  const parsed = z.string().safeParse(value);
  return parsed.success ? parsed.data.trim() : value;
};

const nullableTrimNormalize = (value: EntityEditValue): EntityEditValue => {
  const parsed = z.string().safeParse(value);
  return parsed.success ? parsed.data.trim() || null : value;
};

/**
 * Derives the same `"trimmedName"` / `"nullableText"` / `{ required: true }`
 * behaviour a per-field override used to spell out by hand, from the field's
 * own declaration (`packages/schemas/src/entity-definitions/*.entity.ts`):
 * a text field required on create trims and rejects blank; a nullable text
 * field trims and collapses blank to `null`; a nullable singular reference
 * gets the same trim-to-null treatment (a shortcode is a string too); a
 * required non-text field is simply required. Returns `undefined` when none
 * of those apply — the field keeps `makeField`'s own defaults unless an
 * explicit override says otherwise. `fieldsFrom`'s `overrides` argument still
 * wins over this.
 */
const defaultFieldOptions = <E extends EditableEntity>(
  field: EntityFieldModel["fields"][number],
): FieldOptions<E> | undefined => {
  const derived = derivedFieldOptions<E>(field);
  // `control.required` states the editor's rule where it differs from the
  // create schema's (a manufacturer the schema merely defaults, an amount a
  // dedicated validator reports); null derives it.
  const required = field.control?.required;
  return required === null || required === undefined
    ? derived
    : { ...derived, required };
};

const derivedFieldOptions = <E extends EditableEntity>(
  field: EntityFieldModel["fields"][number],
): FieldOptions<E> | undefined => {
  if (field.kind === "text") {
    if (field.requiredOnCreate)
      return { required: true, normalize: trimNormalize };
    if (field.nullable)
      return { required: false, normalize: nullableTrimNormalize };
    return undefined;
  }
  if (field.reference && !field.reference.multiple && field.nullable) {
    return { required: false, normalize: nullableTrimNormalize };
  }
  if (field.requiredOnCreate) return { required: true };
  return undefined;
};

/** The bare-kind fallback once a field has no schema `.default()` of its own. */
const kindDefault = (
  field: EntityFieldModel["fields"][number],
): EntityEditValue => {
  if (field.reference) return field.reference.multiple ? [] : null;
  if (field.kind === "text") return field.nullable ? null : "";
  if (field.kind === "text-array") return [];
  if (field.kind === "boolean") return false;
  return null;
};

/**
 * A create-only initial value derived from the field's own declaration, in
 * order: the manifest's `control.initial` (today's household date, or a
 * literal `{ value }`); the generated create schema's own Zod default (Zod 4
 * exposes it as a plain `def.defaultValue` property on a `ZodDefault`
 * instance — proven in `definitions.unit.test.ts`); else a value implied by
 * the field's kind. Never consulted for update — an existing record's own
 * value always wins there, in `makeField`'s `initial` below.
 */
const genericCreateDefault = <E extends EditableEntity>(
  entity: E,
  field: EntityFieldModel["fields"][number],
): EntityEditValue => {
  const initial = field.control?.initial;
  if (initial === "today") return householdLocalDate();
  if (initial !== null && initial !== undefined) return initial.value;
  // SAFETY: `entityFieldSchemaMaps[entity].create` is keyed by every field
  // this entity's create contract accepts; `field.key` names one of this
  // same entity's own model fields, so the lookup is a schema for `field.key`
  // or `undefined` for an editor-only pseudo field with no create contract.
  const schema = (
    entityFieldSchemaMaps[entity].create as Record<string, z.ZodTypeAny>
  )[field.key];
  if (schema instanceof z.ZodDefault) {
    // SAFETY: every Zod schema this map holds validates one of
    // `EntityEditValue`'s own primitive/array/object shapes — the generic
    // editor's value bag was designed to be a superset of every field's
    // create/update payload.
    return schema.def.defaultValue as EntityEditValue;
  }
  return kindDefault(field);
};

/**
 * The update-surface locks the declaration carries: `edit.readOnlyOnUpdate`
 * (unconditional) and `edit.readOnlyWhen` (a field's value locks a set of
 * fields, e.g. a record whose lifecycle state forbids editing certain fields
 * once it reaches that state). No entity declares `readOnlyWhen` currently;
 * the rule stays wired for the next one that needs it. The server enforces
 * the same rule; this is what turns the refusal into a disabled control
 * instead of an error.
 */
const declaredAccess = (
  entity: EditableEntity,
  id: string,
): EditField<EditableEntity>["access"] => {
  // `entitySummary` is compiled `as const`; every entity's `edit.readOnlyWhen`
  // is currently `[]`, so indexing by a non-literal `entity` narrows the
  // union down to the literal `readonly []` instead of the schema's real
  // element type. Read through the compiled presentation type so a future
  // entity that declares a rule needs no change here.
  const { readOnlyOnUpdate, readOnlyWhen }: CompiledEntityPresentation["edit"] =
    entitySummary[entity].edit;
  const unconditional = readOnlyOnUpdate.some((key) => key === id);
  const rules = readOnlyWhen.filter((rule) =>
    rule.fields.some((key) => key === id),
  );
  if (!unconditional && rules.length === 0) return () => editable;
  return ({ operation, record }) => {
    if (operation !== "update") return editable;
    if (unconditional)
      return readOnly("Changed through the record's own lifecycle actions.");
    const locked = rules.find(
      (rule) => record !== undefined && record[rule.field] === rule.equals,
    );
    return locked
      ? readOnly(`Locked while ${locked.field} is ${String(locked.equals)}.`)
      : editable;
  };
};

const builderFor = <E extends EditableEntity>(
  entity: E,
): EntityEditBuilder<E> => {
  // Widened to a plain `string` key on purpose: `id` (a field id, an
  // editor-only pseudo field, or a shorthand override target) is never
  // narrowed to this entity's own field-key union at the call sites below.
  const fieldModelByKey = new Map<string, EntityFieldModel["fields"][number]>(
    entityFieldModels[entity].fields.map((field) => [field.key, field]),
  );
  const resolutionFieldByMode = new Map<string, string>();
  for (const field of entityFieldModels[entity].fields) {
    for (const [key, value] of Object.entries(field.resolution?.reset ?? {})) {
      if (value === "inherit") resolutionFieldByMode.set(key, field.key);
    }
  }

  const initialResolutionMode = (
    id: string,
    record: EntityEditRecord | undefined,
  ) => {
    const resolutionField = resolutionFieldByMode.get(id);
    if (!resolutionField) return undefined;
    const resolutions = fieldResolutionsSchema.safeParse(
      record?.fieldResolutions,
    );
    const mode = resolutions.success
      ? resolutions.data[resolutionField]?.mode
      : undefined;
    return mode === "inherit" || mode === undefined ? "inherit" : "explicit";
  };

  const makeField = (id: string, options?: FieldOptions<E>): EditField<E> => ({
    entity,
    id,
    access: options?.access ?? declaredAccess(entity, id),
    initial: (input) => {
      if (options?.initial) return options.initial(input);
      const { operation, record, context } = input;
      if (IMAGE_LIST_FIELDS.has(id)) return [];
      if (id === IMAGE_PURPOSES_FIELD) return {};
      if (id === "imageOrder")
        return operation === "update" ? recordImageIds(record) : [];
      const existing = valueFor(record, id);
      if (existing !== undefined) return existing;
      const resolutionMode = initialResolutionMode(id, record);
      if (resolutionMode !== undefined) return resolutionMode;
      const field = fieldModelByKey.get(id);
      if (operation === "update" && record && field) {
        const referenceIds = multipleReferenceIdsFromRecord(
          entity,
          field,
          record,
        );
        if (referenceIds !== undefined) return referenceIds;
      }
      if (id === "parentProjectId" && context.parentProjectId !== undefined) {
        return context.parentProjectId;
      }
      if (operation !== "create") return null;
      return field ? genericCreateDefault(entity, field) : null;
    },
    normalize: options?.normalize ?? ((value) => value),
    validate: (input) => {
      const { value } = input;
      const text = z.string().safeParse(value);
      if (
        options?.required &&
        (value == null || (text.success && !text.data.trim()))
      ) {
        return [
          { field: id, message: "This field is required.", source: "client" },
        ];
      }
      return options?.validate?.(input) ?? noIssues();
    },
    toPatch: (input) => {
      const { value, record } = input;
      if (IMAGE_LIST_FIELDS.has(id)) {
        const ids = imageIdList(value);
        return ids && ids.length > 0 ? { [id]: ids } : undefined;
      }
      if (id === IMAGE_PURPOSES_FIELD) {
        const purposes = imagePurposeMap(value);
        return purposes && Object.keys(purposes).length > 0
          ? { [id]: purposes }
          : undefined;
      }
      if (id === "imageOrder") {
        const ids = imageIdList(value);
        return ids && record && !isEqual(ids, recordImageIds(record))
          ? { imageOrder: ids }
          : undefined;
      }
      const resolutionMode = initialResolutionMode(id, record);
      if (resolutionMode !== undefined) {
        return isEqual(value, resolutionMode) ? undefined : { [id]: value };
      }
      // A field with its own `initial` projection diffs against that
      // projection, not the raw record — the record's shape (full rows with
      // audit stamps, a GTIN the editor shows as a UPC) is not what the form
      // holds, so the raw value would read as changed on every save and a
      // cleared value could never be told apart from an absent one.
      const baseline =
        options?.initial && record
          ? options.initial(input)
          : valueFor(record, id);
      return changed({
        record,
        writeOnly: fieldModelByKey.get(id)?.readKey === null,
        baseline,
        value,
      })
        ? { [id]: value }
        : undefined;
    },
  });

  return {
    fieldsFrom: (intents, overrides) => {
      const ids = new Set(
        intents.flatMap((intent) => fieldsFor(entity, intent)),
      );
      return [...ids].map((id) => {
        const override = overrides?.[id];
        if (isFieldShorthand(override)) {
          return makeField(
            id,
            override === "trimmedName"
              ? { required: true, normalize: trimNormalize }
              : { required: false, normalize: nullableTrimNormalize },
          );
        }
        const field = fieldModelByKey.get(id);
        const defaults = field ? defaultFieldOptions<E>(field) : undefined;
        return makeField(id, { ...defaults, ...override });
      });
    },
    fieldsFor: (semanticIntent) => fieldsFor(entity, semanticIntent),
  };
};

/** Fields an intent's editor refuses to leave blank beyond the schema's rule. */
const intentRequiredFields = (
  entity: EditableEntity,
  semanticIntent: string,
): readonly string[] => {
  const required: Readonly<Record<string, readonly string[] | undefined>> =
    generatedEntityEditIntents[entity].required;
  return required[semanticIntent] ?? [];
};

const isBlank = (value: EntityEditValue): boolean => {
  const text = z.string().safeParse(value);
  return value == null || (text.success && !text.data.trim());
};

/**
 * The intent's declared checks: `intents.required` fields that are blank and
 * `presentation.spans` whose end precedes its start. Both are data in the
 * entity declaration; only `options.validate` is entity-specific.
 */
const declaredIntentIssues = <E extends EditableEntity>(
  entity: E,
  semanticIntent: string,
  fields: readonly string[],
  input: Parameters<NonNullable<EditIntent<E>["validate"]>>[0],
): readonly EntityEditIssue[] => {
  const { values } = input;
  const issues: EntityEditIssue[] = [];
  for (const id of intentRequiredFields(entity, semanticIntent)) {
    if (isBlank(values[id]))
      issues.push({
        field: id,
        message: "This field is required.",
        source: "client",
      });
  }
  const spans: readonly { start: string; end: string }[] =
    entitySummary[entity].spans;
  for (const { start, end } of spans) {
    if (!fields.includes(start) || !fields.includes(end)) continue;
    const from = z.string().min(1).safeParse(values[start]);
    const to = z.string().min(1).safeParse(values[end]);
    if (from.success && to.success && to.data < from.data)
      issues.push({
        field: end,
        message: `${fieldLabel(entity, end)} must be on or after ${fieldLabel(entity, start)}.`,
        source: "client",
      });
  }
  return issues;
};

const fieldLabel = (entity: EditableEntity, key: string): string =>
  entityFieldModels[entity].fields.find((field) => field.key === key)?.label ??
  key;

/**
 * The canonical contract is the validator of record: run the entity's own
 * create/update Zod schema over the built payload and report its issues
 * beside the field they name, instead of re-stating its refinements in the
 * editor (a non-zero amount, a posted transaction's date).
 */
const parseCanonical = <T>(
  parse: () => T,
):
  | { ok: true; value: T }
  | { ok: false; issues: readonly EntityEditIssue[] } => {
  try {
    return { ok: true, value: parse() };
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    return {
      ok: false,
      issues: error.issues.map((issue) => ({
        field: issue.path.length > 0 ? issue.path.join(".") : undefined,
        message: issue.message,
        source: "client" as const,
      })),
    };
  }
};

const makeIntent = <E extends EditableEntity>(
  entity: E,
  operation: EntityEditOperation,
  semanticIntent: string,
  options: IntentOptions<E>,
): EditIntent<E> => {
  const fields = options.fields ?? fieldsFor(entity, semanticIntent);
  return {
    fields,
    access: options.access ?? (() => editable),
    validate: (input) => [
      ...declaredIntentIssues(entity, semanticIntent, fields, input),
      ...(options.validate?.(input) ?? []),
    ],
    defaults: options.defaults,
    build: ({ record, patch, context }) => {
      const data = options.buildData
        ? options.buildData(patch, context)
        : patch;
      // Computed from the post-`buildData` patch, not the pre-`buildData`
      // dirty-field patch: a `buildData` that injects a fixed key (e.g.
      // settle's unconditional `future: false`) must make an otherwise-empty
      // edit submit. See `entities/editing/definitions.unit.test.ts`.
      const keys = Object.keys(data);
      if (operation === "create") {
        const parsed = parseCanonical(() =>
          parseEntityEditCreateInput(entity, data),
        );
        if (!parsed.ok) return { ok: false, issues: parsed.issues };
        return {
          ok: true,
          changed: true,
          command: {
            entity,
            operation,
            intent: semanticIntent,
            data: parsed.value,
          },
        };
      }
      if (!record) {
        return {
          ok: false,
          issues: [
            {
              message: `${entity} ${operation} requires a record.`,
              source: "client",
            },
          ],
        };
      }
      if (operation === "update") {
        const parsed = parseCanonical(() =>
          parseEntityEditUpdateInput(entity, data),
        );
        if (!parsed.ok) return { ok: false, issues: parsed.issues };
        return {
          ok: true,
          changed: keys.length > 0,
          command: {
            entity,
            operation,
            intent: semanticIntent,
            id: record.id,
            data: parsed.value,
          },
        };
      }
      return {
        ok: true,
        changed: true,
        command: {
          entity,
          operation,
          intent: semanticIntent,
          ids: [record.id],
        },
      };
    },
  };
};

const isIntentNameList = <E extends EditableEntity>(
  declared: IntentDeclaration<E>,
): declared is readonly string[] => Array.isArray(declared);

/** Declaration order is observable: the first intent is the operation default. */
const intentEntries = <E extends EditableEntity>(
  declared: IntentDeclaration<E>,
): [string, IntentOptions<E>][] => {
  if (isIntentNameList(declared)) {
    return declared.map((name) => [name, {}]);
  }
  return Object.entries(declared);
};

const operationDefinition = <E extends EditableEntity>(
  entity: E,
  operation: EntityEditOperation,
  declared: IntentDeclaration<E>,
) => {
  const entries = intentEntries(declared);
  const first = entries[0];
  if (!first) throw new Error(`${entity}.${operation} requires an intent`);
  return {
    defaultIntent: first[0],
    intents: Object.fromEntries(
      entries.map(([name, options]) => [
        name,
        makeIntent(entity, operation, name, options),
      ]),
    ),
  };
};

/**
 * Per-entity editing logic the declaration cannot state: a form value
 * derived from a record's projection, a cross-field validator, a payload
 * fold. Everything else — fields, intents, defaults, required-ness, date
 * ranges — is generated from the entity declaration and canonical Zod.
 * Entries may only be removed (see `override-registry-shrink.unit.test.tsx`).
 */
interface EntityEditHooks<E extends EditableEntity> {
  /** Field behavior beyond what the declaration derives. */
  fields?: FieldOverrides<E>;
  /** Options for the named create intents. */
  create?: Readonly<Record<string, IntentOptions<E>>>;
  /** Options for the named update intents. */
  update?: Readonly<Record<string, IntentOptions<E>>>;
}

/**
 * The registry entry for one entity: the declared intents in their declared
 * order (the first is each operation's default), their fields unioned into
 * the field list, and the hooks' options attached by intent name.
 */
const buildEntityDefinition = <E extends EditableEntity>(
  entity: E,
  hooks: EntityEditHooks<E> | undefined,
): EntityEditDefinition<E, EntityEditRecord> => {
  const declared = generatedEntityEditIntents[entity];
  const operationIntents = (
    operation: "create" | "update",
  ): IntentDeclaration<E> => {
    const names: readonly string[] = declared[operation];
    const options = hooks?.[operation] ?? {};
    for (const name of Object.keys(options)) {
      if (!names.includes(name))
        throw new Error(
          `${entity} edit hooks configure the undeclared ${operation} intent ${name}`,
        );
    }
    return Object.fromEntries(names.map((name) => [name, options[name] ?? {}]));
  };
  return {
    entity,
    fields: builderFor(entity).fieldsFrom(
      Object.keys(declared.fields),
      hooks?.fields,
    ),
    operations: {
      delete: {
        defaultIntent: "delete",
        intents: {
          delete: makeIntent(entity, "delete", "delete", {
            fields: [],
            access: () => editable,
          }),
        },
      },
      create: operationDefinition(entity, "create", operationIntents("create")),
      update: operationDefinition(entity, "update", operationIntents("update")),
    },
  };
};

const validateExpenseDate: NonNullable<
  EntityEditIntentDefinition<EditableEntity, EntityEditRecord>["validate"]
> = ({ values, record }) => {
  const cost = values.cost === undefined ? record?.cost : values.cost;
  const date = values.date === undefined ? record?.date : values.date;
  return date || canClearExpenseDate(cost)
    ? noIssues()
    : [
        {
          field: Object.hasOwn(values, "date") ? "date" : "cost",
          message: EXPENSE_DATE_REQUIRED_MESSAGE,
          source: "client",
        },
      ];
};

const sourceAliasDraft = z.object({
  source: z.string(),
  alias: z.string(),
  externalAccountId: z.string().nullable().optional(),
});
const normalizeSourceAliases = (value: EntityEditValue) => {
  const parsed = z.array(sourceAliasDraft).safeParse(value);
  if (!parsed.success) return [];
  return parsed.data
    .map((alias) => ({
      source: alias.source.trim(),
      alias: alias.alias.trim(),
      externalAccountId: alias.externalAccountId?.trim() || null,
    }))
    .filter((alias) => alias.source && alias.alias);
};

const financialAccountIdentity = (patch: EntityEditValueBag) => {
  const kind = patch.kind;
  let identity: EntityEditValue;
  if (kind === "credit_card") {
    identity = {
      kind,
      issuer: String(patch.issuer ?? "").trim() || null,
      network: String(patch.network ?? "").trim() || null,
    };
  } else if (kind === "bank_account") {
    identity = {
      kind,
      institution: String(patch.institution ?? "").trim() || null,
      accountType: String(patch.accountType ?? "checking"),
    };
  } else if (kind === "stored_value") {
    identity = { kind, provider: String(patch.provider ?? "").trim() };
  } else if (kind === "other") {
    identity = {
      kind,
      institution: String(patch.institution ?? "").trim() || null,
    };
  } else {
    identity = { kind: "cash" };
  }
  return identity;
};

/**
 * The editor's single "Last four" becomes the account's current primary card;
 * the full dated `cardNumbers` history is MCP-only.
 */
const financialAccountCardNumbers = (patch: EntityEditValueBag) => {
  const last4 = String(patch.last4 ?? "").trim();
  return last4 && patch.kind !== "cash"
    ? [{ last4, kind: "primary", validFrom: null, validTo: null, note: null }]
    : [];
};

/** Creates flatten the identity discriminant; updates patch it in place. */
const financialAccountCreateData = (
  patch: EntityEditValueBag,
): EntityEditValueBag => ({
  name: patch.name,
  provisional: patch.provisional,
  identity: financialAccountIdentity(patch),
  // Switching the kind away from stored value after picking a provider must
  // not submit it: the server rejects a provider on any other kind.
  providerVendorId:
    patch.kind === "stored_value" ? (patch.providerVendorId ?? null) : null,
  cardNumbers: financialAccountCardNumbers(patch),
  sourceAliases: normalizeSourceAliases(patch.sourceAliases),
  notes: patch.notes,
});

const sourceReferenceDraft = z.object({
  source: z.string(),
  externalId: z.string(),
});
const normalizeFinancialTransaction = (
  patch: EntityEditValueBag,
): EntityEditValueBag => {
  const normalized = { ...patch };
  for (const key of [
    "purchaseId",
    "transactionDate",
    "postedDate",
    "merchant",
    "rawDescription",
    "sourceCategory",
    "notes",
  ]) {
    if (key in patch) normalized[key] = String(patch[key] ?? "").trim() || null;
  }
  if ("sourceRefs" in patch) {
    const parsed = z.array(sourceReferenceDraft).safeParse(patch.sourceRefs);
    normalized.sourceRefs = parsed.success
      ? parsed.data
          .map((reference) => ({
            source: reference.source.trim(),
            externalId: reference.externalId.trim(),
          }))
          .filter((reference) => reference.source && reference.externalId)
      : [];
  }
  return normalized;
};

/**
 * `collections` is an editor-only pseudo field (no model field, no stored
 * column): a friendlier list of bare slugs than the namespaced `tags` a
 * location actually stores. Folded into `tags` at submit, and unfolded back
 * out of the record's `tags` for edit-mode seeding (`initial` override below)
 * — kept next to `entity-primitive-fields.tsx`'s `location-collections`
 * renderer, which owns the RHF field this bag ultimately targets.
 */
const foldCollectionsIntoTags = (collections: EntityEditValue): string[] => {
  const parsed = z.array(z.string()).catch([]).parse(collections);
  return parsed
    .map((value) => value.trim())
    .filter((value) => value !== "")
    .map(normalizeCollectionSlug)
    .filter((slug) => slug !== "")
    .map(collectionTagFromSlug);
};

/**
 * `collections` folds into the stored `tags` column and never reaches the
 * create/update contract on its own. `type` is sent as chosen: a Product link
 * without one is stored as `furniture` by the server.
 */
const locationBuildData = (patch: EntityEditValueBag): EntityEditValueBag => {
  const data: EntityEditValueBag = { ...patch };
  if ("collections" in data) {
    data.tags = foldCollectionsIntoTags(data.collections);
    delete data.collections;
  }
  return data;
};

/** Field fragments per semantic intent come from the entity declaration. */
const fieldsFor = (entity: EditableEntity, semanticIntent: string) =>
  Object.entries(generatedEntityEditIntents[entity].fields).find(
    ([intent]) => intent === semanticIntent,
  )?.[1] ?? [];

/**
 * `wasm.isbn_from_gtin` calls the WASM boundary synchronously. Safe here:
 * `~/lib/wasm`'s module-level `await` resolves before any importer
 * evaluates, and the product editor is never reachable before that — the
 * detail page's `detail-field-renderers/product.tsx` already loads the same
 * module client-side ahead of any edit dialog mounting.
 */
const productPrimaryGtinIsbn = (
  record: EntityEditRecord | undefined,
): ReturnType<typeof wasm.isbn_from_gtin> | undefined => {
  const primaryGtin = z
    .string()
    .nullable()
    .catch(null)
    .parse(record?.primaryGtin);
  return primaryGtin == null ? undefined : wasm.isbn_from_gtin(primaryGtin);
};

/**
 * `upc`/`isbn` are write-only inputs (`readKey: null`); a product's one
 * stored barcode reads back as `primaryGtin`, split by which display field
 * it looks like — mirrors the retired `editProductFormDefaults`
 * (`product-form.tsx`). On create there is no record, so both stay `null`.
 */
const productUpcInitial: FieldOptions<"product">["initial"] = ({ record }) => {
  const primaryGtin = z
    .string()
    .nullable()
    .catch(null)
    .parse(record?.primaryGtin);
  return primaryGtin && !productPrimaryGtinIsbn(record)
    ? displayGtin(primaryGtin)
    : null;
};
const productIsbnInitial: FieldOptions<"product">["initial"] = ({ record }) =>
  productPrimaryGtinIsbn(record)?.isbn13 ?? null;

/**
 * `unitMappings`/`externalIds` read back as full rows (audit stamps, unit-
 * mapping provenance) — projected to their plain input shape so the form
 * holds exactly what it can resubmit, and an untouched row diffs to nothing.
 * Both input schemas are non-strict `z.object`s, so parsing a superset row
 * through them silently drops the extra columns; the `id` each keeps is the
 * MCP round-trip contract (resending it updates the row in place instead of
 * delete+recreate).
 */
const productUnitMappingsInitial: FieldOptions<"product">["initial"] = ({
  record,
}) => z.array(unitMappingInput).catch([]).parse(record?.unitMappings);
const productExternalIdsInitial: FieldOptions<"product">["initial"] = ({
  record,
}) => z.array(externalIdInput).catch([]).parse(record?.externalIds);

/**
 * The `labelNutrition` mid-edit draft: looser than the stored
 * `ProductLabelNutrition` so a half-filled form (serving grams entered, no
 * nutrients yet) is representable while typing. `servingGrams: null` means
 * "no label". Mirrors the retired `product-form.tsx`'s `labelNutritionDraft`/
 * `labelNutritionField`, moved here now that the form holds this shape
 * directly instead of through a zod-resolver preprocess.
 */
const productLabelNutritionDraft = z.object({
  servingGrams: z.number().nullable().optional(),
  source: z.string().nullable().optional(),
  nutrients: z.record(z.string(), z.number().nullable().optional()).optional(),
  inferredZeroNutrients: z.array(z.string()).optional(),
  inferenceEvidence: z.string().nullable().optional(),
});

const productLabelNutritionFromDraft = (value: unknown): EntityEditValue => {
  const parsed = productLabelNutritionDraft
    .nullable()
    .optional()
    .safeParse(value);
  if (
    !parsed.success ||
    parsed.data == null ||
    parsed.data.servingGrams == null
  )
    return null;
  const nutrients: Record<string, number> = {};
  for (const [key, amount] of Object.entries(parsed.data.nutrients ?? {})) {
    if (amount != null && isNutrientKey(key)) nutrients[key] = amount;
  }
  const result: z.infer<typeof productLabelNutrition> = {
    servingGrams: parsed.data.servingGrams,
    nutrients,
    source: parsed.data.source ?? null,
    inferenceEvidence: parsed.data.inferenceEvidence ?? null,
  };
  if (parsed.data.inferredZeroNutrients)
    result.inferredZeroNutrients = parsed.data.inferredZeroNutrients
      .filter(isNutrientKey)
      .filter((key) => nutrients[key] === undefined);
  return result;
};

/** Surfaces the stored schema's own "serving set, no nutrients" refine
 * beside the field instead of as a thrown build error. */
const productLabelNutritionValidate: NonNullable<
  FieldOptions<"product">["validate"]
> = ({ value }) => {
  const parsed = productLabelNutritionDraft
    .nullable()
    .optional()
    .safeParse(value);
  if (
    !parsed.success ||
    parsed.data == null ||
    parsed.data.servingGrams == null
  )
    return noIssues();
  const stored = productLabelNutrition.safeParse(
    productLabelNutritionFromDraft(parsed.data),
  );
  return stored.success
    ? noIssues()
    : stored.error.issues.map((issue) => ({
        field: "labelNutrition",
        message: issue.message,
        source: "client" as const,
      }));
};

/** Draft → stored transform, run only when `labelNutrition` actually
 * changed (an untouched field never enters the patch). */
const productBuildData = (patch: EntityEditValueBag): EntityEditValueBag => {
  if (!("labelNutrition" in patch)) return patch;
  return {
    ...patch,
    labelNutrition: productLabelNutritionFromDraft(patch.labelNutrition),
  };
};

/**
 * "1 each = $X" duplicates `product.price` (the scalar valuation column) —
 * forbidden as a conversion edge, same guard the retired `product-form.tsx`
 * ran through its zod resolver's `superRefine`. Other money mappings
 * ("1 quart = $4") stay legitimate conversion edges.
 */
const productUnitMappingsValidate: NonNullable<
  IntentOptions<"product">["validate"]
> = ({ values }) => {
  const mappings = z
    .array(unitMappingInput)
    .catch([])
    .parse(values.unitMappings);
  return mappings.flatMap((mapping, index) => {
    if (!isCanonicalPriceMapping(mapping)) return [];
    const moneySide = isMoneyUnit(mapping.b.unit) ? "b" : "a";
    return [
      {
        field: `unitMappings.${index}.${moneySide}.unit`,
        message:
          "Use the Price per item field for the per-each price, not a conversion.",
        source: "client" as const,
      },
    ];
  });
};

type EditHooksMap = { [E in EditableEntity]?: EntityEditHooks<E> };

/**
 * The entities whose editing needs procedural logic: everything the
 * declaration cannot say. Every other entity's editor is generated from its
 * `model.intents`, controls and canonical schemas alone.
 */
export const editHooks: EditHooksMap = {
  product: {
    fields: {
      upc: { initial: productUpcInitial },
      isbn: { initial: productIsbnInitial },
      unitMappings: { initial: productUnitMappingsInitial },
      externalIds: { initial: productExternalIdsInitial },
      labelNutrition: { validate: productLabelNutritionValidate },
    },
    create: {
      capture: {
        buildData: productBuildData,
        validate: productUnitMappingsValidate,
      },
      full: {
        buildData: productBuildData,
        validate: productUnitMappingsValidate,
      },
    },
    update: {
      full: {
        buildData: productBuildData,
        validate: productUnitMappingsValidate,
      },
    },
  },
  location: {
    fields: {
      // `collections` has no model field (editor-only, folded into `tags` at
      // submit) — seed edit mode from the record's own `tags`, since the
      // generic `initial` lookup has no `collections` key to read.
      collections: {
        initial: ({ record }) =>
          record
            ? collectionSlugsFromTags(
                z.array(z.string()).catch([]).parse(record.tags),
              )
            : [],
      },
    },
    create: {
      capture: { buildData: locationBuildData },
      full: { buildData: locationBuildData },
    },
    update: { full: { buildData: locationBuildData } },
  },
  // `notes` is accepted by the canonical task inputs but is not a scalar
  // model field (see `editorFields` in the declaration) — no field model
  // entry to derive a default from, so this stays explicit.
  task: { fields: { notes: "nullableText" } },
  expense: {
    create: {
      capture: {
        validate: validateExpenseDate,
        // `lineKind`'s `"auto"` is a client-only sentinel `buildData` strips
        // before validation. Trade stays unresolved until chosen or inherited.
        // `costType` genuinely depends on runtime context (disposition
        // capture vs. ordinary spend), not on anything the schema knows.
        defaults: (context) => ({
          lineKind: "auto",
          trade: null,
          costType: context.disposition ? "tools" : "materials",
        }),
        buildData: (patch) => ({
          ...patch,
          lineKind: patch.lineKind === "auto" ? undefined : patch.lineKind,
          productQuantity: patch.productId
            ? (patch.productQuantity ?? null)
            : null,
          url: null,
          notes: null,
        }),
      },
      full: { validate: validateExpenseDate },
    },
    update: {
      full: { validate: validateExpenseDate },
      cost: { validate: validateExpenseDate },
      date: { validate: validateExpenseDate },
      planned: {
        access: ({ surface, record }) =>
          surface === "calendar" && valueFor(record, "future") !== true
            ? readOnly("Recorded expenses stay read-only in the calendar.")
            : editable,
        validate: validateExpenseDate,
      },
      // "Mark purchased" — the date default is re-evaluated per session
      // (not a module-level constant) so a dialog left open overnight still
      // seeds today. `future: false` is unconditional: the whole point is a
      // no-touch "same-day settling" submit, which is why `changed` above
      // reads the post-`buildData` patch instead of the raw dirty fields.
      settle: {
        defaults: () => ({ date: householdLocalDate() }),
        validate: validateExpenseDate,
        buildData: (patch) => ({ ...patch, future: false }),
      },
    },
  },
  financialAccount: {
    create: {
      // `kind`, `issuer`, `network`, `institution`, `accountType`,
      // `provider`, and `last4` are editor-only fields that flatten into the
      // stored `identity` discriminant (and `last4` into the primary
      // `cardNumbers` entry) at submit time (see `financialAccountCreateData`
      // below) — none of them has a model field or generated schema to derive
      // a default from.
      capture: {
        defaults: {
          name: "",
          kind: "credit_card",
          issuer: "",
          network: "",
          institution: "",
          accountType: "checking",
          provider: "",
          providerVendorId: null,
          last4: "",
          provisional: false,
          sourceAliases: [],
          notes: null,
        },
        buildData: financialAccountCreateData,
      },
      full: {
        // The full create still collects the whole identity discriminant.
        fields: fieldsFor("financialAccount", "capture"),
        defaults: {
          provisional: false,
          providerVendorId: null,
          sourceAliases: [],
          notes: null,
        },
        buildData: financialAccountCreateData,
      },
    },
    update: {
      full: {
        buildData: (patch) => {
          if (!("sourceAliases" in patch)) return patch;
          return {
            ...patch,
            sourceAliases: normalizeSourceAliases(patch.sourceAliases),
          };
        },
      },
    },
  },
  financialTransaction: {
    // `purchaseId`, `transactionDate`, `merchant`, … are editor blanks
    // normalized by `normalizeFinancialTransaction`'s trim-to-null branch; the
    // canonical schema reports a zero amount and a posted transaction without
    // a posted date.
    create: {
      capture: {
        defaults: { sourceRefs: [] },
        buildData: normalizeFinancialTransaction,
      },
      full: {
        defaults: { sourceRefs: [] },
        buildData: normalizeFinancialTransaction,
      },
    },
    update: { full: { buildData: normalizeFinancialTransaction } },
  },
};

const isEditableEntity = (entity: Entity): entity is EditableEntity =>
  Object.hasOwn(generatedEntityEditIntents, entity);
const editableEntities = entityKeys.filter(isEditableEntity);

// SAFETY: `editableEntities` is the declared-intents roster, which the
// `EditableEntity` type is asserted to match (types.ts); each entry is built
// for its own entity key, so the per-key correlation the loop erases holds.
const generatedRegistry = Object.fromEntries(
  editableEntities.map((entity) => [
    entity,
    buildEntityDefinition(entity, editHooks[entity]),
  ]),
) as EntityEditRegistry;

/**
 * One definition per standard editable entity, generated from its declared
 * `model.intents` plus its `editHooks` entry when it has one.
 */
export const entityEditRegistry: EntityEditRegistry = generatedRegistry;
