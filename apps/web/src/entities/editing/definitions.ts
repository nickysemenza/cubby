import {
  expenseMutationInvalidateKeys,
  financialAccountMutationInvalidateKeys,
  financialTransactionMutationInvalidateKeys,
  ingredientAllMutationInvalidateKeys,
  inventoryMutationInvalidateKeys,
  locationMutationInvalidateKeys,
  mealMutationInvalidateKeys,
  productMutationInvalidateKeys,
  projectMutationInvalidateKeys,
  purchaseMutationInvalidateKeys,
  recipeAllMutationInvalidateKeys,
  taskMutationInvalidateKeys,
  vendorMutationInvalidateKeys,
  wishMutationInvalidateKeys,
} from "~/lib/query-keys";
import { defineEntityEditRegistry } from "./registry";
import type {
  EditableEntity,
  EntityEditAccess,
  EntityEditDefinition,
  EntityEditField,
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
  record?.[id];

const changed = (
  record: EntityEditRecord | undefined,
  id: string,
  value: unknown,
) => !record || !Object.is(valueFor(record, id), value);

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
) => ({
  fields,
  access,
  build: ({ record, patch }: { record?: EntityEditRecord; patch: object }) => {
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
        data: patch,
      },
    };
  },
});

/**
 * Operation declarations are intentionally uniform. The registry adds the
 * semantic intent to the command at the execution seam; definitions own the
 * field selection and any context-sensitive accessibility.
 */
const operations = <E extends EditableEntity>(
  entity: E,
  options?: {
    create?: readonly string[];
    update?: Readonly<Record<string, ReturnType<typeof intent<E>>>>;
    delete?: EntityEditAccess;
  },
) => ({
  ...(options?.create
    ? {
        create: {
          defaultIntent: options.create[0]!,
          intents: Object.fromEntries(
            options.create.map((name) => [
              name,
              intent(entity, "create", name, fieldsFor(entity, name)),
            ]),
          ),
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
  surfaces: EntityEditDefinition<E>["surfaces"],
): EntityEditDefinition<E> => ({
  entity,
  fields,
  invalidationKeys,
  operations: definitionOperations,
  surfaces,
});

const full = (_fields: readonly string[], submitLabel = "Save changes") => ({
  submitLabel,
});

const capture = (_fields: readonly string[], submitLabel = "Create") => ({
  submitLabel,
});

const calendarUpdate = (_fields: readonly string[]) => ({
  submitLabel: "Save",
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
  field("project", "status"),
  field("project", "kind"),
  field("project", "parentProjectId"),
  field("project", "startDate"),
  field("project", "endDate"),
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

const expenseFields = [
  trimmedName("expense"),
  field("expense", "cost"),
  field("expense", "date"),
  field("expense", "future"),
  field("expense", "projectId"),
  field("expense", "productId"),
  field("expense", "vendor"),
  field("expense", "trade"),
  field("expense", "costType"),
  nullableText("expense", "notes"),
] as const;

/**
 * Semantic capabilities, rather than presentation surfaces, choose editable
 * fragments. A Calendar and a detail page can therefore share `schedule`
 * without sharing a form shell; a cell has no power to widen its patch.
 */
const semanticFields: Partial<
  Record<EditableEntity, Record<string, readonly string[]>>
> = {
  product: {
    capture: ["name", "manufacturer"],
    full: [
      "name",
      "aliases",
      "manufacturer",
      "model",
      "category",
      "price",
      "stockTracked",
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
    capture: ["name", "status", "kind", "startDate", "endDate"],
    full: [
      "name",
      "status",
      "kind",
      "parentProjectId",
      "startDate",
      "endDate",
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
      "cost",
      "date",
      "future",
      "projectId",
      "vendor",
      "trade",
      "costType",
    ],
    full: [
      "name",
      "cost",
      "date",
      "future",
      "projectId",
      "productId",
      "vendor",
      "trade",
      "costType",
      "notes",
    ],
    planned: ["name", "cost", "date"],
    cost: ["cost"],
    date: ["date"],
    project: ["projectId"],
    product: ["productId"],
  },
  vendor: {
    capture: ["name"],
    full: ["name", "website", "orderUrlTemplate", "notes"],
    identity: ["name"],
  },
  purchase: {
    capture: ["vendorId", "date", "orderId"],
    full: ["vendorId", "date", "orderId", "notes"],
    vendor: ["vendorId"],
    identity: ["date", "orderId", "notes"],
  },
  financialAccount: {
    capture: ["name", "type"],
    full: ["name", "type", "provisional", "sourceAliases", "notes"],
    identity: ["name", "type", "provisional", "sourceAliases", "notes"],
  },
  financialTransaction: {
    capture: ["accountId", "kind", "status", "amount", "transactionDate"],
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
  semanticFields[entity]?.[semanticIntent] ?? [];

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
      field("product", "price"),
      field("product", "stockTracked"),
      nullableText("product", "notes"),
    ],
    productMutationInvalidateKeys,
    operations("product", {
      create: ["capture", "full"],
      update: standardUpdate("product", ["full", "identity", "price", "stock"]),
    }),
    {
      detail: full([
        "name",
        "aliases",
        "manufacturer",
        "model",
        "category",
        "price",
        "stockTracked",
        "notes",
      ]),
      "create-page": capture(["name", "manufacturer"]),
      "quick-create": capture(["name", "manufacturer"]),
      cell: { submitLabel: "Save" },
    },
  ),
  ingredient: definition(
    "ingredient",
    [
      trimmedName("ingredient"),
      field("ingredient", "aliases"),
      field("ingredient", "naKinds"),
    ],
    ingredientAllMutationInvalidateKeys,
    operations("ingredient", {
      create: ["capture", "full"],
      update: standardUpdate("ingredient", ["full", "identity"]),
    }),
    {
      detail: full(["name", "aliases", "naKinds"]),
      "create-page": capture(["name", "aliases"]),
      "quick-create": capture(["name"]),
      cell: { submitLabel: "Save" },
    },
  ),
  inventory: definition(
    "inventory",
    [
      field("inventory", "amount"),
      field("inventory", "productId"),
      field("inventory", "locationId"),
      field("inventory", "placement"),
    ],
    inventoryMutationInvalidateKeys,
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
    {
      detail: full(["amount", "productId", "locationId", "placement"]),
      "quick-create": capture([
        "productId",
        "locationId",
        "amount",
        "placement",
      ]),
      cell: { submitLabel: "Save" },
    },
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
    locationMutationInvalidateKeys,
    operations("location", {
      create: ["capture", "full"],
      update: standardUpdate("location", ["full", "identity", "parent"]),
    }),
    {
      detail: full(["name", "aliases", "type", "productId", "parentId"]),
      "create-page": capture(["name", "type", "parentId"]),
      "quick-create": capture(["name", "type", "parentId"]),
      cell: { submitLabel: "Move" },
    },
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
    recipeAllMutationInvalidateKeys,
    operations("recipe", {
      create: ["capture", "full"],
      update: standardUpdate("recipe", ["full", "identity"]),
    }),
    {
      detail: full(["name", "cookbookId", "tags", "notes", "sections"]),
      "create-page": capture(["name"]),
      "quick-create": capture(["name"]),
    },
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
    mealMutationInvalidateKeys,
    operations("meal", {
      create: ["capture", "full"],
      update: standardUpdate("meal", ["full", "calendar"]),
    }),
    {
      detail: full(["date", "name", "mealType", "mealKind", "sortOrder"]),
      "quick-create": capture(["date", "name", "mealType", "mealKind"]),
      calendar: calendarUpdate(["date", "name", "mealType", "mealKind"]),
      cell: { submitLabel: "Save" },
    },
  ),
  project: definition(
    "project",
    projectFields,
    projectMutationInvalidateKeys,
    operations("project", {
      create: ["capture", "full"],
      update: standardUpdate("project", [
        "full",
        "status",
        "kind",
        "dates",
        "parent",
      ]),
    }),
    {
      detail: full([
        "name",
        "status",
        "kind",
        "parentProjectId",
        "startDate",
        "endDate",
        "notes",
      ]),
      "quick-create": capture([
        "name",
        "status",
        "kind",
        "startDate",
        "endDate",
      ]),
      cell: { submitLabel: "Save" },
    },
  ),
  task: definition(
    "task",
    taskFields,
    taskMutationInvalidateKeys,
    operations("task", {
      create: ["capture", "full"],
      update: standardUpdate("task", [
        "full",
        "schedule",
        "status",
        "project",
        "subject",
      ]),
    }),
    {
      detail: full([
        "name",
        "status",
        "projectId",
        "subjectProductId",
        "trade",
        "dueDate",
        "dueEndDate",
        "notes",
      ]),
      "quick-create": capture([
        "name",
        "status",
        "projectId",
        "subjectProductId",
        "trade",
        "dueDate",
      ]),
      calendar: calendarUpdate(["name", "status", "dueDate", "dueEndDate"]),
      cell: { submitLabel: "Save" },
    },
  ),
  expense: definition(
    "expense",
    expenseFields,
    expenseMutationInvalidateKeys,
    operations("expense", {
      create: ["capture", "full"],
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
            surface === "calendar" && record?.future !== true
              ? readOnly("Recorded expenses stay read-only in the calendar.")
              : editable,
        ),
      },
    }),
    {
      detail: full([
        "name",
        "cost",
        "date",
        "future",
        "projectId",
        "productId",
        "vendor",
        "trade",
        "costType",
        "notes",
      ]),
      "quick-create": capture([
        "name",
        "cost",
        "date",
        "future",
        "projectId",
        "vendor",
        "trade",
        "costType",
      ]),
      calendar: { submitLabel: "Save" },
      cell: { submitLabel: "Save" },
    },
  ),
  vendor: definition(
    "vendor",
    [
      trimmedName("vendor"),
      nullableText("vendor", "website"),
      nullableText("vendor", "orderUrlTemplate"),
      nullableText("vendor", "notes"),
    ],
    vendorMutationInvalidateKeys,
    operations("vendor", {
      create: ["capture", "full"],
      update: standardUpdate("vendor", ["full", "identity"]),
    }),
    {
      detail: full(["name", "website", "orderUrlTemplate", "notes"]),
      "quick-create": capture(["name"]),
      cell: { submitLabel: "Save" },
    },
  ),
  purchase: definition(
    "purchase",
    [
      field("purchase", "vendorId"),
      field("purchase", "date"),
      nullableText("purchase", "orderId"),
      nullableText("purchase", "notes"),
    ],
    purchaseMutationInvalidateKeys,
    operations("purchase", {
      create: ["capture", "full"],
      update: standardUpdate("purchase", ["full", "vendor", "identity"]),
    }),
    {
      detail: full(["vendorId", "date", "orderId", "notes"]),
      "quick-create": capture(["vendorId", "date", "orderId"]),
      cell: { submitLabel: "Save" },
    },
  ),
  financialAccount: definition(
    "financialAccount",
    [
      trimmedName("financialAccount"),
      field("financialAccount", "type"),
      field("financialAccount", "provisional"),
      field("financialAccount", "sourceAliases"),
      nullableText("financialAccount", "notes"),
    ],
    financialAccountMutationInvalidateKeys,
    operations("financialAccount", {
      create: ["capture", "full"],
      update: standardUpdate("financialAccount", ["full", "identity"]),
    }),
    {
      detail: full(["name", "type", "provisional", "sourceAliases", "notes"]),
      "quick-create": capture(["name", "type"]),
    },
  ),
  financialTransaction: definition(
    "financialTransaction",
    [
      field("financialTransaction", "accountId", { required: true }),
      field("financialTransaction", "purchaseId"),
      field("financialTransaction", "kind"),
      field("financialTransaction", "status"),
      field("financialTransaction", "amount"),
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
    financialTransactionMutationInvalidateKeys,
    operations("financialTransaction", {
      create: ["capture", "full"],
      update: standardUpdate("financialTransaction", ["full", "settlement"]),
    }),
    {
      detail: full([
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
      ]),
      "quick-create": capture([
        "accountId",
        "kind",
        "status",
        "amount",
        "transactionDate",
      ]),
      dialog: { submitLabel: "Save transaction" },
    },
  ),
  wish: definition(
    "wish",
    [
      trimmedName("wish"),
      nullableText("wish", "notes"),
      field("wish", "candidateProductIds"),
      field("wish", "acquired"),
    ],
    wishMutationInvalidateKeys,
    operations("wish", {
      create: ["capture", "full"],
      update: standardUpdate("wish", ["full", "identity", "acquisition"]),
    }),
    {
      detail: full(["name", "notes", "candidateProductIds", "acquired"]),
      "quick-create": capture(["name"]),
      cell: { submitLabel: "Save" },
    },
  ),
});
