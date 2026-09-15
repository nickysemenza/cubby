import { generatedEntityEditIntents } from "@cubby/schemas/entity-edit-intents";
import {
  entityFieldModels,
  type EntityFieldModel,
} from "@cubby/schemas/entity-fields";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
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
}

interface IntentOptions<E extends EditableEntity> {
  /** Defaults to the entity's semantic field list under the same intent name. */
  fields?: readonly string[];
  access?: EditIntent<E>["access"];
  validate?: EditIntent<E>["validate"];
  defaults?: EditIntent<E>["defaults"];
  acceptsSeed?: boolean;
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
 * field trims and collapses blank to `null`; a required non-text field is
 * simply required. Returns `undefined` when none of those apply — the field
 * keeps `makeField`'s own defaults unless an explicit override says
 * otherwise. `fieldsFrom`'s `overrides` argument still wins over this.
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
  if (field.requiredOnCreate) return { required: true };
  return undefined;
};

const builderFor = <E extends EditableEntity>(
  entity: E,
): EntityEditBuilder<E> => {
  const makeField = (id: string, options?: FieldOptions<E>): EditField<E> => ({
    entity,
    id,
    access: options?.access ?? (() => editable),
    // Every gallery entity's `pendingImageIds` is array-valued and `readKey:
    // null` (never populated from a record), so its one true default is an
    // empty array — not the generic text field's `null` — for every entity
    // that declares it, with no per-entity literal required.
    initial: ({ record, context }) =>
      id === "pendingImageIds"
        ? []
        : (valueFor(record, id) ??
          (id === "parentProjectId" ? context.parentProjectId : undefined) ??
          null),
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
    toPatch: ({ value, record }) =>
      changed(record, id, value) ? { [id]: value } : undefined,
  });

  const fieldModelByKey = new Map(
    entityFieldModels[entity].fields.map((field) => [field.key, field]),
  );

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
  acceptsSeed: options.acceptsSeed,
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
    fields: f.fieldsFrom(["full"]),
  })),
  planting: buildDefinition("planting", (f) => ({
    // `status` and `locationId` are lifecycle/location state — corrected only
    // through the Start/Move/Split/Finish actions, never a plain field edit,
    // so an update-surface edit leaves both read-only.
    fields: f.fieldsFrom(["capture", "full"], {
      status: {
        access: ({ operation }) =>
          operation === "update"
            ? readOnly(
                "Use Start, Move, or Finish to change lifecycle or location.",
              )
            : editable,
      },
      locationId: {
        access: ({ operation }) =>
          operation === "update"
            ? readOnly(
                "Use Start, Move, or Finish to change lifecycle or location.",
              )
            : editable,
      },
    }),
    create: {
      capture: {
        defaults: { ingredientId: "", locationId: null, status: "planned" },
      },
      full: { defaults: { ingredientId: "", status: "planned" } },
    },
    update: { full: { acceptsSeed: true } },
  })),
  gardenEntry: buildDefinition("gardenEntry", (f) => ({
    fields: f.fieldsFrom(["capture", "full"]),
    create: {
      capture: {
        defaults: {
          locationId: "",
          observedOn: householdLocalDate(),
          note: null,
        },
      },
      full: {
        defaults: {
          locationId: "",
          plantingId: null,
          kind: "observation",
          observedOn: householdLocalDate(),
          note: null,
          harvestAmount: null,
        },
      },
    },
    update: { full: { acceptsSeed: true } },
  })),
  recipe: buildDefinition("recipe", (f) => ({
    fields: f.fieldsFrom(["full"]),
  })),
  meal: buildDefinition("meal", (f) => ({
    fields: f.fieldsFrom(["full"]),
    create: {
      capture: {
        defaults: () => ({
          date: householdLocalDate(),
          name: null,
          mealType: null,
          mealKind: "cooked",
        }),
      },
      full: {
        defaults: {
          date: null,
          name: null,
          mealType: null,
          mealKind: "cooked",
          sortOrder: null,
        },
      },
    },
  })),
  project: buildDefinition("project", (f) => ({
    fields: f.fieldsFrom(["full"]),
    create: {
      capture: {
        defaults: {
          name: "",
          status: "planning",
          kind: null,
          costEstimate: null,
          parentProjectId: null,
          startDate: null,
        },
      },
      full: { defaults: { status: "planning", kind: null } },
    },
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
        defaults: {
          name: "",
          status: "not_started",
          projectId: null,
          subjectProductId: null,
          trade: null,
          dueDate: null,
        },
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
      full: { defaults: { status: "not_started" } },
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
        defaults: (context) => ({
          name: "",
          lineKind: "auto",
          cost: null,
          date: householdLocalDate(),
          future: false,
          projectId: null,
          productId: null,
          productQuantity: null,
          vendor: "",
          orderId: "",
          costType: context.disposition ? "tools" : "materials",
          trade: "other",
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
      full: { defaults: { future: false } },
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
  purchase: buildDefinition("purchase", (f) => ({
    fields: f.fieldsFrom(["full"]),
    create: {
      capture: {
        defaults: () => ({
          vendorId: "",
          orderId: "",
          displayLabel: "",
          date: householdLocalDate(),
          statedTotal: null,
          notes: "",
        }),
        buildData: (patch) => ({
          ...patch,
          vendorId: parseShortcodeFor("vendor", patch.vendorId),
        }),
      },
      full: { defaults: { statedTotal: null } },
    },
  })),
  financialAccount: buildDefinition("financialAccount", (f) => ({
    fields: f.fieldsFrom(["capture", "full"]),
    create: {
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
        acceptsSeed: true,
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
      full: { acceptsSeed: true, buildData: normalizeFinancialTransaction },
      settlement: {},
    },
  })),
  wish: buildDefinition("wish", (f) => ({
    fields: f.fieldsFrom(["full"]),
    create: {
      // Capture is the full form here: a wish has nothing worth deferring.
      capture: {
        fields: f.fieldsFor("full"),
        defaults: { name: "", notes: null, candidateProductIds: [] },
      },
      full: { defaults: { name: "", notes: null, candidateProductIds: [] } },
    },
    update: {
      full: { acceptsSeed: true },
      identity: {},
      acquisition: {},
    },
  })),
  // No editor is rendered for these yet — create/update stay on MCP — but the
  // builders must exist for the registry to be exhaustive over EditableEntity.
  ledgerParty: buildDefinition("ledgerParty", (f) => ({
    fields: f.fieldsFrom(["full"]),
    create: {
      full: { defaults: { name: "", kind: "member", notes: null } },
    },
    update: { full: { acceptsSeed: true } },
  })),
  ledgerTransfer: buildDefinition("ledgerTransfer", (f) => ({
    fields: f.fieldsFrom(["full"]),
    create: {
      full: {
        defaults: {
          fromPartyId: "",
          toPartyId: "",
          amount: 0,
          date: "",
          notes: null,
        },
      },
    },
    update: { full: { acceptsSeed: true } },
  })),
};
