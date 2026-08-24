import {
  unsafeProductShortcode,
  unsafeProjectShortcode,
  unsafeVendorShortcode,
} from "@cubby/schemas/identifiers";
import { isEqual } from "es-toolkit";
import { householdLocalDate } from "~/lib/household-date";
import { invalidatesFor } from "~/lib/query-keys";
import { defineEntityEditRegistry } from "./registry";
import type {
  EditableEntity,
  EntityEditAccess,
  EntityEditDefinition,
  EntityEditField,
  EntityEditIntentDefinition,
  EntityEditIssue,
  EntityEditOperation,
  EntityEditRecord,
} from "./types";

const editable: EntityEditAccess = { mode: "editable" };

const readOnly = (reason: string): EntityEditAccess => ({
  mode: "read-only",
  reason,
});

const valueFor = (record: EntityEditRecord | undefined, id: string) =>
  record && id in record
    ? (record as EntityEditRecord & Record<string, unknown>)[id]
    : undefined;

const changed = (
  record: EntityEditRecord | undefined,
  id: string,
  value: unknown,
) => !record || !isEqual(valueFor(record, id), value);

const noIssues = (): readonly EntityEditIssue[] => [];

const field = <E extends EditableEntity>(
  entity: E,
  id: string,
  options?: {
    required?: boolean;
    normalize?: (value: unknown) => unknown;
    access?: EntityEditField<
      EditableEntity,
      EntityEditRecord,
      unknown,
      object
    >["access"];
    validate?: EntityEditField<
      EditableEntity,
      EntityEditRecord,
      unknown,
      object
    >["validate"];
  },
): EntityEditField<E, EntityEditRecord, unknown, object> => ({
  entity,
  id,
  access: options?.access ?? (() => editable),
  initial: ({ record, context }) => valueFor(record, id) ?? context[id] ?? null,
  normalize: options?.normalize ?? ((value) => value),
  validate: (input) => {
    const { value } = input;
    if (
      options?.required &&
      (value == null || (typeof value === "string" && !value.trim()))
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

const trimmedName = <E extends EditableEntity>(entity: E) =>
  field(entity, "name", {
    required: true,
    normalize: (value) => (typeof value === "string" ? value.trim() : value),
  });

const nullableText = <E extends EditableEntity>(entity: E, id: string) =>
  field(entity, id, {
    normalize: (value) =>
      typeof value === "string" ? value.trim() || null : value,
  });

const intent = <E extends EditableEntity>(
  entity: E,
  operation: EntityEditOperation,
  semanticIntent: string,
  fields: readonly string[],
  access: (input: {
    surface:
      | "detail"
      | "create-page"
      | "quick-create"
      | "cell"
      | "preview"
      | "calendar";
    record?: EntityEditRecord;
    context: Readonly<Record<string, unknown>>;
  }) => EntityEditAccess = () => editable,
  validate?: EntityEditIntentDefinition<E, EntityEditRecord>["validate"],
  options?: {
    defaults?: EntityEditIntentDefinition<E, EntityEditRecord>["defaults"];
    acceptsSeed?: boolean;
    buildData?: (
      patch: Record<string, unknown>,
      context: Readonly<Record<string, unknown>>,
    ) => object;
  },
) => ({
  fields,
  access,
  validate,
  defaults: options?.defaults,
  acceptsSeed: options?.acceptsSeed,
  build: ({
    record,
    patch,
    context,
  }: {
    record?: EntityEditRecord;
    patch: object;
    context: Readonly<Record<string, unknown>>;
  }) => {
    const keys = Object.keys(patch);
    if (operation !== "create" && !record) {
      return {
        ok: false as const,
        issues: [
          {
            message: `${entity} ${operation} requires a record.`,
            source: "client" as const,
          },
        ],
      };
    }
    return {
      ok: true as const,
      changed: operation === "create" || keys.length > 0,
      command: {
        entity,
        operation,
        intent: semanticIntent,
        ...(record ? { id: record.id } : {}),
        data: options?.buildData
          ? options.buildData(patch as Record<string, unknown>, context)
          : patch,
      },
    };
  },
});

const createIntent = <E extends EditableEntity>(
  entity: E,
  semanticIntent: string,
  fields: readonly string[],
  options: NonNullable<Parameters<typeof intent<E>>[6]>,
) =>
  intent(
    entity,
    "create",
    semanticIntent,
    fields,
    undefined,
    undefined,
    options,
  );

/**
 * Operation declarations are intentionally uniform. The registry adds the
 * semantic intent to the command at the execution seam; definitions own the
 * field selection and any context-sensitive accessibility.
 */
const operations = <E extends EditableEntity>(
  entity: E,
  options?: {
    create?:
      | readonly string[]
      | Readonly<Record<string, ReturnType<typeof intent<E>>>>;
    update?: Readonly<Record<string, ReturnType<typeof intent<E>>>>;
    delete?: EntityEditAccess;
  },
) => ({
  ...(options?.create
    ? {
        create: {
          defaultIntent: Array.isArray(options.create)
            ? options.create[0]!
            : Object.keys(options.create)[0]!,
          intents: Array.isArray(options.create)
            ? Object.fromEntries(
                options.create.map((name) => [
                  name,
                  intent(entity, "create", name, fieldsFor(entity, name)),
                ]),
              )
            : options.create,
        },
      }
    : {}),
  ...(options?.update
    ? {
        update: {
          defaultIntent: Object.keys(options.update)[0]!,
          intents: options.update,
        },
      }
    : {}),
  delete: {
    defaultIntent: "delete",
    intents: {
      delete: intent(
        entity,
        "delete",
        "delete",
        [],
        () => options?.delete ?? editable,
      ),
    },
  },
});

const definition = <E extends EditableEntity>(
  entity: E,
  fields: readonly EntityEditField<E, EntityEditRecord, unknown, object>[],
  invalidationKeys: EntityEditDefinition<E>["invalidationKeys"],
  definitionOperations: EntityEditDefinition<E>["operations"],
): EntityEditDefinition<E> => ({
  entity,
  fields,
  invalidationKeys,
  operations: definitionOperations,
});

const standardUpdate = <E extends EditableEntity>(
  entity: E,
  names: readonly string[],
) =>
  Object.fromEntries(
    names.map((name) => [
      name,
      intent(entity, "update", name, fieldsFor(entity, name)),
    ]),
  ) as Record<string, ReturnType<typeof intent<E>>>;

const projectFields = [
  trimmedName("project"),
  nullableText("project", "icon"),
  field("project", "status"),
  field("project", "kind"),
  field("project", "parentProjectId"),
  field("project", "startDate"),
  field("project", "endDate"),
  field("project", "costEstimate"),
  field("project", "locations"),
  nullableText("project", "googleDriveFolderUrl"),
  nullableText("project", "notionPageUrl"),
  field("project", "blockedByIds"),
  nullableText("project", "notes"),
] as const;

const taskFields = [
  trimmedName("task"),
  field("task", "status"),
  field("task", "projectId"),
  field("task", "subjectProductId"),
  field("task", "trade"),
  field("task", "dueDate"),
  field("task", "dueEndDate", {
    validate: ({ value, values }) =>
      typeof value === "string" &&
      typeof values.dueDate === "string" &&
      value < values.dueDate
        ? [
            {
              field: "dueEndDate",
              message: "End date must be on or after the due date.",
              source: "client",
            },
          ]
        : noIssues(),
  }),
  nullableText("task", "notes"),
] as const;

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

const expenseFields = [
  trimmedName("expense"),
  field("expense", "lineKind"),
  field("expense", "cost"),
  field("expense", "date"),
  field("expense", "future"),
  field("expense", "projectId"),
  field("expense", "productId"),
  field("expense", "productQuantity"),
  field("expense", "vendor"),
  field("expense", "orderId"),
  field("expense", "trade"),
  field("expense", "costType"),
  nullableText("expense", "url"),
  nullableText("expense", "notes"),
] as const;

const financialAccountFields = [
  trimmedName("financialAccount"),
  field("financialAccount", "kind"),
  field("financialAccount", "issuer"),
  field("financialAccount", "network"),
  field("financialAccount", "institution"),
  field("financialAccount", "accountType"),
  field("financialAccount", "provider"),
  field("financialAccount", "last4"),
  field("financialAccount", "provisional"),
  field("financialAccount", "sourceAliases"),
  nullableText("financialAccount", "notes"),
] as const;

const normalizeSourceAliases = (value: unknown) =>
  Array.isArray(value)
    ? value
        .filter(
          (alias): alias is Record<string, unknown> =>
            Boolean(alias) && typeof alias === "object",
        )
        .map((alias) => ({
          source: String(alias.source ?? "").trim(),
          alias: String(alias.alias ?? "").trim(),
          externalAccountId:
            String(alias.externalAccountId ?? "").trim() || null,
        }))
        .filter((alias) => alias.source && alias.alias)
    : [];

const financialAccountIdentity = (patch: Record<string, unknown>) => {
  const kind = patch.kind;
  const last4 = String(patch.last4 ?? "").trim() || null;
  if (kind === "credit_card") {
    return {
      kind,
      issuer: String(patch.issuer ?? "").trim() || null,
      network: String(patch.network ?? "").trim() || null,
      last4,
    };
  }
  if (kind === "bank_account") {
    return {
      kind,
      institution: String(patch.institution ?? "").trim() || null,
      accountType: patch.accountType ?? "checking",
      last4,
    };
  }
  if (kind === "stored_value") {
    return {
      kind,
      provider: String(patch.provider ?? "").trim(),
      last4,
    };
  }
  if (kind === "other") {
    return {
      kind,
      institution: String(patch.institution ?? "").trim() || null,
      last4,
    };
  }
  return { kind: "cash" };
};

const normalizedNullableTextPatch = (
  patch: Record<string, unknown>,
  key: string,
) => (key in patch ? { [key]: String(patch[key] ?? "").trim() || null } : {});

const normalizeFinancialTransaction = (patch: Record<string, unknown>) => ({
  ...patch,
  ...normalizedNullableTextPatch(patch, "purchaseId"),
  ...normalizedNullableTextPatch(patch, "transactionDate"),
  ...normalizedNullableTextPatch(patch, "postedDate"),
  ...normalizedNullableTextPatch(patch, "merchant"),
  ...normalizedNullableTextPatch(patch, "rawDescription"),
  ...normalizedNullableTextPatch(patch, "sourceCategory"),
  ...normalizedNullableTextPatch(patch, "notes"),
  ...("sourceRefs" in patch
    ? {
        sourceRefs: Array.isArray(patch.sourceRefs)
          ? patch.sourceRefs
              .filter(
                (reference): reference is Record<string, unknown> =>
                  Boolean(reference) && typeof reference === "object",
              )
              .map((reference) => ({
                source: String(reference.source ?? "").trim(),
                externalId: String(reference.externalId ?? "").trim(),
              }))
              .filter((reference) => reference.source && reference.externalId)
          : [],
      }
    : {}),
});

/**
 * Semantic capabilities, rather than presentation surfaces, choose editable
 * fragments. A Calendar and a detail page can therefore share `schedule`
 * without sharing a form shell; a cell has no power to widen its patch.
 */
const semanticFields: Record<
  EditableEntity,
  Record<string, readonly string[]>
> = {
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
};

const fieldsFor = (entity: EditableEntity, semanticIntent: string) =>
  semanticFields[entity][semanticIntent] ?? [];

/**
 * The data-only registry of Cubby's standard entity editing semantics.
 *
 * These are field fragments and commands, not form components: desktop pages,
 * dialogs, calendar sheets, and cells stay adapters at their own seams.
 */
export const entityEditRegistry = defineEntityEditRegistry({
  product: definition(
    "product",
    [
      trimmedName("product"),
      field("product", "aliases"),
      field("product", "manufacturer", { required: true }),
      field("product", "model"),
      field("product", "category"),
      field("product", "ingredientId"),
      field("product", "upc"),
      field("product", "fdc_id"),
      field("product", "price"),
      field("product", "stockTracked"),
      field("product", "unitMappings"),
      nullableText("product", "notes"),
    ],
    invalidatesFor("product"),
    operations("product", {
      create: ["capture", "full"],
      update: standardUpdate("product", ["full", "identity", "price", "stock"]),
    }),
  ),
  ingredient: definition(
    "ingredient",
    [
      trimmedName("ingredient"),
      field("ingredient", "aliases"),
      field("ingredient", "naKinds"),
    ],
    invalidatesFor("ingredient"),
    operations("ingredient", {
      create: ["capture", "full"],
      update: standardUpdate("ingredient", ["full", "identity"]),
    }),
  ),
  inventory: definition(
    "inventory",
    [
      field("inventory", "amount"),
      field("inventory", "productId"),
      field("inventory", "locationId"),
      field("inventory", "placement"),
    ],
    invalidatesFor("inventory"),
    operations("inventory", {
      create: ["capture", "full"],
      update: standardUpdate("inventory", [
        "full",
        "amount",
        "product",
        "location",
        "placement",
      ]),
    }),
  ),
  location: definition(
    "location",
    [
      trimmedName("location"),
      field("location", "aliases"),
      field("location", "type"),
      field("location", "productId"),
      field("location", "parentId"),
    ],
    invalidatesFor("location"),
    operations("location", {
      create: ["capture", "full"],
      update: standardUpdate("location", ["full", "identity", "parent"]),
    }),
  ),
  recipe: definition(
    "recipe",
    [
      trimmedName("recipe"),
      field("recipe", "cookbookId"),
      field("recipe", "tags"),
      nullableText("recipe", "notes"),
      field("recipe", "sections"),
    ],
    invalidatesFor("recipe"),
    operations("recipe", {
      create: ["capture", "full"],
      update: standardUpdate("recipe", ["full", "identity"]),
    }),
  ),
  meal: definition(
    "meal",
    [
      field("meal", "date", { required: true }),
      nullableText("meal", "name"),
      field("meal", "mealType"),
      field("meal", "mealKind"),
      field("meal", "sortOrder"),
    ],
    invalidatesFor("meal"),
    operations("meal", {
      create: {
        capture: createIntent("meal", "capture", fieldsFor("meal", "capture"), {
          defaults: () => ({
            date: householdLocalDate(),
            name: null,
            mealType: null,
            mealKind: "cooked",
          }),
        }),
        full: createIntent("meal", "full", fieldsFor("meal", "full"), {
          defaults: {
            date: null,
            name: null,
            mealType: null,
            mealKind: "cooked",
            sortOrder: null,
          },
        }),
      },
      update: standardUpdate("meal", ["full", "calendar"]),
    }),
  ),
  project: definition(
    "project",
    projectFields,
    invalidatesFor("project"),
    operations("project", {
      create: {
        capture: createIntent(
          "project",
          "capture",
          fieldsFor("project", "capture"),
          {
            defaults: {
              name: "",
              status: "planning",
              kind: null,
              costEstimate: null,
              parentProjectId: null,
              startDate: null,
            },
          },
        ),
        full: createIntent("project", "full", fieldsFor("project", "full"), {
          defaults: { status: "planning", kind: null },
        }),
      },
      update: standardUpdate("project", [
        "full",
        "status",
        "kind",
        "dates",
        "parent",
      ]),
    }),
  ),
  task: definition(
    "task",
    taskFields,
    invalidatesFor("task"),
    operations("task", {
      create: {
        capture: createIntent("task", "capture", fieldsFor("task", "capture"), {
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
              ? unsafeProjectShortcode(String(patch.projectId))
              : null,
            subjectProductId: patch.subjectProductId
              ? unsafeProductShortcode(String(patch.subjectProductId))
              : null,
            trade: patch.trade ?? "other",
            dueEndDate: null,
          }),
        }),
        full: createIntent("task", "full", fieldsFor("task", "full"), {
          defaults: { status: "not_started" },
        }),
      },
      update: {
        ...standardUpdate("task", ["full", "status", "project", "subject"]),
        schedule: intent(
          "task",
          "update",
          "schedule",
          fieldsFor("task", "schedule"),
          undefined,
          requiredDate("dueDate"),
        ),
      },
    }),
  ),
  expense: definition(
    "expense",
    [...expenseFields, field("expense", "lineBasis")],
    invalidatesFor("expense"),
    operations("expense", {
      create: {
        capture: createIntent(
          "expense",
          "capture",
          fieldsFor("expense", "capture"),
          {
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
                ? unsafeProjectShortcode(String(patch.projectId))
                : null,
              productId: patch.productId ?? null,
              productQuantity: patch.productId
                ? (patch.productQuantity ?? null)
                : null,
              vendor:
                typeof patch.vendor === "string"
                  ? patch.vendor.trim() || null
                  : null,
              orderId:
                typeof patch.orderId === "string"
                  ? patch.orderId.trim() || null
                  : null,
              url: null,
              notes: null,
            }),
          },
        ),
        full: createIntent("expense", "full", fieldsFor("expense", "full"), {
          defaults: { future: false },
        }),
      },
      update: {
        ...standardUpdate("expense", [
          "full",
          "cost",
          "date",
          "project",
          "product",
        ]),
        planned: intent(
          "expense",
          "update",
          "planned",
          fieldsFor("expense", "planned"),
          ({ surface, record }) =>
            surface === "calendar" && valueFor(record, "future") !== true
              ? readOnly("Recorded expenses stay read-only in the calendar.")
              : editable,
          requiredDate("date"),
        ),
      },
    }),
  ),
  vendor: definition(
    "vendor",
    [
      trimmedName("vendor"),
      nullableText("vendor", "website"),
      nullableText("vendor", "orderUrlTemplate"),
      nullableText("vendor", "notes"),
    ],
    invalidatesFor("vendor"),
    operations("vendor", {
      create: {
        capture: createIntent(
          "vendor",
          "capture",
          fieldsFor("vendor", "capture"),
          { defaults: { name: "", website: null, notes: null } },
        ),
        full: createIntent("vendor", "full", fieldsFor("vendor", "full"), {
          defaults: { name: "", website: null, notes: null },
        }),
      },
      update: standardUpdate("vendor", ["full", "identity"]),
    }),
  ),
  purchase: definition(
    "purchase",
    [
      field("purchase", "vendorId", { required: true }),
      field("purchase", "date", { required: true }),
      nullableText("purchase", "orderId"),
      nullableText("purchase", "displayLabel"),
      field("purchase", "statedTotal"),
      nullableText("purchase", "notes"),
    ],
    invalidatesFor("purchase"),
    operations("purchase", {
      create: {
        capture: createIntent(
          "purchase",
          "capture",
          fieldsFor("purchase", "capture"),
          {
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
              vendorId: unsafeVendorShortcode(String(patch.vendorId)),
            }),
          },
        ),
        full: createIntent("purchase", "full", fieldsFor("purchase", "full"), {
          defaults: { statedTotal: null },
        }),
      },
      update: standardUpdate("purchase", ["full", "vendor", "identity"]),
    }),
  ),
  financialAccount: definition(
    "financialAccount",
    financialAccountFields,
    invalidatesFor("financialAccount"),
    operations("financialAccount", {
      create: {
        capture: createIntent(
          "financialAccount",
          "capture",
          fieldsFor("financialAccount", "capture"),
          {
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
            buildData: (patch) => ({
              name: patch.name,
              provisional: patch.provisional,
              identity: financialAccountIdentity(patch),
              sourceAliases: normalizeSourceAliases(patch.sourceAliases),
              notes: patch.notes,
            }),
          },
        ),
        full: createIntent(
          "financialAccount",
          "full",
          fieldsFor("financialAccount", "capture"),
          {
            defaults: { provisional: false, sourceAliases: [], notes: null },
            buildData: (patch) => ({
              name: patch.name,
              provisional: patch.provisional,
              identity: financialAccountIdentity(patch),
              sourceAliases: normalizeSourceAliases(patch.sourceAliases),
              notes: patch.notes,
            }),
          },
        ),
      },
      update: {
        full: intent(
          "financialAccount",
          "update",
          "full",
          fieldsFor("financialAccount", "full"),
          undefined,
          undefined,
          {
            acceptsSeed: true,
            buildData: (patch) =>
              "sourceAliases" in patch
                ? {
                    ...patch,
                    sourceAliases: normalizeSourceAliases(patch.sourceAliases),
                  }
                : patch,
          },
        ),
        identity: intent(
          "financialAccount",
          "update",
          "identity",
          fieldsFor("financialAccount", "identity"),
        ),
      },
    }),
  ),
  financialTransaction: definition(
    "financialTransaction",
    [
      field("financialTransaction", "accountId", { required: true }),
      field("financialTransaction", "purchaseId"),
      field("financialTransaction", "kind"),
      field("financialTransaction", "status"),
      field("financialTransaction", "amount", {
        validate: ({ value }) =>
          typeof value === "number" && Number.isFinite(value) && value !== 0
            ? noIssues()
            : [
                {
                  field: "amount",
                  message: "Amount must be a non-zero number.",
                  source: "client",
                },
              ],
      }),
      field("financialTransaction", "transactionDate"),
      field("financialTransaction", "postedDate", {
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
      nullableText("financialTransaction", "merchant"),
      nullableText("financialTransaction", "rawDescription"),
      nullableText("financialTransaction", "sourceCategory"),
      field("financialTransaction", "sourceRefs"),
      nullableText("financialTransaction", "notes"),
    ],
    invalidatesFor("financialTransaction"),
    operations("financialTransaction", {
      create: {
        capture: createIntent(
          "financialTransaction",
          "capture",
          fieldsFor("financialTransaction", "capture"),
          {
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
        ),
        full: createIntent(
          "financialTransaction",
          "full",
          fieldsFor("financialTransaction", "full"),
          {
            defaults: { sourceRefs: [] },
            buildData: normalizeFinancialTransaction,
          },
        ),
      },
      update: {
        full: intent(
          "financialTransaction",
          "update",
          "full",
          fieldsFor("financialTransaction", "full"),
          undefined,
          undefined,
          {
            acceptsSeed: true,
            buildData: normalizeFinancialTransaction,
          },
        ),
        settlement: intent(
          "financialTransaction",
          "update",
          "settlement",
          fieldsFor("financialTransaction", "settlement"),
        ),
      },
    }),
  ),
  wish: definition(
    "wish",
    [
      trimmedName("wish"),
      nullableText("wish", "notes"),
      field("wish", "candidateProductIds"),
      field("wish", "acquired"),
    ],
    invalidatesFor("wish"),
    operations("wish", {
      create: {
        capture: createIntent("wish", "capture", fieldsFor("wish", "full"), {
          defaults: { name: "", notes: null, candidateProductIds: [] },
        }),
        full: createIntent("wish", "full", fieldsFor("wish", "full"), {
          defaults: { name: "", notes: null, candidateProductIds: [] },
        }),
      },
      update: {
        full: intent(
          "wish",
          "update",
          "full",
          fieldsFor("wish", "full"),
          undefined,
          undefined,
          { acceptsSeed: true },
        ),
        ...standardUpdate("wish", ["identity", "acquisition"]),
      },
    }),
  ),
});
