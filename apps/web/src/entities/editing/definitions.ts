import type { CompiledEntityPresentation } from "@cubby/schemas/entity-definitions/definition";
import { generatedEntityEditIntents } from "@cubby/schemas/entity-edit-intents";
import { entityFieldSchemaMaps } from "@cubby/schemas/entity-field-schema-maps";
import {
  entityFieldModels,
  type EntityFieldModel,
} from "@cubby/schemas/entity-fields";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  collectionSlugsFromTags,
  collectionTagFromSlug,
  normalizeCollectionSlug,
} from "@cubby/shared/collection-tag";
import { isEqual } from "es-toolkit";
import { z } from "zod";

import { householdLocalDate } from "~/lib/household-date";

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
import { entityEditValueSchema } from "./value-schema";

const editable: EntityEditAccess = { mode: "editable" };

const readOnly = (reason: string): EntityEditAccess => ({
  mode: "read-only",
  reason,
});

const valueFor = (record: EntityEditRecord | undefined, id: string) => {
  const candidate = Object.entries(record ?? {}).find(
    ([key]) => key === id,
  )?.[1];
  return entityEditValueSchema.parse(candidate);
};

const changed = (
  record: EntityEditRecord | undefined,
  id: string,
  value: EntityEditValue,
) => !record || !isEqual(valueFor(record, id), value);

/**
 * The gallery pseudo-fields have no stored twin on the record: `images` is
 * the read shape, and `pendingImageIds`/`removeImageIds`/`imageOrder` are
 * write-only instructions. Their baseline is derived from `images` (order)
 * or is the empty list, and a patch carries them only when they instruct
 * something — an untouched gallery sends none of them.
 */
const IMAGE_LIST_FIELDS = new Set(["pendingImageIds", "removeImageIds"]);
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
   * and unfolded back into a list here for edit-mode seeding).
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

/**
 * What one entity declares. Operation declarations are intentionally uniform:
 * the registry adds the semantic intent to the command at the execution seam,
 * so a definition owns only field selection and context-sensitive access.
 */
interface EntityEditBody<E extends EditableEntity> {
  fields: readonly EditField<E>[];
  create?: IntentDeclaration<E>;
  update?: IntentDeclaration<E>;
  delete?: EntityEditAccess;
}

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
 * order: the manifest's `control.initial` marker (today's household date is
 * the only one so far); the generated create schema's own Zod default (Zod 4
 * exposes it as a plain `def.defaultValue` property on a `ZodDefault`
 * instance — proven in `definitions.unit.test.ts`); else a value implied by
 * the field's kind. Never consulted for update — an existing record's own
 * value always wins there, in `makeField`'s `initial` below.
 */
const genericCreateDefault = <E extends EditableEntity>(
  entity: E,
  field: EntityFieldModel["fields"][number],
): EntityEditValue => {
  if (field.control?.initial === "today") return householdLocalDate();
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

  const makeField = (id: string, options?: FieldOptions<E>): EditField<E> => ({
    entity,
    id,
    access: options?.access ?? declaredAccess(entity, id),
    initial: (input) => {
      if (options?.initial) return options.initial(input);
      const { operation, record, context } = input;
      if (IMAGE_LIST_FIELDS.has(id)) return [];
      if (id === "imageOrder")
        return operation === "update" ? recordImageIds(record) : [];
      const existing = valueFor(record, id);
      if (existing !== undefined) return existing;
      if (id === "parentProjectId" && context.parentProjectId !== undefined) {
        return context.parentProjectId;
      }
      if (operation !== "create") return null;
      // `mealKind`'s storage default is a DB literal, not a Zod `.default()`
      // (the create schema stays `.optional()` so a caller may omit it and
      // let the column default apply) — the one create-time constant with no
      // schema-derivable value to fall back on.
      if (id === "mealKind" && entity === "meal") return "cooked";
      const field = fieldModelByKey.get(id);
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
    toPatch: ({ value, record }) => {
      if (IMAGE_LIST_FIELDS.has(id)) {
        const ids = imageIdList(value);
        return ids && ids.length > 0 ? { [id]: ids } : undefined;
      }
      if (id === "imageOrder") {
        const ids = imageIdList(value);
        return ids && record && !isEqual(ids, recordImageIds(record))
          ? { imageOrder: ids }
          : undefined;
      }
      return changed(record, id, value) ? { [id]: value } : undefined;
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

const makeIntent = <E extends EditableEntity>(
  entity: E,
  operation: EntityEditOperation,
  semanticIntent: string,
  options: IntentOptions<E>,
): EditIntent<E> => ({
  fields: options.fields ?? fieldsFor(entity, semanticIntent),
  access: options.access ?? (() => editable),
  validate: options.validate,
  defaults: options.defaults,
  build: ({ record, patch, context }) => {
    const keys = Object.keys(patch);
    const data = options.buildData ? options.buildData(patch, context) : patch;
    if (operation === "create") {
      return {
        ok: true,
        changed: true,
        command: {
          entity,
          operation,
          intent: semanticIntent,
          data: parseEntityEditCreateInput(entity, data),
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
      return {
        ok: true,
        changed: keys.length > 0,
        command: {
          entity,
          operation,
          intent: semanticIntent,
          id: record.id,
          data: parseEntityEditUpdateInput(entity, data),
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
});

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

const buildDefinition = <E extends EditableEntity>(
  entity: E,
  build: (f: EntityEditBuilder<E>) => EntityEditBody<E>,
): EntityEditDefinition<E, EntityEditRecord> => {
  const body = build(builderFor(entity));
  const operations: EntityEditDefinition<E, EntityEditRecord>["operations"] = {
    delete: {
      defaultIntent: "delete",
      intents: {
        delete: makeIntent(entity, "delete", "delete", {
          fields: [],
          access: () => body.delete ?? editable,
        }),
      },
    },
  };
  // Operation intent lists default to the declaration; a registry entry only
  // spells them out when an intent needs options (defaults, seeds, builders).
  const declared = generatedEntityEditIntents[entity];
  operations.create = operationDefinition(
    entity,
    "create",
    body.create ?? declared.create,
  );
  operations.update = operationDefinition(
    entity,
    "update",
    body.update ?? declared.update,
  );
  return {
    entity,
    fields: body.fields,
    operations,
  };
};

const requiredDate =
  (
    fieldId: "date" | "dueDate",
  ): NonNullable<
    EntityEditIntentDefinition<EditableEntity, EntityEditRecord>["validate"]
  > =>
  ({ values }) =>
    values[fieldId]
      ? noIssues()
      : [
          {
            field: fieldId,
            message: "Date is required",
            source: "client",
          },
        ];

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
  const last4 = String(patch.last4 ?? "").trim() || null;
  let identity: EntityEditValue;
  if (kind === "credit_card") {
    identity = {
      kind,
      issuer: String(patch.issuer ?? "").trim() || null,
      network: String(patch.network ?? "").trim() || null,
      last4,
    };
  } else if (kind === "bank_account") {
    identity = {
      kind,
      institution: String(patch.institution ?? "").trim() || null,
      accountType: String(patch.accountType ?? "checking"),
      last4,
    };
  } else if (kind === "stored_value") {
    identity = {
      kind,
      provider: String(patch.provider ?? "").trim(),
      last4,
    };
  } else if (kind === "other") {
    identity = {
      kind,
      institution: String(patch.institution ?? "").trim() || null,
      last4,
    };
  } else {
    identity = { kind: "cash" };
  }
  return identity;
};

/** Creates flatten the identity discriminant; updates patch it in place. */
const financialAccountCreateData = (
  patch: EntityEditValueBag,
): EntityEditValueBag => ({
  name: patch.name,
  provisional: patch.provisional,
  identity: financialAccountIdentity(patch),
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

const vendorCreateDefaults = { name: "", website: null, notes: null } as const;

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
 * A fresh product link always clears `type` (a linked location's form factor
 * comes from the SKU); `collections` folds into the stored `tags` column and
 * never reaches the create/update contract on its own.
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
 * The data-only registry of Cubby's standard entity editing semantics.
 *
 * These are field fragments and commands, not form components: desktop pages,
 * dialogs, calendar sheets, and cells stay adapters at their own seams.
 *
 * Most entities need only their field roster — defaults, blank normalization,
 * and required-ness are all derived generically above from the manifest and
 * the generated create/update schemas. An entry keeps explicit `create`/
 * `update`/field overrides only for genuinely context-sensitive behaviour: a
 * validator that reads other field values, an access rule keyed by surface,
 * a value that folds several editor-only fields into one stored shape, or a
 * default that depends on runtime context (`context.disposition`) rather
 * than the declaration.
 */
export const entityEditRegistry: EntityEditRegistry = {
  product: buildDefinition("product", (f) => ({
    fields: f.fieldsFrom(["full"], {
      // The create schema allows omitting a manufacturer, but the form still
      // requires one — not derivable from `requiredOnCreate`.
      manufacturer: { required: true },
    }),
  })),
  ingredient: buildDefinition("ingredient", (f) => ({
    fields: f.fieldsFrom(["full"]),
  })),
  inventory: buildDefinition("inventory", (f) => ({
    fields: f.fieldsFrom(["full"]),
  })),
  location: buildDefinition("location", (f) => ({
    fields: f.fieldsFrom(["full"], {
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
    }),
    create: {
      capture: { defaults: { type: "room" }, buildData: locationBuildData },
      full: { defaults: { type: "room" }, buildData: locationBuildData },
    },
    update: {
      full: { buildData: locationBuildData },
    },
  })),
  planting: buildDefinition("planting", (f) => ({
    fields: f.fieldsFrom(["capture", "full"]),
    // Plantings are contextual records: the generic create preview should
    // expose crop, source, location, task, dates, and notes in one pass.
    // Keep the capture intent for relation-section launchers that still ask
    // for a compact form; full remains first so generic create defaults to it.
    create: { full: {}, capture: {} },
  })),
  gardenEntry: buildDefinition("gardenEntry", (f) => ({
    fields: f.fieldsFrom(["capture", "full"]),
    // A journal entry created from a planting is seeded by relation context,
    // but its full typed payload remains editable before the write.
    // Keep the capture intent for relation-section launchers that still ask
    // for a compact form; full remains first so generic create defaults to it.
    create: { full: {}, capture: {} },
  })),
  recipe: buildDefinition("recipe", (f) => ({
    fields: f.fieldsFrom(["full"]),
  })),
  meal: buildDefinition("meal", (f) => ({
    fields: f.fieldsFrom(["full"]),
  })),
  project: buildDefinition("project", (f) => ({
    fields: f.fieldsFrom(["full"]),
  })),
  task: buildDefinition("task", (f) => ({
    fields: f.fieldsFrom(["full"], {
      dueEndDate: {
        validate: ({ value, values }) => {
          const end = z.string().safeParse(value);
          const due = z.string().safeParse(values.dueDate);
          return end.success && due.success && end.data < due.data
            ? [
                {
                  field: "dueEndDate",
                  message: "End date must be on or after the due date.",
                  source: "client",
                },
              ]
            : noIssues();
        },
      },
      // `notes` is accepted by the canonical task inputs but is not a scalar
      // model field (see `editorFields` in the declaration) — no field model
      // entry to derive a default from, so this stays explicit.
      notes: "nullableText",
    }),
    create: {
      capture: {
        buildData: (patch) => ({
          ...patch,
          projectId: patch.projectId
            ? parseShortcodeFor("project", patch.projectId)
            : null,
          subjectProductId: patch.subjectProductId
            ? parseShortcodeFor("product", patch.subjectProductId)
            : null,
          trade: patch.trade ?? "other",
          dueEndDate: null,
        }),
      },
      full: {},
    },
    update: {
      full: {},
      status: {},
      project: {},
      subject: {},
      schedule: { validate: requiredDate("dueDate") },
    },
  })),
  expense: buildDefinition("expense", (f) => ({
    fields: f.fieldsFrom(["full"], {
      // The create schema requires a date (`requiredOnCreate` would derive
      // `{ required: true }`), but the blanket field-level check would fire
      // for every intent — the `planned` update intent below already has its
      // own conditional, better-worded `requiredDate("date")` check.
      date: { required: false },
    }),
    create: {
      capture: {
        // `lineKind`'s `"auto"` is a client-only sentinel `buildData` strips
        // before validation, and `trade` has no schema default despite being
        // required on create — neither is derivable from the declaration.
        // `costType` genuinely depends on runtime context (disposition
        // capture vs. ordinary spend), not on anything the schema knows.
        defaults: (context) => ({
          lineKind: "auto",
          trade: "other",
          costType: context.disposition ? "tools" : "materials",
        }),
        buildData: (patch) => ({
          ...patch,
          lineKind: patch.lineKind === "auto" ? undefined : patch.lineKind,
          projectId: patch.projectId
            ? parseShortcodeFor("project", patch.projectId)
            : null,
          productId: patch.productId ?? null,
          productQuantity: patch.productId
            ? (patch.productQuantity ?? null)
            : null,
          vendor: z.string().safeParse(patch.vendor).success
            ? z.string().parse(patch.vendor).trim() || null
            : null,
          orderId: z.string().safeParse(patch.orderId).success
            ? z.string().parse(patch.orderId).trim() || null
            : null,
          url: null,
          notes: null,
        }),
      },
      full: {},
    },
    update: {
      full: {},
      cost: {},
      date: {},
      project: {},
      product: {},
      planned: {
        access: ({ surface, record }) =>
          surface === "calendar" && valueFor(record, "future") !== true
            ? readOnly("Recorded expenses stay read-only in the calendar.")
            : editable,
        validate: requiredDate("date"),
      },
    },
  })),
  vendor: buildDefinition("vendor", (f) => ({
    fields: f.fieldsFrom(["full"]),
    create: {
      capture: { defaults: vendorCreateDefaults },
      full: { defaults: vendorCreateDefaults },
    },
  })),
  vendorAccount: buildDefinition("vendorAccount", (f) => ({
    fields: f.fieldsFrom(["full"]),
  })),
  purchase: buildDefinition("purchase", (f) => ({
    fields: f.fieldsFrom(["full"]),
    create: {
      capture: {
        buildData: (patch) => ({
          ...patch,
          vendorId: parseShortcodeFor("vendor", patch.vendorId),
        }),
      },
      full: {},
    },
  })),
  financialAccount: buildDefinition("financialAccount", (f) => ({
    fields: f.fieldsFrom(["capture", "full"]),
    create: {
      // `kind`, `issuer`, `network`, `institution`, `accountType`,
      // `provider`, and `last4` are editor-only fields that flatten into the
      // stored `identity` discriminant at submit time (see
      // `financialAccountCreateData` below) — none of them has a model field
      // or generated schema to derive a default from.
      capture: {
        defaults: {
          name: "",
          kind: "credit_card",
          issuer: "",
          network: "",
          institution: "",
          accountType: "checking",
          provider: "",
          last4: "",
          provisional: false,
          sourceAliases: [],
          notes: null,
        },
        buildData: financialAccountCreateData,
      },
      full: {
        // The full create still collects the whole identity discriminant.
        fields: f.fieldsFor("capture"),
        defaults: { provisional: false, sourceAliases: [], notes: null },
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
      identity: {},
    },
  })),
  financialTransaction: buildDefinition("financialTransaction", (f) => ({
    fields: f.fieldsFrom(["capture", "full"], {
      amount: {
        // The create schema makes this required (`requiredOnCreate` would
        // derive `{ required: true }`), but the generic "This field is
        // required." message would pre-empt the specific one below for a
        // blank value — stay off the derived default and always run the
        // more useful validator.
        required: false,
        validate: ({ value }) => {
          const amount = z.number().finite().safeParse(value);
          return amount.success && amount.data !== 0
            ? noIssues()
            : [
                {
                  field: "amount",
                  message: "Amount must be a non-zero number.",
                  source: "client",
                },
              ];
        },
      },
      postedDate: {
        validate: ({ value, values }) =>
          values.status === "posted" && !value
            ? [
                {
                  field: "postedDate",
                  message: "Posted transactions require a posted date.",
                  source: "client",
                },
              ]
            : noIssues(),
      },
    }),
    create: {
      // Reference/date/enum fields here are editor blanks that would fail
      // required-field validation either way, but several (`purchaseId`,
      // `transactionDate`, `merchant`, …) are normalized by
      // `normalizeFinancialTransaction`'s trim-to-null branch rather than a
      // generic reference/kind default, so the explicit defaults stay next
      // to the `buildData` that consumes them.
      capture: {
        defaults: {
          accountId: "",
          purchaseId: "",
          kind: "purchase",
          status: "pending",
          amount: 0,
          transactionDate: "",
          postedDate: "",
          merchant: "",
          rawDescription: "",
          sourceCategory: "",
          sourceRefs: [],
          notes: "",
        },
        buildData: normalizeFinancialTransaction,
      },
      full: {
        defaults: { sourceRefs: [] },
        buildData: normalizeFinancialTransaction,
      },
    },
    update: {
      full: { buildData: normalizeFinancialTransaction },
      settlement: {},
    },
  })),
  wish: buildDefinition("wish", (f) => ({
    fields: f.fieldsFrom(["full"]),
    create: {
      // Capture is the full form here: a wish has nothing worth deferring.
      capture: { fields: f.fieldsFor("full") },
      full: {},
    },
    update: ["full", "identity", "acquisition"],
  })),
  // No editor is rendered for these yet — create/update stay on MCP — but the
  // builders must exist for the registry to be exhaustive over EditableEntity.
  ledgerParty: buildDefinition("ledgerParty", (f) => ({
    fields: f.fieldsFrom(["full"]),
  })),
  ledgerTransfer: buildDefinition("ledgerTransfer", (f) => ({
    fields: f.fieldsFrom(["full"]),
  })),
};
