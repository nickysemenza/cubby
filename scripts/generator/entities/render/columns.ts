import { compactLiteral, generatedHeader } from "../../artifacts.ts";
import type {
  CompiledEntity,
  DeclarationValue,
  EntityStorageField,
} from "../declarations.ts";

const entityColumnFunctionName = (entity: string) =>
  `generated${entity[0]?.toUpperCase() ?? ""}${entity.slice(1).replaceAll("-", "")}Columns`;

const identifierTypeNames = {
  cookbook: "CookbookId",
  device: "DeviceId",
  plant: "PlantId",
  expense: "ExpenseId",
  financialAccount: "FinancialAccountId",
  financialTransaction: "FinancialTransactionId",
  imageSighting: "ImageSightingId",
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
  importRun: "ImportRunId",
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
  "financialTransaction.sourceRefs": "FinancialTransactionSourceRef[]",
  "ingredient.naKinds": "BaseKind[]",
  "image.sourceFingerprint": "ImageSourceFingerprint | null",
  "image.captureLocation": "ImageCaptureLocation | null",
  "image.provenanceEvidence": "ImageProvenanceEvidence | null",
  "image.embeddedMetadata": "StoredImageEmbeddedMetadata | null",
  "imageSighting.location": "ImageSightingLocation | null",
  "imageSighting.camera": "ImageSightingCamera | null",
  "inventory.amount": "Amount",
  "location.valuation": "LocationValuation | null",
  "product.dataExceptions": "DataException[]",
  "product.labelNutrition": "ProductLabelNutrition | null",
  "purchase.dataExceptions": "DataException[]",
  "recipe.meta": "RecipeStoredMeta | null",
  "recipe.totals": "StoredRecipeTotals | null",
  "recipe.yield": "RecipeYield",
} as const satisfies Readonly<Record<string, string>>;

const lookupGeneratedType = (
  values: Readonly<Record<string, string>>,
  key: string,
): string | undefined => values[key];

const enumColumnExpression = (
  entity: string,
  field: EntityStorageField,
): string | null => {
  const column = JSON.stringify(field.column);
  const key = `${entity}.${field.key}`;
  const expressions = {
    "expense.costType": `text(${column},{enum:costTypeValues})`,
    "expense.lineBasis": `text(${column},{enum:expenseLineBasisValues})`,
    "expense.lineKind": `text(${column},{enum:expenseLineKindValues})`,
    "expense.trade": `text(${column},{enum:tradeValues})`,
    "image.renderStatus": `imageRenderStatusEnum(${column})`,
    "image.status": `imageStatusEnum(${column})`,
    "image.storageStatus": `imageStorageStatusEnum(${column})`,
    "inventory.placement": `inventoryPlacementEnum(${column})`,
    "meal.mealKind": `text(${column},{enum:mealKindValues})`,
    "meal.mealType": `text(${column},{enum:mealTypeValues})`,
    "inventory.ownershipMode": `text(${column},{enum:inventoryOwnershipModeValues})`,
    "project.defaultTrade": `text(${column},{enum:tradeValues})`,
    "purchase.defaultTrade": `text(${column},{enum:tradeValues})`,
    "project.locationsMode": `text(${column},{enum:["inherit","explicit"]})`,
    "task.projectMode": `text(${column},{enum:["inherit","explicit"]})`,
    "task.subjectProductMode": `text(${column},{enum:["inherit","explicit"]})`,
    "productCategory.feature": `text(${column},{enum:productCategoryFeatureValues})`,
    "image.source": `text(${column},{enum:["own", "catalog", "unknown", "screenshot"]})`,
    "image.captureAttribution": `text(${column},{enum:["none","derived","ambiguous","confirmed"]})`,
    "imageSighting.sourceType": `text(${column},{enum:["userLibrary","cloudShared","iTunesSynced"]})`,
    "imageSighting.matchKind": `text(${column},{enum:["import","libraryMatch"]})`,
    "project.kind": `text(${column},{enum:projectKindValues})`,
    "project.status": `text(${column},{enum:projectStatusValues})`,
    "recipe.SourceType": `recipeSourceEnum(${column})`,
    "task.status": `text(${column},{enum:taskStatusValues})`,
    "task.trade": `text(${column},{enum:tradeValues})`,
  } as const satisfies Readonly<Record<string, string>>;
  return lookupGeneratedType(expressions, key) ?? null;
};

const literalDefaultExpression = (value: DeclarationValue): string => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- String storage defaults have SQL-specific serialization.
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

// oxlint-disable-next-line eslint/complexity -- Ordered branches mirror the finite storage-column DSL.
const renderStorageColumn = (
  entity: CompiledEntity,
  field: EntityStorageField,
): string => {
  const column = JSON.stringify(field.column);
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
    expression = `text(${column}).notNull()`;
  } else if (field.kind === "identifier") {
    expression = `uuid(${column})`;
    if (referenceIdType !== undefined && referenceIdType !== null)
      expression += `.$type<${referenceIdType}>()`;
  } else if (field.kind === "text-array") {
    expression = `text(${column}).array()`;
    if (entity.key === "ingredient" && field.key === "naKinds")
      expression += ".$type<BaseKind[]>()";
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
    expression = enumColumnExpression(entity.key, field) ?? `text(${column})`;
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
    expression += `.references(references[${JSON.stringify(field.reference)}])`;
  return `${JSON.stringify(field.key)}:${expression}`;
};

export const renderEntityColumnsArtifact = (
  entities: readonly CompiledEntity[],
): string => {
  const columnModels = entities.filter(
    (entity) => entity.fieldModel.storage.length > 0,
  );
  const functions = columnModels
    .map((entity) => {
      const references = [
        ...new Set(
          entity.fieldModel.storage.flatMap((field) =>
            field.reference === null ? [] : [field.reference],
          ),
        ),
      ].sort();
      const parameter =
        references.length === 0
          ? ""
          : `references: Readonly<{${references.map((reference) => `${JSON.stringify(reference)}: () => AnyPgColumn`).join(";")}}>`;
      return `export const ${entityColumnFunctionName(entity.key)} = (${parameter}) => ({${entity.fieldModel.storage.map((field) => renderStorageColumn(entity, field)).join(",")}});`;
    })
    .join("\n\n");
  return (
    generatedHeader +
    'import type { Amount } from "@cubby/schemas/codec";\n' +
    'import type { DataException } from "@cubby/schemas/data-quality";\n' +
    'import type { FinancialAccountCardNumber, FinancialAccountIdentity, FinancialAccountSourceAlias } from "@cubby/schemas/financial-account";\n' +
    'import type { FinancialTransactionSourceRef } from "@cubby/schemas/financial-transaction";\n' +
    `import type { ${Object.values(identifierTypeNames).sort().join(", ")} } from "@cubby/schemas/identifiers";\n` +
    'import { imageStatusValues } from "@cubby/schemas/image";\n' +
    'import type { ImageSourceFingerprint, StoredImageEmbeddedMetadata } from "@cubby/schemas/image";\n' +
    'import type { ImageCaptureLocation, ImageProvenanceEvidence } from "@cubby/schemas/image-capture-fields";\n' +
    'import type { ImageSightingCamera, ImageSightingLocation } from "@cubby/schemas/image-sighting-fields";\n' +
    'import type { CookbookExtraction, CookbookRunReport } from "@cubby/schemas/cookbook";\n' +
    'import type { LedgerPartyKind } from "@cubby/schemas/ledger-party";\n' +
    'import { mealKindValues, mealTypeValues } from "@cubby/schemas/meal-classification";\n' +
    'import type { BaseKind } from "@cubby/schemas/problems";\n' +
    'import { productCategoryFeatureValues } from "@cubby/schemas/product-category-fields";\n' +
    'import { costTypeValues, projectKindValues, projectStatusValues, taskStatusValues, tradeValues } from "@cubby/schemas/project";\n' +
    'import { expenseLineBasisValues, expenseLineKindValues } from "@cubby/schemas/expense-line-kind";\n' +
    'import type { ProductLabelNutrition } from "@cubby/schemas/nutrition";\n' +
    'import type { RecipeStoredMeta, RecipeYield, StoredRecipeTotals } from "@cubby/schemas/recipe-shared";\n' +
    'import { recipeSourceValues } from "@cubby/schemas/recipe-shared";\n' +
    'import { inventoryOwnershipModeValues } from "@cubby/schemas/inventory-ownership";\n' +
    'import { inventoryPlacementValues } from "@cubby/shared";\n' +
    'import { sql } from "drizzle-orm";\n' +
    'import { type AnyPgColumn, boolean, date, doublePrecision, integer, jsonb, pgEnum, real, text, timestamp, uuid } from "drizzle-orm/pg-core";\n\n' +
    'export const recipeSourceEnum = pgEnum("RecipeSource", recipeSourceValues);\n' +
    'export const imageStatusEnum = pgEnum("ImageStatus", imageStatusValues);\n' +
    'export const inventoryPlacementEnum = pgEnum("InventoryPlacement", inventoryPlacementValues);\n' +
    'export const imageRenderStatusEnum = pgEnum("ImageRenderStatus", ["unverified", "verified", "failed"]);\n' +
    'export const imageStorageStatusEnum = pgEnum("ImageStorageStatus", ["unverified", "available", "missing", "metadata_mismatch"]);\n\n' +
    functions +
    "\n"
  );
};
