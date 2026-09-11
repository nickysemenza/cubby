import type { generatedEntityEditIntents } from "@cubby/schemas/entity-edit-intents";
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
  LedgerPartyCreateInput,
  LedgerPartyUpdateData,
} from "@cubby/schemas/ledger-party";
import type {
  LedgerTransferCreateInput,
  LedgerTransferUpdateData,
} from "@cubby/schemas/ledger-transfer";
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

import type { EntityMutationOutputByEntity } from "../generated/entity-mutation-results.gen";

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
  ledgerParty: Partial<LedgerPartyCreateInput & LedgerPartyUpdateData>;
  ledgerTransfer: Partial<LedgerTransferCreateInput & LedgerTransferUpdateData>;
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

type GeneratedIntents = typeof generatedEntityEditIntents;
/** Intent names per operation, from the entity declarations. */
type EntityEditIntentCatalog = {
  [E in keyof GeneratedIntents]: {
    create: GeneratedIntents[E]["create"][number];
    update: GeneratedIntents[E]["update"][number];
    delete: "delete";
  };
};

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
  ledgerParty: LedgerPartyCreateInput;
  ledgerTransfer: LedgerTransferCreateInput;
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
  ledgerParty: LedgerPartyUpdateData;
  ledgerTransfer: LedgerTransferUpdateData;
  wish: WishUpdateData;
}

type EntityEditSpecification<E extends keyof EntityEditIntentCatalog> = {
  record: { id: string } & EntityEditDraftMap[E];
  draft: EntityEditDraftMap[E];
  createInput: EntityEditCreateInputMap[E];
  updateInput: EntityEditUpdateInputMap[E];
  result: EntityMutationOutputByEntity[E];
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
export type EntityEditCreateInput<E extends TypedEditableEntity> =
  EntityEditSpecification<E>["createInput"];
export type EntityEditUpdateInput<E extends TypedEditableEntity> =
  EntityEditSpecification<E>["updateInput"];
export type EntityEditRecordFor<E extends TypedEditableEntity> = {
  [
    K in keyof EntityEditSpecification<E>["record"]
  ]: EntityEditSpecification<E>["record"][K];
};
/** Exact public output returned by this entity's generated mutation schema. */
export type EntityEditResultFor<E extends TypedEditableEntity> =
  EntityEditSpecification<E>["result"];
