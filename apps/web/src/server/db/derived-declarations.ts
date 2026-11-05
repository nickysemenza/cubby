/**
 * Every stored derived value (ADR 0021), read once from the entity manifest
 * (`model.derived.<key>.stored`), plus the internal records this module
 * registers. The drain and the generated triggers resolve every declaration
 * here, so a value has one declaration and no parallel scheduling list. List
 * reads, explanations and other entity metadata read only the entity subset.
 */
import { assessmentFamily } from "@cubby/schemas/assessment";
import {
  ASSESSMENT_READ_TARGET,
  ASSESSMENT_READ_LABEL,
  assessmentReadScopedSourceKind,
} from "@cubby/schemas/assessment-read-publication";
import { EMAIL_RELATIONSHIP_INPUTS } from "@cubby/schemas/email-fields";
import { entitySchema, type Entity } from "@cubby/schemas/entity";
import { storedDerivedManifest } from "@cubby/schemas/entity-stored-derived";
import { imageDescriptionReceiptWhere } from "@cubby/schemas/image-capture-fields";
import { z } from "zod";

const snapshotSource = z.object({
  table: z.string(),
  value: z.union([z.string(), z.record(z.string(), z.string())]),
  computedAt: z.string(),
  decidedBy: z.string().optional(),
});

/** One input: changes to `table` rows whose `tableColumn` equals the value's `entityColumn`. */
export interface DerivedInput {
  readonly table: string;
  readonly tableColumn: string;
  readonly entityColumn: string;
  /**
   * `textHash`: refs are the hash of a non-UUID `tableColumn` from
   * `textHashRefSqlText`, reaching targets only through `selection` or `path`.
   * Absent: the column value is the UUID ref. Internal records only.
   */
  readonly captureKey?: "textHash";
  /** False suppresses source triggers, never pending fanout interpretation. */
  readonly capture?: false;
  /** Columns whose change matters; null = any column except `updatedAt`. */
  readonly columns: readonly string[] | null;
  /** Only rows holding these column values count. */
  readonly where: Readonly<Record<string, string>> | null;
  /** Without `columns`: columns besides `updatedAt` whose change never matters. */
  readonly except: readonly string[];
  /** A join path from the matched value to this entity's ids. */
  readonly path: readonly DerivedPathStep[] | null;
  readonly paths?: readonly (readonly DerivedPathStep[])[];
  readonly targetWhere: Readonly<Record<string, string | null>> | null;
  readonly selection?: {
    readonly key: string;
    readonly path?: readonly DerivedPathStep[];
    /** Entity values only: prior refs in the `DerivedValue`. An internal record's callback returns its own. */
    readonly retained?: {
      readonly array: readonly string[];
      readonly key: string;
    };
  };
  /** The matched column is JSON; values are `key` of the array at `array`. */
  readonly json: {
    readonly array?: readonly string[];
    readonly key: string;
  } | null;
}

/** One join step: `to` of `table` rows whose `from` holds a previous value. */
export interface DerivedPathStep {
  readonly table: string;
  readonly from: string;
  readonly to: string;
  readonly jsonKey?: string;
  readonly fromJsonKey?: string;
  readonly where?: Readonly<Record<string, string>>;
  readonly recursive?: { readonly maxDepth: number };
}

/**
 * Another stored value this one reads: joined `source.sourceColumn =
 * this.entityColumn`, or through a link table whose `source` column holds the
 * changed record and `dependent` column the record to mark.
 */
export type DerivedDependency = {
  readonly entity: Entity;
  readonly key: string;
} & (
  | { readonly sourceColumn: string; readonly entityColumn: string }
  | { readonly path: readonly DerivedPathStep[] }
  | { readonly targetWhere: Readonly<Record<string, string | null>> }
  | {
      readonly through: {
        readonly table: string;
        readonly source: string;
        readonly dependent: string;
        readonly where: Readonly<Record<string, string>> | null;
      };
    }
);

type DerivedSortType = "number" | "date" | "text" | null;

/** What the drain and triggers need, whichever owner the target belongs to. */
interface StoredDerivedWork {
  /** The dirty-row target: a stable name pending tickets keep across deploys. */
  readonly target: string;
  /** The source table: its UUID `id` is the mark's ref and sink lock. */
  readonly table: string;
  readonly compute: string;
  readonly inputs: readonly DerivedInput[];
  readonly dependsOn: readonly DerivedDependency[];
}

export interface EntityStoredDerivedDeclaration extends StoredDerivedWork {
  readonly kind: "entity";
  readonly entity: Entity;
  readonly key: string;
  /** Publication and freshness ring this declaration's own record refs. */
  readonly notifications: "entityRefs";
  readonly clock: "householdDay" | null;
  /**
   * `derivedValue`: published as a `DerivedValue` row, with per-row meta in the
   * envelope. `ownTable`: written to the value's own table (search documents,
   * recipe totals), so readers read that table.
   */
  readonly publishes: "derivedValue" | "ownTable";
  readonly snapshotSource?: z.infer<typeof snapshotSource>;
  readonly recordSource: {
    readonly value: string;
    readonly computedAt: string;
    readonly freshAt?: string;
  } | null;
  readonly sort: DerivedSortType;
}

/**
 * A publication about non-entity records: no public Entity, DerivedValue
 * envelope, field metadata or explanation. It must use a `derivedSink`, whose
 * refs are `table` ids rather than entity ids, so the sink names the entities
 * each publication affected through its publication context. Marks and fanout
 * expansion ring nothing. Dependencies may read entity values; no stored value
 * can depend on an internal record.
 */
export interface InternalStoredDerivedDeclaration extends StoredDerivedWork {
  readonly kind: "internalRecord";
  readonly label: string;
  readonly publishes: "ownTable";
  readonly notifications: "sinkOwned";
  /** Rows the daily pass marks, sharing `table`'s UUID `id`; null marks every row. */
  readonly reconcile: {
    readonly table: string;
    readonly where: Readonly<Record<string, string | null | readonly string[]>>;
  } | null;
}

export type StoredDerivedDeclaration =
  | EntityStoredDerivedDeclaration
  | InternalStoredDerivedDeclaration;

const pathStep = z.object({
  table: z.string(),
  from: z.string(),
  to: z.string(),
  jsonKey: z.string().optional(),
  fromJsonKey: z.string().optional(),
  where: z.record(z.string(), z.string()).optional(),
  recursive: z.object({ maxDepth: z.number().int().positive() }).optional(),
});

const storedInput = z.object({
  table: z.string(),
  match: z.record(z.string(), z.string()),
  capture: z.literal(false).optional(),
  columns: z.array(z.string()).optional(),
  where: z.record(z.string(), z.string()).optional(),
  except: z.array(z.string()).optional(),
  path: z.array(pathStep).optional(),
  paths: z.array(z.array(pathStep).min(1)).min(1).optional(),
  targetWhere: z.record(z.string(), z.string().nullable()).optional(),
  selection: z
    .object({
      key: z.string(),
      path: z.array(pathStep).optional(),
      retained: z.object({
        array: z.array(z.string()).min(1),
        key: z.string(),
      }),
    })
    .optional(),
  json: z
    .object({ array: z.array(z.string()).optional(), key: z.string() })
    .optional(),
});

const storedDependency = z.union([
  z.object({
    entity: entitySchema,
    key: z.string(),
    targetWhere: z
      .record(z.string(), z.string().nullable())
      .refine((where) => Object.keys(where).length > 0),
  }),
  z.object({
    entity: entitySchema,
    key: z.string(),
    match: z.record(z.string(), z.string()),
  }),
  z.object({
    entity: entitySchema,
    key: z.string(),
    path: z.array(pathStep),
  }),
  z.object({
    entity: entitySchema,
    key: z.string(),
    through: z.object({
      table: z.string(),
      source: z.string(),
      dependent: z.string(),
      where: z.record(z.string(), z.string()).optional(),
    }),
  }),
]);

/** The generated registry's entry, parsed at this boundary. */
const storedEntry = z.object({
  entity: entitySchema,
  key: z.string(),
  table: z.string().nullable(),
  type: z.string(),
  publishes: z.enum(["derivedValue", "ownTable"]),
  stored: z.object({
    compute: z.string(),
    snapshotSource: snapshotSource.optional(),
    recordSource: z
      .object({
        value: z.string(),
        computedAt: z.string(),
        freshAt: z.string().optional(),
      })
      .optional(),
    clock: z.literal("householdDay").optional(),
    inputs: z.array(storedInput),
    dependsOn: z.array(storedDependency).optional(),
  }),
});

/**
 * An internal record's input: the manifest shape, except `selection` has no
 * `retained` `DerivedValue` to read, so its callback returns current and retained
 * dependents alike, and a non-UUID source column can capture through `captureKey`.
 * These authoring mistakes would otherwise expand to the wrong records silently.
 */
const internalInput = storedInput
  .omit({ selection: true })
  .extend({
    selection: z
      .strictObject({
        key: z.string(),
        path: z.array(pathStep).optional(),
      })
      .optional(),
    captureKey: z.literal("textHash").optional(),
  })
  .refine(
    (input) =>
      !input.selection || (!input.path && !input.paths && !input.targetWhere),
    "selection replaces path, paths and targetWhere; map sources with selection.path",
  )
  .refine(
    (input) => !input.captureKey || (!input.json && !input.targetWhere),
    "captureKey hashes one plain column, so it cannot be combined with json or targetWhere",
  )
  .refine(
    (input) =>
      !input.captureKey || input.selection || input.path || input.paths,
    "A captureKey hash is not a target id; reach targets through selection, path or paths",
  )
  .refine(
    (input) =>
      (!input.selection && !input.captureKey) ||
      Object.values(input.match).every((column) => column === "id"),
    "selection and captureKey expansion ignore the target column; match it to id",
  );

/**
 * One internal record publication. `target` is `<owner>.<key>`, where the owner
 * is not an entity, so it cannot shadow a manifest target. Dependencies are the
 * same authoring shapes a manifest declares. `reconcile` narrows the daily pass
 * to rows that can still be owed, for a source table with a closed history.
 */
const internalRecordSpec = z.object({
  label: z.string().min(1),
  target: z
    .string()
    .regex(/^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/)
    .refine((target) => !entitySchema.safeParse(target.split(".")[0]).success),
  table: z.string(),
  compute: z.string(),
  notifications: z.literal("sinkOwned"),
  inputs: z.array(internalInput),
  dependsOn: z.array(storedDependency).optional(),
  reconcile: z
    .object({
      table: z.string(),
      where: z
        .record(
          z.string(),
          z.union([z.string(), z.null(), z.array(z.string()).min(1)]),
        )
        .refine((where) => Object.keys(where).length > 0),
    })
    .optional(),
});

type InternalRecordSpec = z.input<typeof internalRecordSpec>;

// Entity inserts can bootstrap the drain Job. Capturing Job/Run identities here
// would recursively schedule the same job; input positions remain explicit below.
const recordIdentityInputs = (
  kind: Exclude<Entity, "job" | "run">,
): InternalRecordSpec["inputs"] => [
  {
    table: "Entity",
    match: { id: "id" },
    where: { kind },
    columns: ["deletedAt", "mergedIntoId"],
    selection: { key: kind },
  },
  {
    table: "Entity",
    match: { shortcode: "id" },
    where: { kind },
    columns: ["shortcode", "deletedAt", "mergedIntoId"],
    captureKey: "textHash",
    selection: { key: assessmentReadScopedSourceKind.enum.referenceCode },
  },
];

/** Reuse Email's capture owner without inheriting its Entity publication storage. */
const emailAssessmentInputs = (
  positions: readonly number[],
): InternalRecordSpec["inputs"] =>
  positions.map((position) => {
    const input = EMAIL_RELATIONSHIP_INPUTS[position];
    if (!input) throw new Error(`Missing Email relationship input ${position}`);
    const [match] = Object.entries(input.match);
    if (!match || Object.keys(input.match).length !== 1 || input.paths)
      throw new Error(`Unsupported Email relationship input ${position}`);
    const [column, destination] = match;
    const path =
      input.selection?.path ??
      input.path ??
      (destination === "orderMailId"
        ? [{ table: "Email", from: "orderMailId", to: "id" }]
        : []);
    if (
      !input.selection &&
      destination !== "id" &&
      destination !== "orderMailId"
    )
      throw new Error(`Unknown Email relationship destination ${destination}`);
    return {
      table: input.table,
      match: { [column]: "id" },
      ...(input.capture === false ? { capture: false } : {}),
      ...(input.where ? { where: input.where } : {}),
      ...(input.except ? { except: input.except } : {}),
      ...(input.json ? { json: input.json } : {}),
      ...(input.columns
        ? {
            columns:
              input.table === "OrderMailEvent"
                ? // The review basis reads event identity too; relationship facts do not.
                  [...new Set([...input.columns, "event", "sourceKey"])]
                : input.columns,
          }
        : {}),
      selection: {
        key: input.selection ? "emailPurchase" : "email",
        ...(path.length ? { path } : {}),
      },
    };
  });

/**
 * Registered internal records. Append only: triggers and the drain read this
 * list after the manifest, and pending fanouts name an input by position, so
 * an entry's inputs also keep their order.
 */
const internalRecordSpecs: readonly InternalRecordSpec[] = [
  {
    target: ASSESSMENT_READ_TARGET,
    table: "Assessment",
    compute: ASSESSMENT_READ_TARGET,
    label: ASSESSMENT_READ_LABEL,
    notifications: "sinkOwned",
    reconcile: {
      table: "AssessmentState",
      where: {
        active: "true",
        status: "pending",
        // Immutable and current family authority can diverge. Canonical
        // preparation applies their union; State-only filtering loses work.
      },
    },
    // Stable input positions: extend this list at the end, never by catalog order.
    inputs: [
      {
        table: "Assessment",
        match: { id: "id" },
        columns: ["served"],
        where: { family: assessmentFamily.enum.field },
      },
      {
        table: "Assessment",
        match: { id: "id" },
        columns: ["served"],
        where: { family: assessmentFamily.enum.recommendation },
      },
      {
        table: "Assessment",
        match: { id: "id" },
        columns: ["served"],
        where: { family: assessmentFamily.enum.product_pair },
      },
      {
        table: "Assessment",
        match: { id: "id" },
        columns: ["served"],
        where: { family: assessmentFamily.enum.image_description },
      },
      {
        table: "Assessment",
        match: { id: "id" },
        columns: ["served"],
        where: { family: assessmentFamily.enum.statement_transaction },
      },
      {
        table: "Assessment",
        match: { id: "id" },
        columns: ["served"],
        where: { family: assessmentFamily.enum.transfer_pair },
      },
      {
        table: "AssessmentState",
        match: { id: "id" },
        where: { family: assessmentFamily.enum.field },
      },
      {
        table: "AssessmentState",
        match: { id: "id" },
        where: { family: assessmentFamily.enum.recommendation },
      },
      {
        table: "AssessmentState",
        match: { id: "id" },
        where: { family: assessmentFamily.enum.product_pair },
      },
      {
        table: "AssessmentState",
        match: { id: "id" },
        where: { family: assessmentFamily.enum.image_description },
      },
      {
        table: "AssessmentState",
        match: { id: "id" },
        where: { family: assessmentFamily.enum.statement_transaction },
      },
      {
        table: "AssessmentState",
        match: { id: "id" },
        where: { family: assessmentFamily.enum.transfer_pair },
      },
      {
        table: "Feedback",
        match: { assessmentId: "id" },
        selection: { key: "assessment" },
      },
      { table: "Product", match: { id: "id" }, selection: { key: "product" } },
      { table: "Expense", match: { id: "id" }, selection: { key: "expense" } },
      {
        table: "Purchase",
        match: { id: "id" },
        selection: { key: "purchase" },
      },
      {
        table: "FinancialAccount",
        match: { id: "id" },
        selection: { key: "financialAccount" },
      },
      {
        table: "FinancialTransaction",
        match: { id: "id" },
        selection: { key: "financialTransaction" },
      },
      {
        table: "LedgerParty",
        match: { id: "id" },
        selection: { key: "ledgerParty" },
      },
      { table: "Vendor", match: { id: "id" }, selection: { key: "vendor" } },
      {
        table: "VendorAccount",
        match: { id: "id" },
        selection: { key: "vendorAccount" },
      },
      {
        table: "SpendingCategory",
        match: { id: "id" },
        selection: { key: "spendingCategory" },
      },
      { table: "Project", match: { id: "id" }, selection: { key: "project" } },
      { table: "Task", match: { id: "id" }, selection: { key: "task" } },
      { table: "Image", match: { id: "id" }, selection: { key: "image" } },
      {
        table: "InventoryEntry",
        match: { id: "id" },
        selection: { key: "inventory" },
      },
      {
        table: "Location",
        match: { id: "id" },
        selection: { key: "location" },
      },
      {
        table: "Cookbook",
        match: { id: "id" },
        selection: { key: "cookbook" },
      },
      { table: "Device", match: { id: "id" }, selection: { key: "device" } },
      {
        table: "Ingredient",
        match: { id: "id" },
        selection: { key: "ingredient" },
      },
      { table: "Plant", match: { id: "id" }, selection: { key: "plant" } },
      { table: "Email", match: { id: "id" }, selection: { key: "email" } },
      {
        table: "ProductCategory",
        match: { id: "id" },
        selection: { key: "productCategory" },
      },
      {
        table: "SourceTransactionRecord",
        match: { id: "id" },
        selection: { key: "sourceTransactionRecord" },
      },
      {
        table: "TransactionImport",
        match: { id: "id" },
        selection: { key: "transactionImport" },
      },
      { table: "Meal", match: { id: "id" }, selection: { key: "meal" } },
      { table: "Recipe", match: { id: "id" }, selection: { key: "recipe" } },
      {
        table: "GardenEntry",
        match: { id: "id" },
        selection: { key: "gardenEntry" },
      },
      {
        table: "Planting",
        match: { id: "id" },
        selection: { key: "planting" },
      },
      {
        table: "Shipment",
        match: { id: "id" },
        selection: { key: "shipment" },
      },
      { table: "Wish", match: { id: "id" }, selection: { key: "wish" } },
      {
        table: "LedgerTransfer",
        match: { id: "id" },
        selection: { key: "ledgerTransfer" },
      },
      ...recordIdentityInputs("product"),
      ...recordIdentityInputs("expense"),
      ...recordIdentityInputs("purchase"),
      ...recordIdentityInputs("financialAccount"),
      ...recordIdentityInputs("financialTransaction"),
      ...recordIdentityInputs("ledgerParty"),
      ...recordIdentityInputs("vendor"),
      ...recordIdentityInputs("vendorAccount"),
      ...recordIdentityInputs("spendingCategory"),
      ...recordIdentityInputs("project"),
      ...recordIdentityInputs("task"),
      ...recordIdentityInputs("image"),
      ...recordIdentityInputs("inventory"),
      ...recordIdentityInputs("location"),
      ...recordIdentityInputs("cookbook"),
      ...recordIdentityInputs("device"),
      ...recordIdentityInputs("ingredient"),
      ...recordIdentityInputs("plant"),
      ...recordIdentityInputs("email"),
      ...recordIdentityInputs("productCategory"),
      ...recordIdentityInputs("sourceTransactionRecord"),
      ...recordIdentityInputs("transactionImport"),
      ...recordIdentityInputs("meal"),
      ...recordIdentityInputs("recipe"),
      ...recordIdentityInputs("gardenEntry"),
      ...recordIdentityInputs("planting"),
      ...recordIdentityInputs("shipment"),
      ...recordIdentityInputs("wish"),
      ...recordIdentityInputs("ledgerTransfer"),
      {
        table: "QualitySnapshot",
        match: { entityId: "id" },
        where: { kind: "product" },
        selection: { key: "productQuality" },
      },
      {
        table: "ProductCategory",
        match: { id: "id" },
        selection: { key: "classificationRoster" },
      },
      {
        table: "AuditLog",
        match: { entityId: "id" },
        where: { action: "update" },
        selection: { key: assessmentReadScopedSourceKind.enum.fieldWrite },
      },
      {
        table: "Product",
        match: { shortcode: "id" },
        columns: ["updatedAt", "tags", "deletedAt", "shortcode"],
        captureKey: "textHash",
        selection: { key: assessmentReadScopedSourceKind.enum.tagProduct },
      },
      {
        table: "EntityAttachment",
        match: { entityId: "id" },
        where: { entityKind: "product" },
        selection: { key: "product" },
      },
      {
        table: "Image",
        match: { id: "id" },
        selection: {
          key: "product",
          path: [
            {
              table: "EntityAttachment",
              from: "imageId",
              to: "entityId",
              where: { entityKind: "product" },
            },
          ],
        },
      },
      {
        table: "AiAnalysis",
        match: { entityId: "id" },
        where: { entityKind: "image", feature: "image-description" },
        selection: {
          key: "product",
          path: [
            {
              table: "EntityAttachment",
              from: "imageId",
              to: "entityId",
              where: { entityKind: "product" },
            },
          ],
        },
      },
      {
        table: "AssessmentState",
        match: { recordId: "id" },
        where: { family: assessmentFamily.enum.image_description },
        selection: {
          key: "product",
          path: [
            {
              table: "EntityAttachment",
              from: "imageId",
              to: "entityId",
              where: { entityKind: "product" },
            },
          ],
        },
      },
      {
        table: "Feedback",
        match: { assessmentId: "id" },
        where: imageDescriptionReceiptWhere,
        selection: {
          key: "product",
          path: [
            {
              table: "AssessmentState",
              from: "id",
              to: "recordId",
              where: { family: assessmentFamily.enum.image_description },
            },
            {
              table: "EntityAttachment",
              from: "imageId",
              to: "entityId",
              where: { entityKind: "product" },
            },
          ],
        },
      },
      // Product pair sides include acquisition/import evidence, even before a
      // first publication has installed reverse dependencies. Capture both FK
      // endpoints; paths expand later without adding reads to the source save.
      {
        table: "Expense",
        match: { productId: "id" },
        selection: { key: "product" },
      },
      {
        table: "InventoryEntry",
        match: { productId: "id" },
        selection: { key: "product" },
      },
      {
        table: "EntityExternalId",
        match: { entityId: "id" },
        where: { entityKind: "product" },
        selection: { key: "product" },
      },
      {
        table: "EntityLink",
        match: { toEntityId: "id" },
        where: { kind: "purchaseProduct" },
        selection: { key: "product" },
      },
      {
        table: "ImportSourceProduct",
        match: { productId: "id" },
        selection: { key: "product" },
      },
      {
        table: "ImportSourceProduct",
        match: { expenseId: "id" },
        selection: {
          key: "product",
          path: [{ table: "Expense", from: "id", to: "productId" }],
        },
      },
      {
        table: "ImportSourceOrder",
        match: { id: "id" },
        selection: {
          key: "product",
          path: [
            {
              table: "ImportSourceProduct",
              from: "sourceOrderId",
              to: "productId",
            },
          ],
        },
      },
      {
        table: "ImportSourceOrder",
        match: { id: "id" },
        selection: {
          key: "product",
          path: [
            {
              table: "ImportSourceProduct",
              from: "sourceOrderId",
              to: "expenseId",
            },
            { table: "Expense", from: "id", to: "productId" },
          ],
        },
      },
      {
        table: "ImportSourceClaim",
        match: { id: "id" },
        selection: {
          key: "product",
          path: [
            { table: "ImportSourceOrder", from: "sourceClaimId", to: "id" },
            {
              table: "ImportSourceProduct",
              from: "sourceOrderId",
              to: "productId",
            },
          ],
        },
      },
      {
        table: "ImportSourceClaim",
        match: { id: "id" },
        selection: {
          key: "product",
          path: [
            { table: "ImportSourceOrder", from: "sourceClaimId", to: "id" },
            {
              table: "ImportSourceProduct",
              from: "sourceOrderId",
              to: "expenseId",
            },
            { table: "Expense", from: "id", to: "productId" },
          ],
        },
      },
      {
        table: "Purchase",
        match: { id: "id" },
        selection: {
          key: "product",
          path: [{ table: "Expense", from: "purchaseId", to: "productId" }],
        },
      },
      {
        table: "Purchase",
        match: { id: "id" },
        selection: {
          key: "product",
          path: [
            {
              table: "EntityLink",
              from: "fromEntityId",
              to: "toEntityId",
              where: { kind: "purchaseProduct" },
            },
          ],
        },
      },
      {
        table: "Vendor",
        match: { id: "id" },
        selection: {
          key: "product",
          path: [{ table: "Product", from: "brandId", to: "id" }],
        },
      },
      {
        table: "Vendor",
        match: { id: "id" },
        selection: {
          key: "product",
          path: [
            { table: "Purchase", from: "vendorId", to: "id" },
            { table: "Expense", from: "purchaseId", to: "productId" },
          ],
        },
      },
      {
        table: "Vendor",
        match: { id: "id" },
        selection: {
          key: "product",
          path: [
            { table: "Purchase", from: "vendorId", to: "id" },
            {
              table: "EntityLink",
              from: "fromEntityId",
              to: "toEntityId",
              where: { kind: "purchaseProduct" },
            },
          ],
        },
      },
      {
        table: "VendorAccount",
        match: { id: "id" },
        selection: {
          key: "product",
          path: [
            { table: "Purchase", from: "vendorAccountId", to: "id" },
            { table: "Expense", from: "purchaseId", to: "productId" },
          ],
        },
      },
      {
        table: "VendorAccount",
        match: { id: "id" },
        selection: {
          key: "product",
          path: [
            { table: "Purchase", from: "vendorAccountId", to: "id" },
            {
              table: "EntityLink",
              from: "fromEntityId",
              to: "toEntityId",
              where: { kind: "purchaseProduct" },
            },
          ],
        },
      },
      {
        table: "Vendor",
        match: { id: "id" },
        columns: [
          "website",
          "browserDomains",
          "deletedAt",
          "systemKey",
          "shortcode",
        ],
        selection: { key: "pairPolicy" },
      },
      {
        table: "ExternalSource",
        match: { slug: "id" },
        columns: ["slug", "vendorId", "issuer"],
        captureKey: "textHash",
        selection: { key: "pairPolicy" },
      },
      {
        table: "ExpenseAttribution",
        match: { expenseId: "id" },
        selection: {
          key: "product",
          path: [{ table: "Expense", from: "id", to: "productId" }],
        },
      },
      {
        table: "FinancialTransactionAllocation",
        match: { purchaseId: "id" },
        selection: {
          key: "product",
          path: [{ table: "Expense", from: "purchaseId", to: "productId" }],
        },
      },
      {
        table: "FinancialTransactionAllocation",
        match: { purchaseId: "id" },
        selection: {
          key: "product",
          path: [
            {
              table: "EntityLink",
              from: "fromEntityId",
              to: "toEntityId",
              where: { kind: "purchaseProduct" },
            },
          ],
        },
      },
      {
        table: "FinancialTransaction",
        match: { id: "id" },
        selection: {
          key: "product",
          path: [
            {
              table: "FinancialTransactionAllocation",
              from: "transactionId",
              to: "purchaseId",
            },
            { table: "Expense", from: "purchaseId", to: "productId" },
          ],
        },
      },
      {
        table: "FinancialTransaction",
        match: { id: "id" },
        selection: {
          key: "product",
          path: [
            {
              table: "FinancialTransactionAllocation",
              from: "transactionId",
              to: "purchaseId",
            },
            {
              table: "EntityLink",
              from: "fromEntityId",
              to: "toEntityId",
              where: { kind: "purchaseProduct" },
            },
          ],
        },
      },
      {
        table: "FinancialAccount",
        match: { id: "id" },
        selection: {
          key: "product",
          path: [
            { table: "FinancialTransaction", from: "accountId", to: "id" },
            {
              table: "FinancialTransactionAllocation",
              from: "transactionId",
              to: "purchaseId",
            },
            { table: "Expense", from: "purchaseId", to: "productId" },
          ],
        },
      },
      {
        table: "FinancialAccount",
        match: { id: "id" },
        selection: {
          key: "product",
          path: [
            { table: "FinancialTransaction", from: "accountId", to: "id" },
            {
              table: "FinancialTransactionAllocation",
              from: "transactionId",
              to: "purchaseId",
            },
            {
              table: "EntityLink",
              from: "fromEntityId",
              to: "toEntityId",
              where: { kind: "purchaseProduct" },
            },
          ],
        },
      },
      // The two-person owner roster changes match-side classification globally.
      {
        table: "LedgerParty",
        match: { id: "id" },
        selection: { key: "pairPolicy" },
      },
      // New charge observations and settlement graph edges must reach advice
      // that predates those rows; retained dependencies alone cannot find it.
      {
        table: "SourceTransactionRecord",
        match: { chargeKey: "id" },
        captureKey: "textHash",
        selection: { key: assessmentReadScopedSourceKind.enum.statementCharge },
      },
      {
        table: "SourceTransactionRecord",
        match: { externalId: "id" },
        captureKey: "textHash",
        selection: { key: assessmentReadScopedSourceKind.enum.statementRef },
      },
      {
        table: "SourceTransactionRecord",
        match: { legacyReference: "id" },
        captureKey: "textHash",
        selection: { key: assessmentReadScopedSourceKind.enum.statementRef },
      },
      {
        table: "TransactionImportRecord",
        match: { statementRowId: "id" },
        selection: { key: "sourceTransactionRecord" },
      },
      {
        table: "EntityExternalId",
        match: { entityId: "id" },
        where: { kind: "settlement_ref" },
        selection: { key: "financialTransaction" },
      },
      {
        table: "EntityExternalId",
        match: { externalId: "id" },
        where: { kind: "settlement_ref" },
        captureKey: "textHash",
        selection: { key: assessmentReadScopedSourceKind.enum.statementRef },
      },
      {
        table: "FinancialTransactionAllocation",
        match: { transactionId: "id" },
        selection: { key: "financialTransaction" },
      },
      {
        table: "Expense",
        match: { purchaseId: "id" },
        selection: {
          key: "financialTransaction",
          path: [
            {
              table: "FinancialTransactionAllocation",
              from: "purchaseId",
              to: "transactionId",
            },
          ],
        },
      },
      {
        table: "Purchase",
        match: { id: "id" },
        selection: {
          key: "financialTransaction",
          path: [
            {
              table: "FinancialTransactionAllocation",
              from: "purchaseId",
              to: "transactionId",
            },
          ],
        },
      },
      {
        table: "FinancialAccount",
        match: { id: "id" },
        selection: { key: "transferPolicy" },
      },
      {
        table: "LedgerParty",
        match: { id: "id" },
        selection: { key: "transferPolicy" },
      },
      {
        table: "EntityExternalId",
        match: { entityId: "id" },
        where: { kind: "settlement_ref" },
        selection: { key: "transferPolicy" },
      },
      {
        table: "Expense",
        match: { id: "id" },
        columns: ["bookingTransactionCode", "deletedAt"],
        selection: { key: "transferPolicy" },
      },
      // Stock evidence includes every sibling placement, not only the
      // proposal's source row. Capture old and new Product group identities.
      {
        table: "InventoryEntry",
        match: { productId: "id" },
        selection: {
          key: "inventory",
          path: [{ table: "InventoryEntry", from: "productId", to: "id" }],
        },
      },
      {
        table: "Location",
        match: { id: "id" },
        selection: {
          key: "inventory",
          path: [
            { table: "InventoryEntry", from: "locationId", to: "productId" },
            { table: "InventoryEntry", from: "productId", to: "id" },
          ],
        },
      },
      {
        table: "Expense",
        match: { purchaseId: "id" },
        selection: { key: "purchase" },
      },
      {
        table: "EntityLink",
        match: { fromEntityId: "id" },
        where: { kind: "purchaseProduct" },
        selection: { key: "purchase" },
      },
      {
        table: "FinancialAccount",
        match: { id: "id" },
        selection: {
          key: "financialTransaction",
          path: [
            { table: "FinancialTransaction", from: "accountId", to: "id" },
          ],
        },
      },
      {
        table: "LedgerParty",
        match: { id: "id" },
        selection: {
          key: "financialTransaction",
          path: [
            { table: "FinancialAccount", from: "ledgerPartyId", to: "id" },
            { table: "FinancialTransaction", from: "accountId", to: "id" },
          ],
        },
      },
      {
        table: "Vendor",
        match: { id: "id" },
        selection: {
          key: "purchase",
          path: [{ table: "Purchase", from: "vendorId", to: "id" }],
        },
      },
      {
        table: "VendorAccount",
        match: { id: "id" },
        selection: {
          key: "purchase",
          path: [{ table: "Purchase", from: "vendorAccountId", to: "id" }],
        },
      },
      {
        table: "EntityLink",
        match: { fromEntityId: "id" },
        where: { kind: "purchasePaymentAccount" },
        selection: { key: "purchase" },
      },
      {
        table: "FinancialAccount",
        match: { id: "id" },
        selection: {
          key: "purchase",
          path: [
            {
              table: "EntityLink",
              from: "toEntityId",
              to: "fromEntityId",
              where: { kind: "purchasePaymentAccount" },
            },
          ],
        },
      },
      // Explicit positions exclude the retired Claim/Order captures at 7/8.
      // A future Email input appends here instead of shifting later tickets.
      ...emailAssessmentInputs([0, 1, 2, 3, 4, 5, 6, 9, 10, 11]),
      // Conflict policy also reads dated/authorized people, not just owners.
      {
        table: "LedgerParty",
        match: { id: "id" },
        selection: { key: "settlementPolicy" },
      },
      {
        table: "AssessmentState",
        match: { recordId: "id" },
        where: {
          family: assessmentFamily.enum.field,
          entity: "financialAccount",
        },
        selection: {
          key: "financialTransaction",
          path: [
            { table: "FinancialTransaction", from: "accountId", to: "id" },
          ],
        },
      },
      {
        table: "PurchasePaymentEvidence",
        match: { purchaseId: "id" },
        selection: { key: "purchase" },
      },
      // A new card match can change a Purchase's tender without a prior FK
      // to that account, including an account with no recorded transactions.
      {
        table: "FinancialAccount",
        match: { id: "id" },
        columns: [
          "identity",
          "providerVendorId",
          "ledgerPartyId",
          "cardNumbers",
          "deletedAt",
          "primaryCardholderId",
          "fundingPeriods",
          "authorizedUsers",
        ],
        selection: { key: "settlementPolicy" },
      },
      // These rosters can gain rows absent from every retained dependency.
      // Capture the relation itself rather than relying on an existing edge.
      {
        table: "EntityLink",
        match: { fromEntityId: "id" },
        where: { kind: "projectTool" },
        selection: { key: "projectTools" },
      },
      {
        table: "ExpenseAttribution",
        match: { expenseId: "id" },
        selection: { key: "projectRoster" },
        // Retired before cutover: attribution is not an input of this roster.
        capture: false,
      },
      // Neither row's family alone owns the six-family review population.
      // Keep earlier positions readable for tickets captured before cutover.
      {
        table: "Assessment",
        match: { id: "id" },
        columns: ["served"],
        selection: { key: "assessment" },
      },
      {
        table: "AssessmentState",
        match: { id: "id" },
        selection: { key: "assessment" },
      },
      // Shared history/windows exclude incidental source fields. Ordinary
      // notes/model edits still enroll their own advice through direct inputs.
      {
        table: "Expense",
        match: { id: "id" },
        columns: [
          "name",
          "shortcode",
          "date",
          "projectId",
          "purchaseId",
          "productId",
          "lineKind",
          "trade",
          "deletedAt",
          "cost",
        ],
        selection: { key: "projectRoster" },
      },
      {
        table: "Purchase",
        match: { id: "id" },
        columns: ["defaultProjectId", "defaultTrade", "deletedAt"],
        selection: { key: "projectRoster" },
      },
      {
        table: "Project",
        match: { id: "id" },
        columns: [
          "name",
          "emoji",
          "shortcode",
          "parentProjectId",
          "startDate",
          "endDate",
          "deletedAt",
          "defaultTrade",
        ],
        selection: { key: "projectRoster" },
      },
      {
        table: "Task",
        match: { id: "id" },
        columns: [
          "dueDate",
          "dueEndDate",
          "projectId",
          "projectMode",
          "parentTaskId",
          "deletedAt",
        ],
        selection: { key: "projectRoster" },
      },
      {
        table: "Product",
        match: { id: "id" },
        columns: ["categoryId", "deletedAt"],
        selection: { key: "projectRoster" },
      },
      {
        table: "ProductCategory",
        match: { id: "id" },
        columns: ["feature", "parentId", "deletedAt"],
        selection: { key: "projectRoster" },
      },
      {
        table: "Product",
        match: { id: "id" },
        columns: ["kind"],
        selection: {
          key: "expense",
          path: [{ table: "Expense", from: "productId", to: "id" }],
        },
      },
      {
        table: "Purchase",
        match: { id: "id" },
        selection: {
          key: "expense",
          path: [{ table: "Expense", from: "purchaseId", to: "id" }],
        },
      },
      // Expense source context retains category-resolution evidence, including
      // mapping names and blocks from the canonical three-parent walk.
      ...[0, 1, 2, 3].map((depth) => ({
        table: "ProductCategory",
        match: { id: "id" },
        selection: {
          key: "expense",
          path: [
            ...Array.from({ length: depth }, () => ({
              table: "ProductCategory",
              from: "parentId",
              to: "id",
            })),
            { table: "Product", from: "categoryId", to: "id" },
            { table: "Expense", from: "productId", to: "id" },
          ],
        },
      })),
      {
        table: "Vendor",
        match: { id: "id" },
        selection: {
          key: "expense",
          path: [
            { table: "Purchase", from: "vendorId", to: "id" },
            { table: "Expense", from: "purchaseId", to: "id" },
          ],
        },
      },
      {
        table: "SpendingCategory",
        match: { id: "id" },
        selection: {
          key: "expense",
          path: [{ table: "Expense", from: "spendingCategoryId", to: "id" }],
        },
      },
      {
        table: "SpendingCategory",
        match: { id: "id" },
        selection: {
          key: "expense",
          path: [
            { table: "Purchase", from: "spendingCategoryId", to: "id" },
            { table: "Expense", from: "purchaseId", to: "id" },
          ],
        },
      },
      {
        table: "SpendingCategory",
        match: { id: "id" },
        selection: {
          key: "expense",
          path: [
            { table: "Vendor", from: "defaultSpendingCategoryId", to: "id" },
            { table: "Purchase", from: "vendorId", to: "id" },
            { table: "Expense", from: "purchaseId", to: "id" },
          ],
        },
      },
      ...[0, 1, 2, 3].map((depth) => ({
        table: "SpendingCategory",
        match: { id: "id" },
        selection: {
          key: "expense",
          path: [
            { table: "ProductCategory", from: "spendingCategoryId", to: "id" },
            ...Array.from({ length: depth }, () => ({
              table: "ProductCategory",
              from: "parentId",
              to: "id",
            })),
            { table: "Product", from: "categoryId", to: "id" },
            { table: "Expense", from: "productId", to: "id" },
          ],
        },
      })),
    ],
  },
];

const onePair = (match: Record<string, string>): [string, string] => {
  const entries = Object.entries(match);
  const [pair] = entries;
  if (entries.length !== 1 || !pair)
    throw new Error("A derived match pairs exactly one column");
  return pair;
};

const sortTypeOf = (type: string | undefined): DerivedSortType =>
  type === "number"
    ? "number"
    : type === "date"
      ? "date"
      : type
        ? "text"
        : null;

const declaredInput = (
  input: z.output<typeof storedInput> | z.output<typeof internalInput>,
): DerivedInput => {
  const [tableColumn, entityColumn] = onePair(input.match);
  return {
    table: input.table,
    tableColumn,
    entityColumn,
    ...("captureKey" in input && input.captureKey
      ? { captureKey: input.captureKey }
      : {}),
    ...(input.capture === false ? { capture: false as const } : {}),
    columns: input.columns ?? null,
    where: input.where ?? null,
    except: input.except ?? [],
    path: input.path ?? null,
    ...(input.paths ? { paths: input.paths } : {}),
    targetWhere: input.targetWhere ?? null,
    ...(input.selection ? { selection: input.selection } : {}),
    json: input.json ?? null,
  };
};

const declaredDependency = (
  dependency: z.output<typeof storedDependency>,
): DerivedDependency => {
  if ("targetWhere" in dependency)
    return {
      entity: dependency.entity,
      key: dependency.key,
      targetWhere: dependency.targetWhere,
    };
  if ("path" in dependency)
    return {
      entity: dependency.entity,
      key: dependency.key,
      path: dependency.path,
    };
  if ("through" in dependency)
    return {
      entity: dependency.entity,
      key: dependency.key,
      through: {
        ...dependency.through,
        where: dependency.through.where ?? null,
      },
    };
  const [sourceColumn, entityColumn] = onePair(dependency.match);
  return {
    entity: dependency.entity,
    key: dependency.key,
    sourceColumn,
    entityColumn,
  };
};

const manifestDeclarations = (): EntityStoredDerivedDeclaration[] =>
  z
    .array(storedEntry)
    .parse(storedDerivedManifest)
    .flatMap((entry) => {
      if (!entry.table) return [];
      return [
        {
          kind: "entity",
          entity: entry.entity,
          key: entry.key,
          notifications: "entityRefs",
          target: `${entry.entity}.${entry.key}`,
          table: entry.table,
          compute: entry.stored.compute,
          clock: entry.stored.clock ?? null,
          publishes: entry.publishes,
          recordSource: entry.stored.recordSource ?? null,
          snapshotSource: entry.stored.snapshotSource,
          sort: sortTypeOf(entry.type),
          inputs: entry.stored.inputs.map(declaredInput),
          dependsOn: (entry.stored.dependsOn ?? []).map(declaredDependency),
        } satisfies EntityStoredDerivedDeclaration,
      ];
    });

const internalRecordDeclarations = (): InternalStoredDerivedDeclaration[] => {
  const specs = z.array(internalRecordSpec).parse(internalRecordSpecs);
  const targets = specs.map((spec) => spec.target);
  if (new Set(targets).size !== targets.length)
    throw new Error("Internal derived record targets must be unique");
  return specs.map((spec): InternalStoredDerivedDeclaration => ({
    kind: "internalRecord",
    label: spec.label,
    publishes: "ownTable",
    notifications: spec.notifications,
    reconcile: spec.reconcile ?? null,
    target: spec.target,
    table: spec.table,
    compute: spec.compute,
    inputs: spec.inputs.map(declaredInput),
    dependsOn: (spec.dependsOn ?? []).map(declaredDependency),
  }));
};

let cached: readonly StoredDerivedDeclaration[] | null = null;

export function storedDerivedDeclarations(): readonly StoredDerivedDeclaration[] {
  cached ??= [...manifestDeclarations(), ...internalRecordDeclarations()];
  return cached;
}

/** The public metadata roster: internal records never appear in entity reads. */
export function entityStoredDerivedDeclarations(): readonly EntityStoredDerivedDeclaration[] {
  return storedDerivedDeclarations().filter(
    (entry): entry is EntityStoredDerivedDeclaration => entry.kind === "entity",
  );
}

export function storedDerived(
  entity: Entity,
  key: string,
): EntityStoredDerivedDeclaration | null {
  return (
    entityStoredDerivedDeclarations().find(
      (entry) => entry.entity === entity && entry.key === key,
    ) ?? null
  );
}

function storedDerivedByTarget(
  target: string,
): StoredDerivedDeclaration | null {
  return (
    storedDerivedDeclarations().find((entry) => entry.target === target) ?? null
  );
}

/** Whether a changed input row marks records directly or through the drain. */
export const isFanoutInput = (input: DerivedInput) =>
  input.entityColumn !== "id" ||
  input.selection !== undefined ||
  input.path !== null ||
  input.paths !== undefined ||
  input.json !== null ||
  input.targetWhere !== null;

/** A fanout mark names its input: `<entity>.<key>@<input index>`. */
export const fanoutTarget = (target: string, inputIndex: number) =>
  `${target}@${inputIndex}`;

export function parseTarget(target: string): {
  declaration: StoredDerivedDeclaration;
  fanoutInput: DerivedInput | null;
} | null {
  const [base, index] = target.split("@");
  const declaration = base ? storedDerivedByTarget(base) : null;
  if (!declaration) return null;
  if (index === undefined) return { declaration, fanoutInput: null };
  const input = declaration.inputs[Number(index)];
  // A retired input's pending fanout has nothing left to expand.
  return input && isFanoutInput(input)
    ? { declaration, fanoutInput: input }
    : null;
}

/** Declarations that read `entity.key`, for propagation after it changes. */
export function dependentsOf(
  entity: Entity,
  key: string,
): readonly {
  declaration: StoredDerivedDeclaration;
  dependency: DerivedDependency;
}[] {
  return storedDerivedDeclarations().flatMap((declaration) =>
    declaration.dependsOn
      .filter(
        (dependency) => dependency.entity === entity && dependency.key === key,
      )
      .map((dependency) => ({ declaration, dependency })),
  );
}
