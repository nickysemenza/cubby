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

const editable: EntityEditAccess = { mode: "editable" };

const readOnly = (reason: string): EntityEditAccess => ({
  mode: "read-only",
  reason,
});

const editValueSchema = z.union([z.json(), z.date(), z.undefined()]);
const valueFor = (record: EntityEditRecord | undefined, id: string) => {
  const candidate = Object.entries(record ?? {}).find(
    ([key]) => key === id,
  )?.[1];
  return editValueSchema.parse(candidate);
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

/**
 * The authoring handle, already bound to one entity. It is callable for the
 * ordinary field case and carries the shorthands, so an entity names itself
 * exactly once — as its key in the registry literal.
 *
 * Shorthands may not be called `name`, `length`, or `prototype`: the builder is
 * a function object, and those own properties are not writable.
 */
interface EntityEditBuilder<E extends EditableEntity> {
  (id: string, options?: FieldOptions<E>): EditField<E>;
  /** The required, trimmed `name` field shared by every named entity. */
  trimmedName(): EditField<E>;
  /** Text that stores `null` rather than an empty string. */
  nullableText(id: string): EditField<E>;
  /** Borrow another semantic intent's field list. */
  fieldsFor(semanticIntent: string): readonly string[];
}

const builderFor = <E extends EditableEntity>(
  entity: E,
): EntityEditBuilder<E> => {
  const makeField = (id: string, options?: FieldOptions<E>): EditField<E> => ({
    entity,
    id,
    access: options?.access ?? (() => editable),
    initial: ({ record, context }) =>
      valueFor(record, id) ??
      (id === "parentProjectId" ? context.parentProjectId : undefined) ??
      null,
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

  return Object.assign(makeField, {
    trimmedName: () =>
      makeField("name", {
        required: true,
        normalize: (value) => {
          const parsed = z.string().safeParse(value);
          return parsed.success ? parsed.data.trim() : value;
        },
      }),
    nullableText: (id: string) =>
      makeField(id, {
        normalize: (value) => {
          const parsed = z.string().safeParse(value);
          return parsed.success ? parsed.data.trim() || null : value;
        },
      }),
    fieldsFor: (semanticIntent: string) => fieldsFor(entity, semanticIntent),
  });
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
  if (body.create) {
    operations.create = operationDefinition(entity, "create", body.create);
  }
  if (body.update) {
    operations.update = operationDefinition(entity, "update", body.update);
  }
  return {
    entity,
    fields: body.fields,
    operations,
  };
};

type EntityEditBuilders = {
  readonly [E in EditableEntity]: (
    f: EntityEditBuilder<E>,
  ) => EntityEditBody<E>;
};

/**
 * Completeness and per-entity correlation are declaration-site errors: the
 * mapped parameter demands every editable entity and hands each builder an `f`
 * bound to its own key, so a definition cannot name a different entity.
 */
const defineEntityEdits = (
  builders: EntityEditBuilders,
): EntityEditRegistry => ({
  product: buildDefinition("product", builders.product),
  ingredient: buildDefinition("ingredient", builders.ingredient),
  inventory: buildDefinition("inventory", builders.inventory),
  location: buildDefinition("location", builders.location),
  recipe: buildDefinition("recipe", builders.recipe),
  meal: buildDefinition("meal", builders.meal),
  project: buildDefinition("project", builders.project),
  task: buildDefinition("task", builders.task),
  expense: buildDefinition("expense", builders.expense),
  vendor: buildDefinition("vendor", builders.vendor),
  purchase: buildDefinition("purchase", builders.purchase),
  financialAccount: buildDefinition(
    "financialAccount",
    builders.financialAccount,
  ),
  financialTransaction: buildDefinition(
    "financialTransaction",
    builders.financialTransaction,
  ),
  wish: buildDefinition("wish", builders.wish),
});

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

/**
 * Semantic capabilities, rather than presentation surfaces, choose editable
 * fragments. A Calendar and a detail page can therefore share `schedule`
 * without sharing a form shell; a cell has no power to widen its patch.
 */
const semanticFields = {
  product: {
    capture: ["name", "manufacturer"],
    full: [
      "name",
      "aliases",
      "manufacturer",
      "model",
      "category",
      "ingredientId",
      "upc",
      "fdc_id",
      "price",
      "stockTracked",
      "unitMappings",
      "notes",
    ],
    identity: ["name", "aliases", "manufacturer", "model", "category"],
    price: ["price"],
    stock: ["stockTracked"],
  },
  ingredient: {
    capture: ["name"],
    full: ["name", "aliases", "naKinds"],
    identity: ["name", "aliases"],
  },
  inventory: {
    capture: ["productId", "locationId", "amount", "placement"],
    full: ["amount", "productId", "locationId", "placement"],
    amount: ["amount"],
    product: ["productId"],
    location: ["locationId"],
    placement: ["placement"],
  },
  location: {
    capture: ["name", "type", "parentId"],
    full: ["name", "aliases", "type", "productId", "parentId"],
    identity: ["name", "aliases", "type", "productId"],
    parent: ["parentId"],
  },
  recipe: {
    capture: ["name"],
    full: ["name", "cookbookId", "tags", "notes", "sections"],
    identity: ["name", "cookbookId", "tags"],
  },
  meal: {
    capture: ["date", "name", "mealType", "mealKind"],
    full: ["date", "name", "mealType", "mealKind", "sortOrder"],
    calendar: ["date", "name", "mealType", "mealKind"],
  },
  project: {
    capture: [
      "name",
      "status",
      "kind",
      "costEstimate",
      "parentProjectId",
      "startDate",
    ],
    full: [
      "name",
      "icon",
      "status",
      "kind",
      "parentProjectId",
      "startDate",
      "endDate",
      "costEstimate",
      "locations",
      "googleDriveFolderUrl",
      "notionPageUrl",
      "blockedByIds",
      "notes",
    ],
    status: ["status"],
    kind: ["kind"],
    dates: ["startDate", "endDate"],
    parent: ["parentProjectId"],
  },
  task: {
    capture: [
      "name",
      "status",
      "projectId",
      "subjectProductId",
      "trade",
      "dueDate",
    ],
    full: [
      "name",
      "status",
      "projectId",
      "subjectProductId",
      "trade",
      "dueDate",
      "dueEndDate",
      "notes",
    ],
    schedule: ["name", "status", "dueDate", "dueEndDate"],
    status: ["status"],
    project: ["projectId"],
    subject: ["subjectProductId"],
  },
  expense: {
    capture: [
      "name",
      "lineKind",
      "cost",
      "date",
      "future",
      "projectId",
      "productId",
      "productQuantity",
      "vendor",
      "orderId",
      "trade",
      "costType",
    ],
    full: [
      "name",
      "lineKind",
      "lineBasis",
      "cost",
      "date",
      "future",
      "projectId",
      "productId",
      "productQuantity",
      "vendor",
      "orderId",
      "trade",
      "costType",
      "url",
      "notes",
    ],
    planned: ["name", "cost", "date"],
    cost: ["cost"],
    date: ["date"],
    project: ["projectId"],
    product: ["productId"],
  },
  vendor: {
    capture: ["name", "website", "notes"],
    full: ["name", "website", "orderUrlTemplate", "notes"],
    identity: ["name"],
  },
  purchase: {
    capture: [
      "vendorId",
      "date",
      "orderId",
      "displayLabel",
      "statedTotal",
      "notes",
    ],
    full: [
      "vendorId",
      "date",
      "orderId",
      "displayLabel",
      "statedTotal",
      "notes",
    ],
    vendor: ["vendorId"],
    identity: ["date", "orderId", "notes"],
  },
  financialAccount: {
    capture: [
      "name",
      "kind",
      "issuer",
      "network",
      "institution",
      "accountType",
      "provider",
      "last4",
      "provisional",
      "sourceAliases",
      "notes",
    ],
    full: ["name", "provisional", "sourceAliases", "notes"],
    identity: ["name", "provisional", "sourceAliases", "notes"],
  },
  financialTransaction: {
    capture: [
      "accountId",
      "purchaseId",
      "kind",
      "status",
      "amount",
      "transactionDate",
      "postedDate",
      "merchant",
      "rawDescription",
      "sourceCategory",
      "sourceRefs",
      "notes",
    ],
    full: [
      "accountId",
      "purchaseId",
      "kind",
      "status",
      "amount",
      "transactionDate",
      "postedDate",
      "merchant",
      "rawDescription",
      "sourceCategory",
      "sourceRefs",
      "notes",
    ],
    settlement: [
      "accountId",
      "purchaseId",
      "kind",
      "status",
      "amount",
      "transactionDate",
      "postedDate",
    ],
  },
  wish: {
    capture: ["name"],
    full: ["name", "notes", "candidateProductIds", "acquired"],
    identity: ["name", "notes", "candidateProductIds"],
    acquisition: ["acquired"],
  },
} satisfies Record<EditableEntity, Record<string, readonly string[]>>;

const fieldsFor = (entity: EditableEntity, semanticIntent: string) =>
  Object.entries(semanticFields[entity]).find(
    ([intent]) => intent === semanticIntent,
  )?.[1] ?? [];

/**
 * The data-only registry of Cubby's standard entity editing semantics.
 *
 * These are field fragments and commands, not form components: desktop pages,
 * dialogs, calendar sheets, and cells stay adapters at their own seams.
 */
export const entityEditRegistry = defineEntityEdits({
  product: (f) => ({
    fields: [
      f.trimmedName(),
      f("aliases"),
      f("manufacturer", { required: true }),
      f("model"),
      f("category"),
      f("ingredientId"),
      f("upc"),
      f("fdc_id"),
      f("price"),
      f("stockTracked"),
      f("unitMappings"),
      f.nullableText("notes"),
    ],
    create: ["capture", "full"],
    update: ["full", "identity", "price", "stock"],
  }),
  ingredient: (f) => ({
    fields: [f.trimmedName(), f("aliases"), f("naKinds")],
    create: ["capture", "full"],
    update: ["full", "identity"],
  }),
  inventory: (f) => ({
    fields: [f("amount"), f("productId"), f("locationId"), f("placement")],
    create: ["capture", "full"],
    update: ["full", "amount", "product", "location", "placement"],
  }),
  location: (f) => ({
    fields: [
      f.trimmedName(),
      f("aliases"),
      f("type"),
      f("productId"),
      f("parentId"),
    ],
    create: ["capture", "full"],
    update: ["full", "identity", "parent"],
  }),
  recipe: (f) => ({
    fields: [
      f.trimmedName(),
      f("cookbookId"),
      f("tags"),
      f.nullableText("notes"),
      f("sections"),
    ],
    create: ["capture", "full"],
    update: ["full", "identity"],
  }),
  meal: (f) => ({
    fields: [
      f("date", { required: true }),
      f.nullableText("name"),
      f("mealType"),
      f("mealKind"),
      f("sortOrder"),
    ],
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
    update: ["full", "calendar"],
  }),
  project: (f) => ({
    fields: [
      f.trimmedName(),
      f.nullableText("icon"),
      f("status"),
      f("kind"),
      f("parentProjectId"),
      f("startDate"),
      f("endDate"),
      f("costEstimate"),
      f("locations"),
      f.nullableText("googleDriveFolderUrl"),
      f.nullableText("notionPageUrl"),
      f("blockedByIds"),
      f.nullableText("notes"),
    ],
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
    update: ["full", "status", "kind", "dates", "parent"],
  }),
  task: (f) => ({
    fields: [
      f.trimmedName(),
      f("status"),
      f("projectId"),
      f("subjectProductId"),
      f("trade"),
      f("dueDate"),
      f("dueEndDate", {
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
      }),
      f.nullableText("notes"),
    ],
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
  }),
  expense: (f) => ({
    fields: [
      f.trimmedName(),
      f("lineKind"),
      f("cost"),
      f("date"),
      f("future"),
      f("projectId"),
      f("productId"),
      f("productQuantity"),
      f("vendor"),
      f("orderId"),
      f("trade"),
      f("costType"),
      f.nullableText("url"),
      f.nullableText("notes"),
      f("lineBasis"),
    ],
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
  }),
  vendor: (f) => ({
    fields: [
      f.trimmedName(),
      f.nullableText("website"),
      f.nullableText("orderUrlTemplate"),
      f.nullableText("notes"),
    ],
    create: {
      capture: { defaults: { name: "", website: null, notes: null } },
      full: { defaults: { name: "", website: null, notes: null } },
    },
    update: ["full", "identity"],
  }),
  purchase: (f) => ({
    fields: [
      f("vendorId", { required: true }),
      f("date", { required: true }),
      f.nullableText("orderId"),
      f.nullableText("displayLabel"),
      f("statedTotal"),
      f.nullableText("notes"),
    ],
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
    update: ["full", "vendor", "identity"],
  }),
  financialAccount: (f) => ({
    fields: [
      f.trimmedName(),
      f("kind"),
      f("issuer"),
      f("network"),
      f("institution"),
      f("accountType"),
      f("provider"),
      f("last4"),
      f("provisional"),
      f("sourceAliases"),
      f.nullableText("notes"),
    ],
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
  }),
  financialTransaction: (f) => ({
    fields: [
      f("accountId", { required: true }),
      f("purchaseId"),
      f("kind"),
      f("status"),
      f("amount", {
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
      }),
      f("transactionDate"),
      f("postedDate", {
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
      }),
      f.nullableText("merchant"),
      f.nullableText("rawDescription"),
      f.nullableText("sourceCategory"),
      f("sourceRefs"),
      f.nullableText("notes"),
    ],
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
  }),
  wish: (f) => ({
    fields: [
      f.trimmedName(),
      f.nullableText("notes"),
      f("candidateProductIds"),
      f("acquired"),
    ],
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
  }),
});
