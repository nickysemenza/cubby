import { compactLiteral } from "../../artifacts.ts";
import { z } from "zod";
import type {
  CompiledEntity,
  DeclarationValue,
  EntityStorageField,
} from "../declarations.ts";

export const identifierTypeNames = {
  spendingCategory: "SpendingCategoryId",
  cookbook: "CookbookId",
  device: "DeviceId",
  plant: "PlantId",
  expense: "ExpenseId",
  financialAccount: "FinancialAccountId",
  financialTransaction: "FinancialTransactionId",
  ingredient: "IngredientId",
  inventory: "InventoryId",
  ledgerParty: "LedgerPartyId",
  ledgerTransfer: "LedgerTransferId",
  location: "LocationId",
  meal: "MealId",
  product: "ProductId",
  productCategory: "ProductCategoryId",
  project: "ProjectId",
  purchase: "PurchaseId",
  run: "RunId",
  recipe: "RecipeId",
  task: "TaskId",
  vendor: "VendorId",
  vendorAccount: "VendorAccountId",
  wish: "WishId",
} as const satisfies Readonly<Record<string, string>>;

const storageJsonTypes = {
  "cookbook.rawJson": "CookbookExtraction",
  "cookbook.report": "CookbookRunReport | null",
  "financialAccount.cardNumbers": "FinancialAccountCardNumber[]",
  "financialAccount.identity": "FinancialAccountIdentity",
  "financialAccount.sourceAliases": "FinancialAccountSourceAlias[]",
  "ingredient.naKinds": "IngredientApplicabilityKey[]",
  "image.sourceFingerprint": "ImageSourceFingerprint | null",
  "image.captureLocation": "ImageCaptureLocation | null",
  "image.provenanceEvidence": "ImageProvenanceEvidence | null",
  "image.embeddedMetadata": "StoredImageEmbeddedMetadata | null",
  "location.valuation": "LocationValuation | null",
  "product.labelNutrition": "ProductLabelNutrition | null",
  "recipe.meta": "RecipeStoredMeta | null",
  "recipe.totals": "StoredRecipeTotals | null",
  "recipe.yield": "RecipeYield",
} as const satisfies Readonly<Record<string, string>>;

const lookupGeneratedType = (
  values: Readonly<Record<string, string>>,
  key: string,
): string | undefined => values[key];

const enumColumnExpression = (
  entity: CompiledEntity,
  field: EntityStorageField,
): string | null => {
  const column = JSON.stringify(field.column);
  const key = `${entity.key}.${field.key}`;
  const expressions = {
    "expense.economicRole": `text(${column},{enum:["vendor", "reimbursement"]})`,
    "product.acquisitionOrigin": `text(${column},{enum:["unknown", "purchased", "gift", "previously_owned"]})`,
    "product.kind": `text(${column},{enum:productKindValues})`,
    "spendingCategory.itemizationExpectation": `text(${column},{enum:["unknown", "required", "not_expected"]})`,
    "vendor.itemizationExpectation": `text(${column},{enum:["unknown", "required", "not_expected"]})`,
    "purchase.itemizationExpectation": `text(${column},{enum:["unknown", "required", "not_expected"]})`,
    "financialTransaction.itemizationExpectation": `text(${column},{enum:["unknown", "required", "not_expected"]})`,
    "spendingCategory.productExpectation": `text(${column},{enum:["unknown", "required", "not_expected", "not_allowed"]})`,

    "expense.costType": `text(${column},{enum:costTypeValues})`,
    "expense.lineBasis": `text(${column},{enum:expenseLineBasisValues})`,
    "expense.lineKind": `text(${column},{enum:expenseLineKindValues})`,
    "expense.trade": `text(${column},{enum:tradeValues})`,
    "image.renderStatus": `text(${column},{enum:imageRenderStatusValues})`,
    "image.status": `text(${column},{enum:imageStatusValues})`,
    "imageJob.kind": `text(${column},{enum:["subject_lift", "describe_image", "identify_image"]})`,
    "imageJob.state": `text(${column},{enum:["pending", "waiting_for_device", "leased", "ready", "skipped", "failed"]})`,
    "image.storageStatus": `text(${column},{enum:imageStorageStatusValues})`,
    "inventory.placement": `text(${column},{enum:inventoryPlacementValues})`,
    "meal.mealKind": `text(${column},{enum:mealKindValues})`,
    "meal.mealType": `text(${column},{enum:mealTypeValues})`,
    "inventory.ownershipMode": `text(${column},{enum:inventoryOwnershipModeValues})`,
    "project.defaultTrade": `text(${column},{enum:tradeValues})`,
    "purchase.defaultTrade": `text(${column},{enum:tradeValues})`,
    "productCategory.feature": `text(${column},{enum:productCategoryFeatureValues})`,
    "image.source": `text(${column},{enum:["own", "catalog", "unknown", "screenshot"]})`,
    "image.captureAttribution": `text(${column},{enum:["none","derived","ambiguous","confirmed"]})`,
    "project.kind": `text(${column},{enum:projectKindValues})`,
    "project.status": `text(${column},{enum:projectStatusValues})`,
    "recipe.sourceType": `text(${column},{enum:recipeSourceValues})`,
    "task.status": `text(${column},{enum:taskStatusValues})`,
    "task.trade": `text(${column},{enum:tradeValues})`,
  } as const satisfies Readonly<Record<string, string>>;
  const existing = lookupGeneratedType(expressions, key);
  if (existing) return existing;
  if (field.specialized !== "enum:inheritance-mode") return null;
  const validation = entity.fieldModel.fields.find(
    ({ key }) => key === field.key,
  )?.validation;
  let schema: z.core.$ZodType | null | undefined =
    validation?.read ?? validation?.create ?? validation?.update;
  while (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault
  )
    schema = schema.unwrap();
  return schema instanceof z.ZodEnum
    ? `text(${column},{enum:${compactLiteral(schema.options)}})`
    : null;
};

const literalDefaultExpression = (value: DeclarationValue): string => {
  if (typeof value === "string") {
    if (value === "'{}'::text[]") return "sql`'{}'::text[]`";
    if (value === "'[]'::jsonb") return "[]";
    const jsonbLiteral = /^'(.*)'::jsonb$/su.exec(value);
    if (jsonbLiteral) {
      JSON.parse(jsonbLiteral[1]!.replaceAll("''", "'"));
      return `sql\`${value}\``;
    }
    if (value.startsWith("'") && value.endsWith("'"))
      return JSON.stringify(value.slice(1, -1));
  }
  return compactLiteral(value);
};

/**
 * One model storage column as a Drizzle column builder. `reference` renders
 * the FK target thunk for a referenced entity key.
 */
export const renderStorageColumn = (
  entity: CompiledEntity,
  field: EntityStorageField,
  reference: (entity: string) => string,
): string => {
  const column = JSON.stringify(field.column);
  if (field.specialized === "amount-columns") {
    // One `{ value, unit }` model field stored as `<column>Value` +
    // `<column>Unit` (the shape `amountFromColumns`/`amountToColumns` in
    // `server/db/helpers` convert). The pair is atomic: both set or
    // both null, and a live unit is never blank.
    const valueColumn = JSON.stringify(`${field.column}Value`);
    const unitColumn = JSON.stringify(`${field.column}Unit`);
    const notNull = field.nullable ? "" : ".notNull()";
    return `${JSON.stringify(`${field.key}Value`)}:doublePrecision(${valueColumn})${notNull},${JSON.stringify(`${field.key}Unit`)}:text(${unitColumn})${notNull}`;
  }
  const ownIdType = lookupGeneratedType(identifierTypeNames, entity.key);
  const referenceIdType =
    field.reference === null
      ? null
      : lookupGeneratedType(identifierTypeNames, field.reference);
  let expression: string;
  if (field.key === "id") {
    expression =
      ownIdType === undefined
        ? `uuid(${column}).primaryKey().default(sql\`gen_random_uuid()\`)`
        : `uuid(${column}).primaryKey().default(sql\`gen_random_uuid()\`).$type<${ownIdType}>()`;
  } else if (field.key === "shortcode") {
    // The public id (`PRD-4K7M`). Deliberately NOT branded: generic Drizzle
    // table unions erase the entity correlation on inserts and comparisons,
    // so repository mappers validate it through per-entity shortcode schemas.
    expression = `text(${column}).notNull()`;
  } else if (field.kind === "identifier") {
    expression = `uuid(${column})`;
    if (referenceIdType !== undefined && referenceIdType !== null)
      expression += `.$type<${referenceIdType}>()`;
  } else if (field.kind === "text-array") {
    expression = `text(${column}).array()`;
    if (entity.key === "ingredient" && field.key === "naKinds")
      expression += ".$type<IngredientApplicabilityKey[]>()";
  } else if (field.kind === "text") {
    expression = `text(${column})`;
  } else if (field.kind === "number") {
    expression =
      field.specialized === "real"
        ? `real(${column})`
        : field.specialized === "double-precision"
          ? `doublePrecision(${column})`
          : `integer(${column})`;
  } else if (field.kind === "boolean") {
    expression = `boolean(${column})`;
  } else if (field.kind === "date") {
    expression = `date(${column},{mode:"string"})`;
  } else if (field.kind === "timestamp") {
    expression = `timestamp(${column},{mode:"date"})`;
  } else if (field.kind === "json") {
    expression = `jsonb(${column})`;
    const jsonType = lookupGeneratedType(
      storageJsonTypes,
      `${entity.key}.${field.key}`,
    );
    if (jsonType !== undefined) expression += `.$type<${jsonType}>()`;
  } else {
    expression = enumColumnExpression(entity, field) ?? `text(${column})`;
    if (entity.key === "ledgerParty" && field.key === "kind")
      expression += ".$type<LedgerPartyKind>()";
  }
  if (
    field.key !== "id" &&
    field.key !== "shortcode" &&
    field.nullable === false
  )
    expression += ".notNull()";
  if (field.default === "now") expression += ".defaultNow()";
  if (field.default === "literal")
    expression += `.default(${literalDefaultExpression(field.defaultValue)})`;
  if (field.specialized === "updated-at")
    expression += ".$onUpdate(() => new Date())";
  if (field.reference !== null)
    expression += `.references(${reference(field.reference)})`;
  return `${JSON.stringify(field.key)}:${expression}`;
};

/** The type and value-array imports the column builders above reference. */
export const storageColumnImports =
  'import type { FinancialAccountCardNumber, FinancialAccountIdentity, FinancialAccountSourceAlias } from "@cubby/schemas/financial-account";\n' +
  `import type { ${Object.values(identifierTypeNames).sort().join(", ")} } from "@cubby/schemas/identifiers";\n` +
  'import { imageRenderStatusValues, imageStatusValues, imageStorageStatusValues } from "@cubby/schemas/image";\n' +
  'import type { ImageSourceFingerprint, StoredImageEmbeddedMetadata } from "@cubby/schemas/image";\n' +
  'import type { ImageCaptureLocation, ImageProvenanceEvidence } from "@cubby/schemas/image-capture-fields";\n' +
  'import type { CookbookExtraction, CookbookRunReport } from "@cubby/schemas/cookbook";\n' +
  'import type { LedgerPartyKind } from "@cubby/schemas/ledger-party";\n' +
  'import { mealKindValues, mealTypeValues } from "@cubby/schemas/meal-classification";\n' +
  'import type { IngredientApplicabilityKey } from "@cubby/schemas/codec";\n' +
  'import { productCategoryFeatureValues } from "@cubby/schemas/product-category-fields";\n' +
  'import { productKindValues } from "@cubby/schemas/product-fields";\n' +
  'import { costTypeValues, projectKindValues, projectStatusValues, taskStatusValues, tradeValues } from "@cubby/schemas/project";\n' +
  'import { expenseLineBasisValues, expenseLineKindValues } from "@cubby/schemas/expense-line-kind";\n' +
  'import type { ProductLabelNutrition } from "@cubby/schemas/nutrition";\n' +
  'import type { RecipeStoredMeta, RecipeYield, StoredRecipeTotals } from "@cubby/schemas/recipe-shared";\n' +
  'import { recipeSourceValues } from "@cubby/schemas/recipe-shared";\n' +
  'import { inventoryOwnershipModeValues } from "@cubby/schemas/inventory-ownership";\n' +
  'import { inventoryPlacementValues } from "@cubby/shared";\n';
