import type {
  FinancialAccountCreateInput,
  FinancialAccountUpdateData,
} from "@cubby/schemas/financial-account";
import type {
  FinancialTransactionCreateInput,
  FinancialTransactionUpdateData,
} from "@cubby/schemas/financial-transaction";
import type {
  IngredientCreateInput,
  IngredientUpdateInput,
} from "@cubby/schemas/ingredient";
import type {
  InventoryUpdateInput,
  inventoryCreatePayloadData,
} from "@cubby/schemas/inventory";
import type {
  LocationCreateInput,
  LocationUpdateInput,
} from "@cubby/schemas/location";
import type { MealCreateInput, MealUpdateInput } from "@cubby/schemas/meal";
import type {
  ProductCreateInput,
  ProductUpdateInput,
} from "@cubby/schemas/product";
import type {
  ExpenseCreateInput,
  ExpenseUpdateData,
  ProjectCreateInput,
  ProjectUpdateData,
  TaskCreateInput,
  TaskUpdateData,
} from "@cubby/schemas/project";
import type {
  PurchaseCreateInput,
  PurchaseUpdateData,
} from "@cubby/schemas/purchase";
import type {
  RecipeCreateInput,
  RecipeUpdateInput,
} from "@cubby/schemas/recipe";
import type {
  VendorCreateInput,
  VendorUpdateInput,
} from "@cubby/schemas/vendor";
import type { WishCreateInput, WishUpdateData } from "@cubby/schemas/wish";
import type { z } from "zod";

type UpdateData<T> = T extends { data: infer D } ? D : never;

type FinancialAccountEditorFields = {
  kind: "credit_card" | "bank_account" | "stored_value" | "cash" | "other";
  issuer: string;
  network: "" | "visa" | "mastercard" | "amex" | "discover" | "other";
  institution: string;
  accountType: "checking" | "savings" | "money_market" | "other";
  provider: string;
  last4: string;
};

/** Draft keys and values exposed to RHF callers. Intents select subsets at
 * runtime; callers can no longer invent field names or incompatible values. */
interface EntityEditDraftMap {
  product: Partial<ProductCreateInput & UpdateData<ProductUpdateInput>>;
  ingredient: Partial<
    IngredientCreateInput & UpdateData<IngredientUpdateInput>
  >;
  inventory: Partial<
    z.infer<typeof inventoryCreatePayloadData> &
      UpdateData<InventoryUpdateInput>
  >;
  location: Partial<LocationCreateInput & UpdateData<LocationUpdateInput>>;
  recipe: Partial<RecipeCreateInput & UpdateData<RecipeUpdateInput>>;
  meal: Partial<MealCreateInput & UpdateData<MealUpdateInput>>;
  project: Partial<ProjectCreateInput & ProjectUpdateData>;
  task: Partial<TaskCreateInput & TaskUpdateData>;
  expense: Partial<ExpenseCreateInput & ExpenseUpdateData> & {
    lineKind?: ExpenseCreateInput["lineKind"] | "auto";
  };
  vendor: Partial<VendorCreateInput & UpdateData<VendorUpdateInput>>;
  purchase: Partial<PurchaseCreateInput & PurchaseUpdateData>;
  financialAccount: Partial<
    FinancialAccountCreateInput &
      FinancialAccountUpdateData &
      FinancialAccountEditorFields
  >;
  financialTransaction: Partial<
    FinancialTransactionCreateInput & FinancialTransactionUpdateData
  >;
  wish: Partial<WishCreateInput & WishUpdateData>;
}

interface EntityEditIntentCatalog {
  product: {
    create: "capture" | "full";
    update: "full" | "identity" | "price" | "stock";
    delete: "delete";
  };
  ingredient: {
    create: "capture" | "full";
    update: "full" | "identity";
    delete: "delete";
  };
  inventory: {
    create: "capture" | "full";
    update: "full" | "amount" | "product" | "location" | "placement";
    delete: "delete";
  };
  location: {
    create: "capture" | "full";
    update: "full" | "identity" | "parent";
    delete: "delete";
  };
  recipe: {
    create: "capture" | "full";
    update: "full" | "identity";
    delete: "delete";
  };
  meal: {
    create: "capture" | "full";
    update: "full" | "calendar";
    delete: "delete";
  };
  project: {
    create: "capture" | "full";
    update: "full" | "status" | "kind" | "dates" | "parent";
    delete: "delete";
  };
  task: {
    create: "capture" | "full";
    update: "full" | "schedule" | "status" | "project" | "subject";
    delete: "delete";
  };
  expense: {
    create: "capture" | "full";
    update: "full" | "planned" | "cost" | "date" | "project" | "product";
    delete: "delete";
  };
  vendor: {
    create: "capture" | "full";
    update: "full" | "identity";
    delete: "delete";
  };
  purchase: {
    create: "capture" | "full";
    update: "full" | "vendor" | "identity";
    delete: "delete";
  };
  financialAccount: {
    create: "capture" | "full";
    update: "full" | "identity";
    delete: "delete";
  };
  financialTransaction: {
    create: "capture" | "full";
    update: "full" | "settlement";
    delete: "delete";
  };
  wish: {
    create: "capture" | "full";
    update: "full" | "identity" | "acquisition";
    delete: "delete";
  };
}

interface EntityEditCreateInputMap {
  product: ProductCreateInput;
  ingredient: IngredientCreateInput;
  inventory: z.infer<typeof inventoryCreatePayloadData>;
  location: LocationCreateInput;
  recipe: RecipeCreateInput;
  meal: MealCreateInput;
  project: ProjectCreateInput;
  task: TaskCreateInput;
  expense: ExpenseCreateInput;
  vendor: VendorCreateInput;
  purchase: PurchaseCreateInput;
  financialAccount: FinancialAccountCreateInput;
  financialTransaction: FinancialTransactionCreateInput;
  wish: WishCreateInput;
}

interface EntityEditUpdateInputMap {
  product: UpdateData<ProductUpdateInput>;
  ingredient: UpdateData<IngredientUpdateInput>;
  inventory: UpdateData<InventoryUpdateInput>;
  location: UpdateData<LocationUpdateInput>;
  recipe: UpdateData<RecipeUpdateInput>;
  meal: UpdateData<MealUpdateInput>;
  project: ProjectUpdateData;
  task: TaskUpdateData;
  expense: ExpenseUpdateData;
  vendor: UpdateData<VendorUpdateInput>;
  purchase: PurchaseUpdateData;
  financialAccount: FinancialAccountUpdateData;
  financialTransaction: FinancialTransactionUpdateData;
  wish: WishUpdateData;
}

type EntityEditSpecification<E extends keyof EntityEditIntentCatalog> = {
  record: { id: string } & EntityEditDraftMap[E];
  draft: EntityEditDraftMap[E];
  createInput: EntityEditCreateInputMap[E];
  updateInput: EntityEditUpdateInputMap[E];
  result: { id: string } & EntityEditDraftMap[E];
  intents: EntityEditIntentCatalog[E];
};

export type TypedEditableEntity = keyof EntityEditIntentCatalog;
export type TypedEntityEditOperation<E extends TypedEditableEntity> = Extract<
  keyof EntityEditSpecification<E>["intents"],
  "create" | "update" | "delete"
>;
export type EntityEditIntent<
  E extends TypedEditableEntity,
  O extends "create" | "update" | "delete",
> = E extends TypedEditableEntity
  ? O extends keyof EntityEditSpecification<E>["intents"]
    ? EntityEditSpecification<E>["intents"][O]
    : never
  : never;
export type EntityEditDraft<E extends TypedEditableEntity> =
  EntityEditSpecification<E>["draft"];
export type EntityEditRecordFor<E extends TypedEditableEntity> = {
  [
    K in keyof EntityEditSpecification<E>["record"]
  ]: EntityEditSpecification<E>["record"][K];
};
/** Standard CRUD routers return at least identity and may return any subset of
 * the entity's editable fields. Rich callers can narrow their own result. */
export type EntityEditResultFor<E extends TypedEditableEntity> =
  EntityEditSpecification<E>["result"];
